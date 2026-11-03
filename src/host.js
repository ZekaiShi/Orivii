import {Service} from '@deepseek-ai/cordis'
import {z} from 'zod'
import {homedir} from 'node:os'
import path from 'node:path'
import {promises as fs} from 'node:fs'
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto'
import {Vault,DotError,atomicWrite,validId} from './vault.js'
import {DotEngine} from './engine.js'
import {MEMORY_DEFAULTS,settingsOf,memoryStats,appendBubble,rebalance,searchArchive,refOf} from './memory.js'
import {profileOf,editProfile} from './profile.js'
import {createDotRemote} from './protocol.js'
import {searchWeb} from './web.js'
import {loadExtension} from './extension.js'
import {workspaceBridge} from './work.js'
import {publicBubble} from './expression.js'
import {IdentityManager} from './identities.js'
import metadata from '../package.json' with {type:'json'}

const DOT_REMOTE=createDotRemote(z)

export class DotHost {
  constructor(services,{pointer=path.join(process.env.DSH_HOME||path.join(homedir(),'.dsh'),'dot','workspace.json'),identities,now=Date.now}={}) {
    this.services=services;this.pointer=pointer;this.vault=null;this.engine=null;this.tokens=new Set();this.developerTokens=new Set();this.developerTimers=new Map();this.transition=Promise.resolve();this.failedUnlocks=0;this.nextUnlock=0
    this.identities=identities||new IdentityManager(this,{now,create:()=>new DotHost(services,{pointer:this.pointer,identities:this.identities,now})})
  }
  developerAccess(token,enabled){
    clearTimeout(this.developerTimers.get(token));this.developerTimers.delete(token)
    if(enabled){this.developerTokens.add(token);const timer=setTimeout(()=>this.developerAccess(token,false),10000);timer.unref?.();this.developerTimers.set(token,timer)}
    else this.developerTokens.delete(token)
    this.engine?.setDeveloper(this.developerTokens.size>0)
  }
  clearDeveloper(){for(const timer of this.developerTimers.values())clearTimeout(timer);this.developerTimers.clear();this.developerTokens.clear();this.engine?.setDeveloper(false)}
  async location() {try{return JSON.parse(await fs.readFile(this.pointer,'utf8')).workspace}catch(e){if(e.code==='ENOENT')return path.join(homedir(),'DotWorkspace');throw e}}
  async inspect(workspace) {
    const candidate=new Vault(workspace||await this.location())
    try {await fs.lstat(candidate.root)} catch(e) {
      if(e.code==='ENOENT')return {workspace:candidate.workspace,state:'new',encrypted:null}
      throw new DotError('无法检查此目录，请确认路径和读取权限。')
    }
    try {
      const meta=JSON.parse(await fs.readFile(path.join(candidate.root,'vault.json'),'utf8'))
      await fs.access(path.join(candidate.root,'HEAD'))
      if(meta.version!==2||typeof meta.encrypted!=='boolean')throw new Error('unsupported vault')
      return {workspace:candidate.workspace,state:'existing',encrypted:meta.encrypted}
    } catch(e) {
      if(e.code==='EACCES'||e.code==='EPERM')throw new DotError('无法读取已有记忆库，请检查目录权限。')
      return {workspace:candidate.workspace,state:'incomplete',encrypted:null}
    }
  }
  allowed(token) {
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return false
    if(this.access&&this.access.expiresAt!==null&&this.identities.now()>=this.access.expiresAt)return false
    return [...this.tokens].some(t=>timingSafeEqual(Buffer.from(t),Buffer.from(token)))
  }
  async open(request) {
    if(Date.now()<this.nextUnlock)throw new DotError('密码尝试过于频繁，请稍后再试。','locked')
    const workspace=request.workspace||await this.location()
    if(this.vault&&this.vault.workspace!==path.resolve(workspace))throw new DotError('切换工作空间前请先锁定当前记忆库。')
    const candidate=new Vault(workspace)
    try {
      if(request.action==='setup') {
        if(request.plaintext && request.plaintextAcknowledgement!=='明文没有密码保护')throw new DotError('请确认明文文件可被有目录权限的程序读取。')
        await candidate.initialize(request.password,settingsOf(request.settings||{}),request.plaintext===true)
        if(request.profile)await candidate.transaction(state=>editProfile(state,request.profile))
      } else await candidate.unlock(request.password)
    }catch(e){this.failedUnlocks++;this.nextUnlock=Date.now()+Math.min(30000,500*2**Math.min(6,this.failedUnlocks));throw e}
    this.failedUnlocks=0;this.nextUnlock=0
    if(!this.vault) {
      this.services.extension??=await loadExtension(this.pointer)
      this.vault=candidate;this.engine=new DotEngine(candidate,this.services)
      await candidate.transaction(state=>{
        if(!state.catalog.companionProfileVersion){
          const oldPersona='像私信一样自然交流，认真回应对方。不要编造共同经历、记忆、进度或工具结果。'
          if(state.catalog.settings.name==='大肥鱼'&&state.catalog.settings.persona===oldPersona)state.catalog.settings.name=MEMORY_DEFAULTS.name
          if(state.catalog.settings.persona===oldPersona)state.catalog.settings.persona=MEMORY_DEFAULTS.persona
          state.catalog.settings=settingsOf({},state.catalog.settings);state.catalog.companionProfileVersion=1
        }
        if(!state.catalog.companionBrandVersion){
          if(state.catalog.settings.name==='Dot')state.catalog.settings.name=MEMORY_DEFAULTS.name
          state.catalog.companionBrandVersion=1
        }
        for(const job of state.catalog.jobs.filter(j=>['queued','running','memory'].includes(j.status))) {
          let running=false
          try {process.kill(job.pid,0);running=true}catch{}
          if(!running||job.pid===process.pid){job.status='interrupted';job.error='DSH 上次关闭时本轮被中断，原文仍保留。'}
        }
      })
      await this.engine.extension?.start()
      await this.engine.research?.start()
    } else candidate.close()
    await fs.mkdir(path.dirname(this.pointer),{recursive:true,mode:0o700})
    await atomicWrite(this.pointer,JSON.stringify({workspace:this.vault.workspace}))
    const token=randomBytes(32).toString('hex');this.tokens.add(token)
    return {token,workspace:this.vault.workspace}
  }
  command(request){return this.identities.command(request)}
  async commandLocal(request) {
    try {
      if(!request||typeof request!=='object'||Array.isArray(request)||JSON.stringify(request).length>2000000)throw new DotError('请求格式错误或过大。')
      // Owner-only public connectivity check; no vault data or arbitrary input.
      if(request.action==='webCheck'){
        const result=await searchWeb(this.services.web,'DeepSeek Harness official documentation')
        return {ok:true,value:{provider:result.provider,sources:result.sources.map(({url,title})=>({url,title})),retrievedAt:result.retrievedAt}}
      }
      if(request.action==='status') {
        const info=await this.inspect(request.workspace)
        const extensionInstalled=await fs.access(path.join(path.dirname(this.pointer),'private-core','index.mjs')).then(()=>true,()=>false)
        return {ok:true,value:{...info,version:metadata.version,extensionInstalled,workspaceTasksAvailable:Boolean(this.services.workspaceTasks),unlocked:this.allowed(request.token)&&this.vault?.workspace===info.workspace}}
      }
      if(request.action==='setup'||request.action==='unlock') {
        const result=this.transition.then(()=>this.open(request));this.transition=result.catch(()=>{})
        return {ok:true,value:await result}
      }
      if(!this.allowed(request.token)||!this.vault)throw new DotError('记忆库已锁定，请先解锁。','locked')
      return {ok:true,value:await this.dispatch(request)}
    }catch(e){return {ok:false,error:{code:e instanceof DotError?e.code:'internal',message:e instanceof DotError?e.message:'记忆操作失败。请检查目录权限、磁盘和文件完整性；没有自动覆盖原文件。'}}}
  }
  async snapshot(request) {
    const state=await this.vault.read(),chatId=request.chatId
    let messages=[]
    if(chatId) {
      validId(chatId)
      let refs=state.catalog.messages.filter(m=>m.chatId===chatId)
      const at=request.beforeId?refs.findIndex(m=>m.id===request.beforeId):refs.length
      if(at<0)throw new DotError('找不到分页位置。')
      refs=refs.slice(Math.max(0,at-100),at)
      messages=(await Promise.all(refs.map(m=>this.vault.message(m.id)))).map(publicBubble).filter(m=>m.text.trim())
    }
    return {chatId:chatId??null,workspace:this.vault.workspace,encrypted:this.vault.meta.encrypted,settings:state.catalog.settings,profile:profileOf(state),revision:state.catalog.revision,
      chats:state.catalog.chats,stats:memoryStats(state),messages,jobs:state.catalog.jobs.slice(-20).map(({id,chatId,status,kind,startedAt,finishedAt,error})=>({id,chatId,status,kind,startedAt,finishedAt,error})),partial:this.engine.partial.get(chatId)||null,backgroundPhase:this.engine.progress(chatId).backgroundPhase,
      presentationEvents:this.engine.presentationEvents.get(chatId)||[],extensionAvailable:Boolean(this.engine.extension),personaAvailable:Boolean(this.engine.extension)&&this.engine.extension.personaAvailable!==false,totalMessages:state.catalog.messages.filter(m=>m.chatId===chatId).length}
  }
  async dispatch(r) {
    switch(r.action) {
      case 'progress':return this.engine.progress(validId(r.chatId))
      case 'snapshot':return this.snapshot(r)
      case 'lock': {this.tokens.clear();this.clearDeveloper();await this.engine.shutdown();await this.vault.queue;this.vault.close();this.vault=null;this.engine=null;return {locked:true}}
      case 'developerMode':{
        if(typeof r.enabled!=='boolean')throw new DotError('开发者开关无效。')
        this.developerAccess(r.token,r.enabled)
        return {enabled:r.enabled}
      }
      case 'developerSnapshot':{
        if(!this.developerTokens.has(r.token))throw new DotError('请先在本窗口开启开发者模式。','forbidden')
        const chatId=r.chatId?validId(r.chatId):null,state=await this.vault.read()
        if(!this.allowed(r.token)||!this.developerTokens.has(r.token)||!this.engine)throw new DotError('开发者模式已关闭。','forbidden')
        this.developerAccess(r.token,true)
        // Whitelisted data only: no prompts, credentials, reasoning or raw tool output.
        return {time:Date.now(),current:this.engine.inspectedState(state),observation:this.engine.observations.get(chatId)||null,
          phase:this.engine.partial.get(chatId)?.phase||null,presentations:(this.engine.presentationEvents.get(chatId)||[]).slice(-12)}
      }
      case 'extension':{
        if(!this.engine.extension)throw new DotError('本地陪伴扩展未安装。')
        try{return await this.engine.extension.command(r.request,{capability:r.token})}catch(e){throw new DotError(typeof e.message==='string'&&e.message.length<180?e.message:'扩展操作失败，请检查输入。')}
      }
      case 'models': {
        const result=[]
        for(const p of this.services.llm.listProviders()) {
          try {for(const m of await this.services.llm.listModels(p.id))result.push({provider:p.id,id:m.id,name:m.name})}catch{}
        }
        return {items:result,default:this.services.defaultModel.currentSelection()}
      }
      case 'settings':return this.vault.transaction(state=>{state.catalog.settings=settingsOf(r.settings||{},state.catalog.settings);rebalance(state);return state.catalog.settings})
      case 'profile':return this.vault.transaction(state=>editProfile(state,r.profile))
      case 'createChat':return this.vault.transaction(state=>{
        const chat={id:randomUUID(),title:typeof r.title==='string'?r.title.slice(0,80):'新的聊天',createdAt:Date.now(),updatedAt:Date.now(),archived:false}
        state.catalog.chats.push(chat);return chat
      })
      case 'editChat':return this.vault.transaction(state=>{
        const chat=state.catalog.chats.find(c=>c.id===validId(r.chatId));if(!chat)throw new DotError('找不到聊天。')
        if(typeof r.title==='string')chat.title=r.title.trim().slice(0,80)||'聊天'
        if(typeof r.archived==='boolean')chat.archived=r.archived
        return chat
      })
      case 'send':return this.engine.start(validId(r.chatId),r.text,r.requestId)
      case 'cancel':await this.engine.cancel();return {cancelled:true}
      case 'search':return searchArchive(this.vault,await this.vault.read(),r.query)
      case 'source': {
        const state=await this.vault.read();validId(r.id)
        if(!state.catalog.messages.some(m=>m.id===r.id))throw new DotError('原文不属于当前记忆库。')
        const m=await this.vault.message(r.id)
        return {...publicBubble(m),link:refOf(m)}
      }
      case 'memories': {
        if(!['medium','long','permanent','knowledge','memes'].includes(r.layer))throw new DotError('无效的记忆分类。')
        const state=await this.vault.read()
        const entries=['knowledge','memes'].includes(r.layer)?state.permanent[r.layer]||[]:state[r.layer].entries
        return entries.map(e=>({...e,sources:e.sourceIds.map(id=>state.catalog.messages.find(m=>m.id===id)).filter(Boolean).map(m=>({id:m.id,chatId:m.chatId,link:refOf(m)}))}))
      }
      case 'pin':return this.vault.transaction(async state=>{
        validId(r.id);if(!state.catalog.messages.some(m=>m.id===r.id))throw new DotError('找不到原文。')
        const m=await this.vault.message(r.id)
        const text=typeof r.text==='string'&&r.text.trim()?r.text.trim():m.text
        if(text.length>6000)throw new DotError('永久记忆请控制在 6000 字以内；原文仍完整保留。')
        const entry={id:randomUUID(),text,quote:m.text.slice(0,3000),sourceIds:[m.id],time:Date.now(),enabled:true,origin:'user',score:1}
        state.permanent.entries.push(entry);return entry
      })
      case 'editMemory':return this.vault.transaction(state=>{
        const e=[...state.permanent.entries,...state.permanent.knowledge||[],...state.permanent.memes||[]].find(e=>e.id===validId(r.id));if(!e)throw new DotError('找不到这条记录。')
        if(typeof r.text==='string'){if(!r.text.trim()||r.text.length>6000)throw new DotError('内容应为 1–6000 字。');e.text=r.text.trim();e.origin='user';if(e.kind)e.status='active'}
        if(typeof r.enabled==='boolean'){e.enabled=r.enabled;e.origin='user'}
        return e
      })
      case 'import':return this.vault.transaction(async state=>{
        if(typeof r.legacyId!=='string'||r.legacyId.length>100||!Array.isArray(r.messages)||r.messages.length>1000)throw new DotError('旧版聊天导入格式错误。')
        if(state.catalog.imports.includes(r.legacyId))return {duplicate:true}
        const chat={id:randomUUID(),title:typeof r.title==='string'?r.title.slice(0,80):'旧版聊天',createdAt:Date.now(),updatedAt:Date.now(),archived:false}
        state.catalog.chats.push(chat)
        for(const m of r.messages) {
          if(!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>200000)throw new DotError('导入中包含非聊天消息或过大的气泡。')
          await appendBubble(this.vault,state,chat.id,m.role,m.text,Number.isFinite(m.time)?{time:m.time}:{})
        }
        state.catalog.imports.push(r.legacyId);return chat
      })
      default:throw new DotError('不支持此操作。')
    }
  }
  dispose(){return this.identities.dispose()}
  async disposeLocal(){
    this.tokens.clear();this.clearDeveloper()
    try{await Promise.allSettled([this.engine?.shutdown(),this.vault?.queue])}
    finally{this.vault?.close();this.vault=null;this.engine=null}
  }
}

