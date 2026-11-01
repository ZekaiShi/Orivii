import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {MEMORY_DEFAULTS,buildContext,parseAnalysis} from '../src/memory.js'
import {profileOf,editProfile,rememberProfile} from '../src/profile.js'
import {Vault} from '../src/vault.js'

test('user impression is evidence-backed, encrypted, shared across chats and protected by manual corrections',async()=>{
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const root=await fs.mkdtemp(path.join(base,'dot-profile-test-')),workspace=path.join(root,'workspace')
  const calls=[]
  const services={defaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async prepareCall(config){return {config,context:{contextWindow:512000},stream:async function*(options){
    calls.push(options)
    let text='嗯，我记下了。'
    if(options.purpose){
      const source=JSON.parse(options.messages[0].content[0].text).find(m=>m.role==='user'&&m.text.includes('叫我阿林'))
      text=JSON.stringify({summary:'用户介绍称呼和喜好',overview:'认识用户',salient:[],profile:source?[
        {field:'preferredName',value:'阿林',quote:'叫我阿林',sourceId:source.id},
        {field:'identity',value:'博士生',quote:'我是博士生',sourceId:source.id},
        {field:'preferences',value:'晚上散步',quote:'我喜欢晚上散步',sourceId:source.id},
      ]:[]})
    }
    yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  let token
  const call=async(action,data={})=>{const response=await host.command({action,token,...data});assert.equal(response.ok,true,JSON.stringify(response.error));return response.value}
  try {
    const opened=await call('setup',{workspace,password:'profile-test-only',settings:{name:'小点',autoPermanent:false},profile:{preferredName:'亲爱的'}});token=opened.token
    const first=await call('createChat',{title:'认识你'}),second=await call('createChat',{title:'另一天'})
    await call('send',{chatId:first.id,text:'叫我阿林。我是博士生，我喜欢晚上散步。',requestId:randomUUID()})
    await Promise.all([...host.engine.jobs.values()].map(j=>j.promise))
    const snapshot=await call('snapshot',{chatId:first.id})
    assert.equal(snapshot.profile.fields.preferredName.value,'亲爱的','manual preferred name wins over extraction')
    assert.equal(snapshot.profile.fields.identity.value,'博士生')
    assert.equal(snapshot.profile.fields.identity.origin,'model')
    const source=await call('source',{id:snapshot.profile.fields.identity.sourceIds[0]})
    assert.ok(source.text.includes(snapshot.profile.fields.identity.quote))
    await call('send',{chatId:second.id,text:'今天也想和你聊聊',requestId:randomUUID()})
    await Promise.all([...host.engine.jobs.values()].map(j=>j.promise))
    const system=calls.filter(c=>!c.purpose).at(-1).system
    assert.match(system,/你是小点/);assert.match(system,/亲爱的/);assert.match(system,/博士生/);assert.match(system,/晚上散步/)
    await call('profile',{profile:{identity:'研究人员',preferences:''}})
    await host.vault.transaction(state=>rememberProfile(state,[{field:'preferences',value:'晚上散步',origin:'model',updatedAt:Date.now(),quote:'我喜欢晚上散步',sourceIds:[source.id]}]))
    assert.equal((await call('snapshot')).profile.fields.preferences.value,'','a cleared manual field is not restored automatically')
    const head=(await fs.readFile(path.join(workspace,'.dot-memory','HEAD'),'utf8')).trim()
    const encrypted=await fs.readFile(path.join(workspace,'.dot-memory','generations',head,'permanent.json.enc'),'utf8')
    for(const value of ['亲爱的','研究人员','晚上散步'])assert.equal(encrypted.includes(value),false)
    await call('lock')
    const locked=await host.command({action:'profile',profile:{identity:'attempt'},token})
    assert.equal(locked.ok,false)
    token=(await call('unlock',{workspace,password:'profile-test-only'})).token
    assert.equal((await call('snapshot')).profile.fields.identity.value,'研究人员')
    assert.equal((await call('snapshot')).profile.fields.preferredName.value,'亲爱的')
    const state=await host.vault.read();state.short.messages=[]
    const context=buildContext(state,second.id,512000,{provider:'test',model:'test'})
    assert.match(context.system,/研究人员/,'impression stays in context when original chat leaves short-term memory')
  } finally {await host.dispose();await fs.rm(root,{recursive:true,force:true})}
})

test('automatic impressions reject invented evidence and assistant identity claims',()=>{
  const user={id:randomUUID(),role:'user',text:'叫我小林',time:1},assistant={id:randomUUID(),role:'assistant',text:'你是医生',time:2}
  const result=parseAnalysis(JSON.stringify({summary:'称呼',overview:'称呼',profile:[
    {field:'preferredName',value:'小林',quote:'叫我小林',sourceId:user.id},
    {field:'identity',value:'医生',quote:'你是医生',sourceId:assistant.id},
    {field:'identity',value:'研究生',quote:'叫我小林',sourceId:user.id},
    {field:'preferences',value:'跑步',quote:'喜欢跑步',sourceId:user.id},
  ]}),[user,assistant])
  assert.equal(result.profile.length,1);assert.equal(result.profile[0].value,'小林')
  const state={permanent:{entries:[]},catalog:{messages:[user]}}
  rememberProfile(state,result.profile)
  editProfile(state,{preferredName:''})
  rememberProfile(state,result.profile)
  assert.equal(profileOf(state).fields.preferredName.value,'')
  assert.throws(()=>editProfile(state,{unknown:'bad'}))
})

test('old built-in name becomes Orivii on unlock while new explicit names are kept',async()=>{
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const root=await fs.mkdtemp(path.join(base,'dot-name-test-'))
  const oldPersona='像私信一样自然交流，认真回应对方。不要编造共同经历、记忆、进度或工具结果。'
  const host=new DotHost({},{pointer:path.join(root,'pointer.json')})
  try {
    for(const [label,legacy,expected] of [['legacy',true,'Orivii'],['chosen',false,'大肥鱼']]) {
      const vault=new Vault(path.join(root,label))
      await vault.initialize('',{...MEMORY_DEFAULTS,name:'大肥鱼',persona:legacy?oldPersona:MEMORY_DEFAULTS.persona},true)
      if(legacy)await vault.transaction(state=>{delete state.catalog.companionProfileVersion})
      vault.close()
      const opened=await host.command({action:'unlock',workspace:path.join(root,label)})
      assert.equal(opened.ok,true)
      const snapshot=await host.command({action:'snapshot',token:opened.value.token})
      assert.equal(snapshot.value.settings.name,expected)
      await host.command({action:'lock',token:opened.value.token})
    }
  } finally {await host.dispose();await fs.rm(root,{recursive:true,force:true})}
})

test('Orivii migration upgrades only the old default once and keeps explicitly chosen names',async()=>{
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const root=await fs.mkdtemp(path.join(base,'brand-migration-'))
  const host=new DotHost({},{pointer:path.join(root,'pointer.json')})
  try{
    for(const [label,name,old,expected] of [['default','Dot',true,'Orivii'],['custom','Baby',true,'Baby'],['chosen','Dot',false,'Dot'],['fresh',MEMORY_DEFAULTS.name,false,'Orivii']]){
      const workspace=path.join(root,label),vault=new Vault(workspace)
      await vault.initialize('',{...MEMORY_DEFAULTS,name},true)
      if(old)await vault.transaction(state=>{delete state.catalog.companionBrandVersion})
      vault.close()
      let opened=await host.command({action:'unlock',workspace});assert.equal(opened.ok,true)
      let token=opened.value.token
      assert.equal((await host.command({action:'snapshot',token})).value.settings.name,expected)
      await host.command({action:'settings',token,settings:{name:'Dot'}})
      await host.command({action:'lock',token})
      opened=await host.command({action:'unlock',workspace});token=opened.value.token
      assert.equal((await host.command({action:'snapshot',token})).value.settings.name,'Dot')
      await host.command({action:'lock',token})
    }
  }finally{await host.dispose();await fs.rm(root,{recursive:true,force:true})}
})
