import path from 'node:path'
import {promises as fs} from 'node:fs'
import {randomUUID,randomBytes} from 'node:crypto'
import {DotError,atomicWrite,validId} from './vault.js'

const MODES=new Set(['run','8h','24h'])
const modeOf=value=>{if(!MODES.has(value))throw new DotError('解锁期限无效。');return value}
const canonical=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value)
const failure=e=>({ok:false,error:{code:e instanceof DotError?e.code:'internal',message:e instanceof DotError?e.message:'未能切换 Orivii，请检查数据目录；原有资料没有被覆盖。'}})

// Each identity owns its Vault/Engine. DSH's authenticated owner may resume an
// explicitly unlocked runtime; passwords and decryption keys never enter storage.
export class IdentityManager {
  constructor(root,{create,now=Date.now}){this.root=root;this.create=create;this.now=now;this.runtimes=new Map();this.control=Promise.resolve();this.registryQueue=Promise.resolve();this.closing=false}
  get file(){return this.root.pointer+'.identities.json'}
  async registry(){
    try{
      const data=JSON.parse(await fs.readFile(this.file,'utf8'))
      if(data.version!==1||!Array.isArray(data.items)||data.items.length>16)throw new Error('invalid registry')
      if(data.baseWorkspace!==undefined&&(typeof data.baseWorkspace!=='string'||!path.isAbsolute(data.baseWorkspace)))throw new Error('invalid base')
      for(const entry of data.items){validId(entry.id);if(typeof entry.workspace!=='string'||!path.isAbsolute(entry.workspace)||typeof entry.name!=='string'||entry.name.length>200||typeof entry.encrypted!=='boolean')throw new Error('invalid identity');modeOf(entry.mode)}
      if(new Set(data.items.map(item=>item.id)).size!==data.items.length||new Set(data.items.map(item=>canonical(item.workspace))).size!==data.items.length)throw new Error('duplicate identity')
      return data
    }catch(e){if(e.code==='ENOENT')return {version:1,items:[]};throw new DotError('Orivii 列表无法读取，已有资料保持原样。')}
  }
  updateRegistry(fn){
    const task=this.registryQueue.then(async()=>{
      await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700})
      const lock=this.file+'.lock';let handle
      for(let n=0;n<100;n++){
        try{handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));break}
        catch(e){
          if(e.code!=='EEXIST')throw e
          try{const owner=JSON.parse(await fs.readFile(lock,'utf8'));if(Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0)}catch(error){if(error.code==='ESRCH')await fs.unlink(lock)}}}catch{}
          await new Promise(r=>setTimeout(r,20))
        }
      }
      if(!handle)throw new DotError('Orivii 列表正在更新，请稍后重试。','busy')
      try{const data=await this.registry(),result=await fn(data);await atomicWrite(this.file,JSON.stringify(data));return result}
      finally{await handle.close();await fs.unlink(lock).catch(()=>{})}
    })
    this.registryQueue=task.catch(()=>{});return task
  }
  serialized(fn){const task=this.control.then(fn);this.control=task.catch(()=>{});return task}
  runtime(workspace,create=false){
    const key=canonical(workspace)
    if(!this.runtimes.has(key)&&create){
      const runtime=this.root.identityWorkspace===undefined?this.root:this.create()
      runtime.identityWorkspace=key;this.runtimes.set(key,runtime)
    }
    return this.runtimes.get(key)
  }
  valid(runtime){return Boolean(runtime?.vault&&runtime.access&&(runtime.access.expiresAt===null||this.now()<runtime.access.expiresAt))}
  owner(token){if(typeof token!=='string')return null;return [...this.runtimes.values()].find(runtime=>runtime.allowed(token))||null}
  issue(runtime){
    if(!this.valid(runtime))throw new DotError('请重新输入此 Orivii 的解锁密码。','locked')
    const token=randomBytes(32).toString('hex');runtime.tokens.add(token)
    while(runtime.tokens.size>64)runtime.tokens.delete(runtime.tokens.values().next().value)
    return {token,workspace:runtime.vault.workspace,identityId:runtime.vault.meta.id,session:{mode:runtime.access.mode,expiresAt:runtime.access.expiresAt}}
  }
  schedule(runtime){
    clearTimeout(runtime.accessTimer)
    if(runtime.access&&runtime.access.expiresAt!==null){
      const access=runtime.access
      runtime.accessTimer=setTimeout(()=>this.serialized(async()=>{
        if(runtime.access!==access)return
        if(this.valid(runtime))this.schedule(runtime)
        else await this.closeRuntime(runtime)
      }).catch(()=>{}),Math.max(1,access.expiresAt-this.now()))
      runtime.accessTimer.unref?.()
    }
  }
  async closeRuntime(runtime){clearTimeout(runtime.accessTimer);runtime.access=null;await runtime.disposeLocal();runtime.engine=null}
  async expire(){for(const runtime of this.runtimes.values())if(runtime.vault&&!this.valid(runtime))await this.closeRuntime(runtime)}
  async remember(runtime){
    const state=await runtime.vault.read(),id=runtime.vault.meta.id
    const entry={id,workspace:runtime.vault.workspace,name:state.catalog.settings.name||'Orivii',encrypted:runtime.vault.meta.encrypted,mode:runtime.access.mode}
    await this.updateRegistry(data=>{
      const previous=data.items.findIndex(item=>item.id===id||canonical(item.workspace)===canonical(entry.workspace))
      if(previous<0){if(data.items.length>=16)throw new DotError('最多保留16个 Orivii。');data.items.push(entry)}else data.items[previous]=entry
      data.baseWorkspace??=entry.workspace
    })
  }
  async authenticate(request){
    const workspace=request.workspace||await this.root.location(),data=await this.registry()
    const saved=data.items.find(item=>canonical(item.workspace)===canonical(workspace))
    if(!saved&&data.items.length>=16)throw new DotError('最多保留16个 Orivii。')
    const runtime=this.runtime(workspace,true)
    const mode=modeOf(request.sessionMode||saved?.mode||'run')
    const result=await runtime.commandLocal(request)
    if(!result.ok)return result
    runtime.access={mode,authenticatedAt:this.now(),expiresAt:mode==='run'?null:this.now()+(mode==='8h'?8:24)*3600000}
    this.schedule(runtime)
    try{await this.remember(runtime)}catch(e){await this.closeRuntime(runtime);throw e}
    return {ok:true,value:{...result.value,identityId:runtime.vault.meta.id,session:{mode,expiresAt:runtime.access.expiresAt}}}
  }
  async activate(runtime){await atomicWrite(this.root.pointer,JSON.stringify({workspace:runtime.vault.workspace}));return {ok:true,value:this.issue(runtime)}}
  async list(token){
    const active=this.owner(token),data=await this.registry()
    return {items:data.items.map(({id,name,workspace,encrypted,mode})=>({id,name,workspace,encrypted,mode,unlocked:this.valid(this.runtime(workspace)),active:active?.vault?.meta.id===id})),current:active?.vault?.meta.id||null,session:active?.access?{mode:active.access.mode,expiresAt:active.access.expiresAt}:null}
  }
  async pauseInteractive(runtime){runtime?.clearDeveloper()}
  async manage(request){
    await this.expire()
    if(request.action==='setup'||request.action==='unlock')return this.authenticate(request)
    if(request.action==='resume'){
      const entry=request.identityId?(await this.registry()).items.find(item=>item.id===validId(request.identityId)):null
      if(request.identityId&&!entry)throw new DotError('找不到这个 Orivii。')
      const runtime=this.runtime(entry?.workspace||await this.root.location())
      if(!this.valid(runtime))throw new DotError('请解锁 Orivii。','locked')
      return this.activate(runtime)
    }
    if(request.action==='lock'){
      // An explicit lock always revokes every resident identity, including other tabs.
      await Promise.all([...this.runtimes.values()].map(runtime=>this.closeRuntime(runtime)))
      return {ok:true,value:{locked:true}}
    }
    const current=this.owner(request.token)
    if(!current)throw new DotError('记忆库已锁定，请先解锁。','locked')
    if(request.action==='sessionPolicy'){
      const mode=modeOf(request.mode)
      // Policy edits cannot extend a live deadline without another password unlock.
      current.access.mode=mode
      const deadline=mode==='run'?null:current.access.authenticatedAt+(mode==='8h'?8:24)*3600000
      if(deadline!==null)current.access.expiresAt=current.access.expiresAt===null?deadline:Math.min(current.access.expiresAt,deadline)
      this.schedule(current);await this.remember(current)
      if(!this.valid(current)){await this.closeRuntime(current);throw new DotError('已到验证时间，请重新解锁。','locked')}
      return {ok:true,value:{mode,expiresAt:current.access.expiresAt}}
    }
    if(request.action==='identityCreate'){
      const data=await this.registry()
      if(data.items.length>=16)throw new DotError('最多保留16个 Orivii。')
      if(typeof request.name!=='string'||!request.name.trim()||request.name.length>200)throw new DotError('请填写名字。')
      if(request.persona!==undefined&&(typeof request.persona!=='string'||request.persona.length>2000))throw new DotError('相处方式最多2000字。')
      const base=data.baseWorkspace||current.vault.workspace,workspace=path.join(base,'.orivii-profiles',randomUUID())
      const result=await this.authenticate({action:'setup',workspace,password:request.password,plaintext:request.plaintext,plaintextAcknowledgement:request.plaintextAcknowledgement,settings:{name:request.name.trim(),...(request.persona?.trim()?{persona:request.persona.trim()}:{})},sessionMode:request.sessionMode||current.access.mode})
      if(result.ok)await this.pauseInteractive(current)
      return result
    }
    if(request.action==='identitySwitch'){
      const target=(await this.registry()).items.find(item=>item.id===validId(request.identityId))
      if(!target)throw new DotError('找不到这个 Orivii。')
      const runtime=this.runtime(target.workspace)
      const result=this.valid(runtime)?await this.activate(runtime):await this.authenticate({action:'unlock',workspace:target.workspace,password:request.password,sessionMode:target.mode})
      if(result.ok&&current!==this.runtime(target.workspace))await this.pauseInteractive(current)
      return result
    }
    throw new DotError('不支持此操作。')
  }
  async command(request){
    try{
      if(!request||typeof request!=='object'||Array.isArray(request)||JSON.stringify(request).length>2000000)throw new DotError('请求格式错误或过大。')
      if(this.closing)throw new DotError('Orivii 正在关闭。','locked')
      if(['setup','unlock','resume','lock','identityCreate','identitySwitch','sessionPolicy'].includes(request.action))return await this.serialized(()=>this.manage(request))
      if(request.action==='identities')return {ok:true,value:await this.list(request.token)}
      const runtime=this.owner(request.token)
      if(request.action==='status'||request.action==='webCheck')return (runtime||this.root).commandLocal(request)
      if(!runtime)throw new DotError('记忆库已锁定，请先解锁。','locked')
      const result=await runtime.commandLocal(request)
      if(!runtime.allowed(request.token))throw new DotError('记忆库已锁定，请先解锁。','locked')
      if(result.ok&&request.action==='settings'&&request.settings?.name)await this.serialized(()=>this.remember(runtime))
      return result
    }catch(e){return failure(e)}
  }
  async dispose(){this.closing=true;await this.control;await Promise.all([...new Set([this.root,...this.runtimes.values()])].map(runtime=>this.closeRuntime(runtime)));await this.registryQueue;this.runtimes.clear()}
}