export class DotService extends Service {
  constructor(ctx) {
    super(ctx,'dotCompanion')
    this.typertRemote=Object.freeze({service:this,serviceKey:'dotCompanion',namespace:'dotCompanion'})
    if(!Object.hasOwn(ctx.root.reflect.props,'invocation'))ctx.root.accessor('invocation',{get:()=>undefined})
    const services={llm:ctx.llm,defaultModel:ctx.agentDefaultModel}
    this.host=new DotHost(services)
    ctx.inject(['web'],child=>{services.web=child.web;return()=>{delete services.web}})
    ctx.inject(['agents'],child=>{services.workspaceTasks=workspaceBridge(child.agents);return()=>{delete services.workspaceTasks}})
    ctx.effect(()=>()=>this.host.dispose(),'Dot vault and running requests')
  }
  command(request) {
    if(this.ctx.invocation?.peer?.principal?.kind!=='owner')return {ok:false,error:{code:'forbidden',message:'只有本机所有者可以访问 Orivii。'}}
    return this.host.command(request)
  }
}
export const inject=['llm','agentDefaultModel','typert']
export async function apply(ctx) {
  ctx.typert.register({package:DOT_REMOTE.package,face:'host',schemas:[],invocations:DOT_REMOTE.descriptors,model:{services:[],events:[],objects:[]}})
  await ctx.plugin(DotService)
}
