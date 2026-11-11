import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {collect} from '../src/engine.js'
import {DOT_EXPRESSIONS,DOT_EXPRESSION_MEANINGS,dotExpression} from '../src/expression.js'

export function mockServices(handler) {
  const requests=[]
  // Keep legacy inline-tool compatibility covered; assistant.test/research.test
  // exercise the default community runtime with no extension installed.
  return {requests,extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'test',model:'model'})},llm:{
    listProviders:()=>[{id:'test'}],listModels:async()=>[{id:'model',name:'Test model'}],
    async prepareCall(config){return {config,context:{contextWindow:512000},stream:async function*(options){
      requests.push(options)
      const blocks=handler?await handler(options):[{type:'text',text:options.purpose==='compaction'?JSON.stringify({summary:'用户聊到了猫春卷。',overview:'猫春卷',salient:[]}):'我记住啦，春卷。'}]
      for(let i=0;i<blocks.length;i++)yield {type:'block-end',index:i,block:blocks[i]}
      yield {type:'finish',reason:{kind:'stop'}}
    }}}
  }}
}
async function fixture(t,services=mockServices()){
  const base=process.env.DOT_TEST_TEMP||fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const root=await fs.mkdtemp(path.join(base,'dot-host-test-'))
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:path.join(root,'workspace'),password:'test-only-password'})
  assert.equal(open.ok,true,JSON.stringify(open))
  const call=async(action,data={})=>{const r=await host.command({action,token:open.value.token,...data});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  return {host,root,call,token:open.value.token,services}
}
async function settle(host){await Promise.all([...host.engine.jobs.values()].map(j=>j.promise))}

test('six successful query rounds retain evidence and allow an artifact delivery before the terminal reply',async t=>{
  let rounds=0,lookups=0
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"演示查询","overview":"演示查询"}'}]
    if(++rounds<=6)return [{type:'tool-call',id:'search'+rounds,name:'web_search',arguments:JSON.stringify({query:'公开测试资料 '+rounds})}]
    assert.deepEqual(options.tools.map(t=>t.name),['finish_reply','list_chat_files','send_chat_image','read_chat_file','present_visual'])
    assert.match(options.system,/资料已经收集完毕/)
    assert.equal(options.messages.filter(m=>m.role==='tool').length,rounds===7?6:7)
    if(rounds===7)return [{type:'tool-call',id:'visual',name:'present_visual',arguments:JSON.stringify({spec:{version:1,title:'核对结果',blocks:[{type:'table',columns:['资料','状态'],rows:[['合成来源','已核对']]}]}})}]
    return [{type:'tool-call',id:'final',name:'finish_reply',arguments:JSON.stringify({text:'已核对公开资料；暂未证实的部分我会明确区分。',expression:'neutral'})}]
  })
  services.web={search:async()=>{lookups++;return {sources:[{url:'https://example.org/source',title:'真实测试来源',snippet:'仅为合成测试'}]}}}
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('send',{chatId:chat.id,text:'帮我核对公开资料',requestId:randomUUID()});await settle(host)
  const s=await call('snapshot',{chatId:chat.id})
  assert.equal(rounds,8);assert.equal(lookups,6);assert.equal(s.jobs.at(-1).status,'done')
  assert.equal(s.messages.filter(message=>message.attachments?.length).length,1)
  assert.match(s.messages.at(-1).text,/已核对/);assert.doesNotMatch(JSON.stringify(s),/internalSteps|本轮资料收集已结束|更具体一些/)
})

test('duplicate searches stop repeated IO and answer-only mode cannot execute a hallucinated business tool',async t=>{
  for(const obeys of [true,false]){
    let rounds=0,lookups=0
    const services=mockServices(options=>{
      if(options.purpose)return [{type:'text',text:'{"summary":"演示","overview":"演示"}'}]
      rounds++
      if(rounds<=2)return [{type:'tool-call',id:'read'+rounds,name:'web_search',arguments:'{"query":"same query"}'}]
      assert.deepEqual(options.tools.map(t=>t.name),['finish_reply','list_chat_files','send_chat_image','read_chat_file','present_visual'])
      return obeys?[{type:'text',text:'[dot-reply:neutral]\n根据已有来源，信息还不足以确认。'}]:[{type:'tool-call',id:'rogue',name:'web_search',arguments:'{"query":"must not run"}'}]
    })
    services.web={search:async()=>{lookups++;return {sources:[]}}}
    const {host,call}=await fixture(t,services),chat=await call('createChat')
    await call('send',{chatId:chat.id,text:'帮我核对一下',requestId:randomUUID()});await settle(host)
    const s=await call('snapshot',{chatId:chat.id});assert.equal(rounds,3);assert.equal(lookups,1)
    assert.equal(s.jobs.at(-1).status,obeys?'done':'failed')
    assert.doesNotMatch(JSON.stringify(s),/must not run|更具体一些|相同查询已执行/)
  }
})

test('repeated invalid image sources do not repeat filesystem IO or end in a generic unfinished reply',async t=>{
  let calls=0
  const services=mockServices(options=>options.purpose?[{type:'text',text:'{}'}]:[{type:'tool-call',id:randomUUID(),name:'send_chat_image',arguments:'{"path":"missing.png"}'}])
  const {host,call}=await fixture(t,services),chat=await call('createChat'),outgoing=host.engine.files.outgoingImage.bind(host.engine.files)
  t.mock.method(host.engine.files,'outgoingImage',async(...args)=>{calls++;return outgoing(...args)})
  await call('send',{chatId:chat.id,text:'把图片给我',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(calls,1);assert.equal(snapshot.jobs.at(-1).status,'done');assert.match(snapshot.messages.at(-1).text,/图片|来源/)
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/这次没能整理出完整答复|可以直接重试|stack|send_chat_image/)
})

test('multiple useful acknowledgements carry distinct ordered expressions around real tools without extra emotion calls',async t=>{
  let turn=0
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"查询","overview":"查询"}'}]
    turn++
    if(turn===1)return [{type:'tool-call',id:'search',name:'web_search',arguments:'{"query":"公开测试资料"}'},{type:'tool-call',id:'ack1',name:'reply_to_user',arguments:'{"text":"好，我先查查。","expression":"agree"}'}]
    if(turn===2)return [{type:'tool-call',id:'ack2',name:'reply_to_user',arguments:'{"text":"两个来源有出入，我再核对一下。","expression":"skeptical"}'},{type:'tool-call',id:'read',name:'web_read',arguments:'{"url":"https://example.org/test"}'}]
    return [{type:'tool-call',id:'final',name:'finish_reply',arguments:'{"text":"核对清楚了。","expression":"relieved"}'}]
  })
  services.web={search:async()=>({sources:[{url:'https://example.org/test',title:'公开来源',snippet:'测试'}]}),fetch:async()=>({url:'https://example.org/test',statusCode:200,body:{kind:'text',content:'公开测试资料'}})}
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('send',{chatId:chat.id,text:'帮我查查公开测试资料',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(turn,3);assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.deepEqual(snapshot.messages.filter(m=>m.role==='assistant').map(m=>m.presentation.expression),['agree','skeptical','relieved'])
  assert.deepEqual(snapshot.presentationEvents.map(e=>e.expression),['agree','skeptical','relieved'])
  assert.equal(new Set(snapshot.presentationEvents.map(e=>e.id)).size,3)
  assert.ok(snapshot.presentationEvents.every(e=>!('text'in e)&&!('arguments'in e)))
  assert.deepEqual((await call('progress',{chatId:chat.id})).presentationEvents,snapshot.presentationEvents)
})
test('repeated and excessive stage messages return tool errors while all calls receive results',async t=>{
  let turn=0
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"测试","overview":"测试"}'}]
    if(++turn===1)return ['第一句','第一句','第二句','第三句','第四句','第五句'].map((text,i)=>({type:'tool-call',id:'ack'+i,name:'reply_to_user',arguments:JSON.stringify({text,expression:'neutral'})}))
    assert.equal(options.messages.filter(m=>m.role==='tool').length,6)
    assert.equal(options.messages.filter(m=>m.role==='tool'&&m.isError).length,2)
    return [{type:'text',text:'最终答案。'}]
  })
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('send',{chatId:chat.id,text:'测试',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.messages.filter(m=>m.role==='assistant').length,5);assert.equal(snapshot.jobs.at(-1).status,'done')
})
test('developer observation is opt-in per unlock capability, tracks real profile uptake, and never enters ordinary snapshots or prompts',async t=>{
  const services=mockServices(options=>{
    if(!options.purpose)return [{type:'reasoning',text:'PRIVATE_DIAGNOSTIC_REASONING'},{type:'text',text:'好。'}]
    const source=JSON.parse(options.messages[0].content[0].text).find(m=>m.role==='user'&&m.text.includes('简短一些'))
    return [{type:'text',text:JSON.stringify({summary:'偏好',overview:'偏好',profile:source?[{field:'preferences',value:'简短一些',quote:'简短一些',sourceId:source.id}]:[]})}]
  })
  const {host,call,token}=await fixture(t,services),chat=await call('createChat')
  assert.equal((await host.command({action:'developerSnapshot',token,chatId:chat.id})).error.code,'forbidden')
  await call('developerMode',{enabled:true})
  await call('send',{chatId:chat.id,text:'以后和我说话简短一些',requestId:randomUUID()});await settle(host)
  let debug=await call('developerSnapshot',{chatId:chat.id})
  assert.equal(debug.current.profile.fields.preferences.value,'简短一些')
  assert.equal(debug.observation.request.context.profile.fields.preferences,undefined)
  assert.equal(debug.observation.analysis.after.profile.fields.preferences.value,'简短一些')
  assert.equal(debug.observation.analysis.status,'complete')
  await call('send',{chatId:chat.id,text:'今天怎么样',requestId:randomUUID()});await settle(host)
  debug=await call('developerSnapshot',{chatId:chat.id})
  assert.equal(debug.observation.request.context.profile.fields.preferences.value,'简短一些')
  assert.match(services.requests.filter(r=>!r.purpose).at(-1).system,/简短一些/)
  assert.doesNotMatch(JSON.stringify(debug),/PRIVATE_DIAGNOSTIC_REASONING|internalSteps|apiKey/)
  assert.doesNotMatch(JSON.stringify(await call('snapshot',{chatId:chat.id})),/observation|contextTokens|axesLearning/)
  assert.ok(services.requests.every(r=>!r.system.includes('developerSnapshot')))
  const other=await host.command({action:'unlock',workspace:host.vault.workspace,password:'test-only-password'})
  assert.equal((await host.command({action:'developerSnapshot',token:other.value.token,chatId:chat.id})).error.code,'forbidden')
  await call('developerMode',{enabled:false});assert.equal(host.engine.observations.size,0)
  assert.equal((await host.command({action:'developerSnapshot',token,chatId:chat.id})).error.code,'forbidden')
  await call('developerMode',{enabled:true});await call('lock');assert.equal(host.developerTimers.size,0)
  assert.equal((await host.command({action:'developerSnapshot',token,chatId:chat.id})).error.code,'locked')
})

test('explicit live reply publishes state first, streams only public text, and progress never reads archive files',async t=>{
  let headerReady,bodyReady,releaseBody,releaseEnd,calls=0
  const header=new Promise(r=>{headerReady=r}),body=new Promise(r=>{bodyReady=r}),bodyGate=new Promise(r=>{releaseBody=r}),endGate=new Promise(r=>{releaseEnd=r})
  const full='[dot-reply:heart]\n第一段，收到啦。\n第二段，慢慢聊。'
  const services=mockServices()
  services.llm.prepareCall=async config=>({config,context:{contextWindow:512000},stream:async function*(){
    calls++
    yield {type:'reasoning-delta',index:0,text:'PRIVATE_LIVE_REASONING'}
    yield {type:'block-end',index:0,block:{type:'reasoning',text:'PRIVATE_LIVE_REASONING'}}
    yield {type:'text-delta',index:1,text:'[dot-reply:hea'}
    yield {type:'text-delta',index:1,text:'rt]\n'}
    headerReady();await bodyGate
    yield {type:'text-delta',index:1,text:'第一段，收到啦。\n'}
    bodyReady();await endGate
    yield {type:'text-delta',index:1,text:'第二段，慢慢聊。'}
    yield {type:'block-end',index:1,block:{type:'text',text:full}}
    yield {type:'finish',reason:{kind:'stop'}}
  }})
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('settings',{settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  let liveId
  try{
    await call('send',{chatId:chat.id,text:'今天怎么样',requestId:randomUUID()});await header
    let reads=0
    const read=host.vault.read.bind(host.vault),message=host.vault.message.bind(host.vault)
    host.vault.read=(...args)=>{reads++;return read(...args)};host.vault.message=(...args)=>{reads++;return message(...args)}
    const state=await call('progress',{chatId:chat.id});liveId=state.partial.id
    assert.equal(state.running,true);assert.equal(state.partial.text,'');assert.equal(state.partial.presentation.expression,'heart')
    for(let i=0;i<5;i++)await call('progress',{chatId:chat.id})
    assert.equal(reads,0,'typing polls do not decrypt history or load the vault')
    assert.equal((await host.command({action:'progress',chatId:chat.id})).error.code,'locked')
    releaseBody();await body
    const progress=await call('progress',{chatId:chat.id})
    assert.equal(progress.partial.text,'第一段，收到啦。\n')
    assert.doesNotMatch(JSON.stringify(progress),/PRIVATE_LIVE_REASONING|dot-reply/)
    const snapshot=await call('snapshot',{chatId:chat.id})
    assert.equal(snapshot.messages.length,1,'unfinished reply is not archived as a complete answer')
  }finally{releaseBody();releaseEnd()}
  await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id}),reply=snapshot.messages.at(-1)
  assert.equal(reply.id,liveId,'stream and saved bubble retain the same identity')
  assert.equal(reply.text,'第一段，收到啦。\n第二段，慢慢聊。');assert.equal(reply.presentation.expression,'heart')
  assert.equal(snapshot.partial,null);assert.equal(calls,1,'status does not require another model call')
})

test('unmarked streamed narration and tool parameters never enter progress, and cancellation clears live text',async t=>{
  let reached,release,phase=0
  const started=new Promise(r=>{reached=r}),gate=new Promise(r=>{release=r}),services=mockServices()
  services.llm.prepareCall=async config=>({config,context:{contextWindow:512000},stream:async function*(){
    if(phase++===0){
      yield {type:'text-delta',index:0,text:'INTERNAL_TOOL_PLAN'}
      yield {type:'tool-call-delta',index:1,id:'search',name:'memory_search',argumentsDelta:'{"query":"PRIVATE_QUERY"}'}
      reached();await gate
      yield {type:'block-end',index:1,block:{type:'tool-call',id:'search',name:'memory_search',arguments:'{"query":"PRIVATE_QUERY"}'}}
    }else yield {type:'block-end',index:0,block:{type:'text',text:'我在。'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }})
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('settings',{settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  try{
    await call('send',{chatId:chat.id,text:'查一下',requestId:randomUUID()});await started
    const progress=await call('progress',{chatId:chat.id})
    assert.equal(progress.partial.text,'');assert.doesNotMatch(JSON.stringify(progress),/INTERNAL_TOOL_PLAN|PRIVATE_QUERY/)
    const cancelling=call('cancel');release();await cancelling
  }finally{release()}
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.partial,null);assert.equal(snapshot.jobs.at(-1).status,'cancelled');assert.equal(snapshot.messages.length,1)
})

test('finish_reply commits text, sanitized expression and completion together without a second model call',async t=>{
  let turn=0
  const expressions=[...DOT_EXPRESSIONS,{script:'do not run'},undefined]
  const services=mockServices(()=>[{type:'reasoning',text:'PRIVATE_EXPRESSION_REASONING'},{type:'text',text:'INTERNAL_EXPRESSION_PLAN'},
    {type:'tool-call',id:'final-'+(++turn),name:'finish_reply',arguments:JSON.stringify({text:'**好呀**，就这么安排。',expression:expressions[turn-1]})}])
  const {host,call}=await fixture(t,services),chat=await call('createChat',{})
  await call('settings',{settings:{autoPermanent:false,autoProfile:false,autoLearn:false,eyeAnimation:false}})
  for(const expected of expressions.map(dotExpression)){
    await call('send',{chatId:chat.id,text:'这样安排好吗？',requestId:randomUUID()});await settle(host)
    const snapshot=await call('snapshot',{chatId:chat.id}),reply=snapshot.messages.at(-1)
    assert.equal(snapshot.chatId,chat.id);assert.equal(snapshot.jobs.at(-1).status,'done')
    assert.equal(reply.text,'**好呀**，就这么安排。');assert.deepEqual(reply.presentation,{expression:expected})
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_EXPRESSION|INTERNAL_EXPRESSION|do not run|finish_reply/)
    assert.equal(snapshot.settings.eyeAnimation,false)
  }
  assert.equal(services.requests.length,expressions.length,'one model request per final reply')
  for(const request of services.requests){
    assert.doesNotMatch(request.messages.map(m=>m.content.map(b=>b.text||'').join('')).join(''),/presentation|expression|curious|surprised|confused|astonished/)
    for(const expression of DOT_EXPRESSIONS)assert.ok(request.system.includes(expression+'：'+DOT_EXPRESSION_MEANINGS[expression]),'model sees the meaning of '+expression)
    for(const name of ['reply_to_user','finish_reply']){
      const schema=request.tools.find(tool=>tool.name===name).parameters
      assert.ok(schema.required.includes('expression'));assert.deepEqual(schema.properties.expression.enum,[...DOT_EXPRESSIONS])
    }
  }
})

test('a declared final stream cannot execute a simultaneous business tool or store its header',async t=>{
  const services=mockServices(()=>[{type:'text',text:'[dot-reply:heart]\n应该停止的回复'},
    {type:'tool-call',id:'mixed',name:'web_search',arguments:'{"query":"not permitted"}'}])
  let requests=0;services.web={search(){requests++;throw new Error('must not execute')}}
  const {host,call}=await fixture(t,services),chat=await call('createChat')
  await call('send',{chatId:chat.id,text:'测试混合输出',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.jobs.at(-1).status,'failed');assert.equal(snapshot.partial,null)
  assert.equal(snapshot.messages.length,1);assert.equal(requests,0)
  assert.doesNotMatch(JSON.stringify(snapshot),/dot-reply|应该停止的回复/)
})

test('a final reply batched with a business tool is rejected until the tool has actually completed',async t=>{
  let turn=0
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{}'}]
    if(++turn===1)return [
      {type:'tool-call',id:'early',name:'finish_reply',arguments:'{"text":"未核实的提前结论","expression":"agree"}'},
      {type:'tool-call',id:'lookup',name:'memory_search',arguments:'{"query":"安排"}'},
    ]
    return [{type:'tool-call',id:'actual',name:'finish_reply',arguments:'{"text":"查过了，还没有明确安排。","expression":"uncertain"}'}]
  })
  const {host,call}=await fixture(t,services),chat=await call('createChat',{})
  await call('send',{chatId:chat.id,text:'之前有安排吗',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.equal(snapshot.messages.at(-1).presentation.expression,'uncertain')
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/未核实的提前结论/)
  assert.equal(turn,2)
})

test('workspace detection distinguishes new, existing and incomplete data without writing or unlocking',async t=>{
  const {host,root,call}=await fixture(t)
  const current=path.join(root,'workspace'),fresh=path.join(root,'new-location')
  const before=await fs.readFile(path.join(current,'.dot-memory','HEAD'),'utf8')
  const status=async workspace=>{const result=await host.command({action:'status',workspace});assert.equal(result.ok,true);return result.value}
  assert.equal((await status(current)).state,'existing')
  assert.equal((await status(current)).encrypted,true)
  assert.equal((await status(current)).unlocked,false,'inspection does not grant a capability')
  assert.equal((await status(fresh)).state,'new')
  await assert.rejects(fs.access(fresh),{code:'ENOENT'})
  await fs.unlink(host.pointer)
  assert.equal((await status(current)).state,'existing','detect actual vault without saved pointer')
  await fs.mkdir(path.join(fresh,'.dot-memory'),{recursive:true})
  await fs.writeFile(path.join(fresh,'.dot-memory','keep.txt'),'existing incomplete data')
  assert.equal((await status(fresh)).state,'incomplete')
  assert.equal((await host.command({action:'status',workspace:'relative-path'})).ok,false)
  assert.equal(await fs.readFile(path.join(current,'.dot-memory','HEAD'),'utf8'),before)
  assert.equal(await fs.readFile(path.join(fresh,'.dot-memory','keep.txt'),'utf8'),'existing incomplete data')
  await call('lock')
})
test('independent chats share memory through real host storage and LLM assembly, without ANY DSH session service',async t=>{
  const {host,call,services}=await fixture(t)
  const a=await call('createChat',{title:'第一次聊天'}),b=await call('createChat',{title:'第二次聊天'})
  const requestId=randomUUID()
  await call('send',{chatId:a.id,text:'我的猫叫春卷',requestId});await settle(host)
  await call('send',{chatId:a.id,text:'我的猫叫春卷',requestId});await settle(host)
  assert.equal((await call('snapshot',{chatId:a.id})).messages.length,2)
  await call('send',{chatId:b.id,text:'你记得猫的名字吗？',requestId:randomUUID()});await settle(host)
  const request=services.requests.filter(r=>!r.purpose).at(-1)
  assert.match(JSON.stringify(request.messages),/我的猫叫春卷/)
  assert.equal(request.sessionId,undefined)
  const snapshot=await call('snapshot',{chatId:b.id})
  assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.equal(snapshot.stats.archivedMessages,4)
  await call('editChat',{chatId:a.id,archived:true})
  assert.ok((await call('search',{query:'春卷'})).length>0)
})
test('password/capability gate, explicit lock, reload and manual permanent corrections',async t=>{
  const {host,root,call,token}=await fixture(t)
  const c=await call('createChat',{})
  await call('send',{chatId:c.id,text:'这是值得永久记住的一天',requestId:randomUUID()});await settle(host)
  const m=(await call('snapshot',{chatId:c.id})).messages[0]
  const pinned=await call('pin',{id:m.id})
  await call('editMemory',{id:pinned.id,text:'用户手动纠正后的重要记忆',enabled:true})
  assert.equal((await host.command({action:'snapshot',token:'0'.repeat(64)})).error.code,'locked')
  await call('lock')
  assert.equal(host.vault,null)
  assert.equal((await host.command({action:'source',token,id:m.id})).error.code,'locked')
  const failed=await host.command({action:'unlock',password:'wrong',workspace:path.join(root,'workspace')})
  assert.equal(failed.ok,false)
  host.nextUnlock=0
  const opened=await host.command({action:'unlock',password:'test-only-password'})
  assert.equal(opened.ok,true)
  const memories=await host.command({action:'memories',token:opened.value.token,layer:'permanent'})
  assert.equal(memories.value[0].text,'用户手动纠正后的重要记忆')
  assert.equal(memories.value[0].sources[0].id,m.id)
})
test('retrieval tool loop reads authentic archived bubbles, reasoning never reaches persisted transcript',async t=>{
  let turn=0
  const services=mockServices(async options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"记录","overview":"记录","salient":[]}'}]
    turn++
    if(turn===2)return [{type:'reasoning',text:'PRIVATE_THINKING'},{type:'text',text:'这个事情有点久了，我看看聊天记录。'},{type:'tool-call',id:'search1',name:'memory_search',arguments:'{"query":"天文馆"}'}]
    if(turn===3){const matches=JSON.parse(options.messages.at(-1).content[0].text);assert.ok(matches[0].link);return [{type:'tool-call',id:'read1',name:'memory_read',arguments:JSON.stringify({ids:[matches[0].id]})}]}
    if(turn===4){assert.match(options.messages.at(-1).content[0].text,/星期五去天文馆/);return [{type:'text',text:'找到了，你说过星期五去天文馆。'}]}
    return [{type:'text',text:'好呀。'}]
  })
  const {host,call}=await fixture(t,services),a=await call('createChat',{}),b=await call('createChat',{})
  await call('send',{chatId:a.id,text:'星期五去天文馆',requestId:randomUUID()});await settle(host)
  await call('send',{chatId:b.id,text:'还记得之前的计划吗？',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:b.id})
  assert.equal(snapshot.jobs.at(-1).status,'done',snapshot.jobs.at(-1).error)
  assert.match(snapshot.messages.at(-1).text,/星期五去天文馆/)
  for(const m of (await host.vault.read()).catalog.messages)assert.doesNotMatch(JSON.stringify(await host.vault.message(m.id)),/PRIVATE_THINKING|tool-call/)
})
test('model transport truncation and provider failures are not stored as successful replies',async()=>{
  async function* missing(){yield {type:'text-delta',index:0,text:'partial'}}
  await assert.rejects(()=>collect(missing()),/完整回复/)
  async function* failed(){yield {type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'sensitive-server-body'}}}}
  await assert.rejects(()=>collect(failed()),e=>e.message.includes('AUTH')&&!e.message.includes('sensitive-server-body'))
})

test('a visible acknowledgement precedes a blocked lookup; tool narration and traces stay internal',async t=>{
  let turn=0,release,started
  const gate=new Promise(resolve=>{release=resolve}),lookupStarted=new Promise(resolve=>{started=resolve})
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"聊天","overview":"聊天"}'}]
    turn++
    if(turn===2)return [
      {type:'reasoning',text:'PRIVATE_REASONING'},
      {type:'text',text:'INTERNAL_SEARCH_PLAN'},
      {type:'tool-call',id:'search1',name:'memory_search',arguments:'{"query":"天文馆"}'},
      {type:'tool-call',id:'reply1',name:'reply_to_user',arguments:'{"text":"我有点印象，让我想想。"}'},
    ]
    return [{type:'text',text:turn>2?'找到了，你提过周五去天文馆。':'好呀。'}]
  })
  const {host,call}=await fixture(t,services),a=await call('createChat',{}),b=await call('createChat',{})
  await call('send',{chatId:a.id,text:'周五去天文馆',requestId:randomUUID()});await settle(host)
  const id=(await call('snapshot',{chatId:a.id})).messages[0].id,original=host.vault.message.bind(host.vault)
  host.vault.message=async key=>{if(key===id){started();await gate}return original(key)}
  try {
    await call('send',{chatId:b.id,text:'之前说过的出行安排是什么？',requestId:randomUUID()})
    await lookupStarted
    const during=await call('snapshot',{chatId:b.id})
    assert.equal(during.messages.at(-1).text,'我有点印象，让我想想。')
    assert.equal(during.jobs.at(-1).status,'running')
    assert.doesNotMatch(JSON.stringify(during),/INTERNAL_SEARCH_PLAN|PRIVATE_REASONING|internalSteps|search1/)
  } finally {release()}
  await settle(host)
  const after=await call('snapshot',{chatId:b.id})
  assert.match(after.messages.at(-1).text,/找到了/)
  assert.doesNotMatch(JSON.stringify(after),/INTERNAL_SEARCH_PLAN|PRIVATE_REASONING|internalSteps/)
  assert.ok((await host.vault.read()).catalog.jobs.at(-1).internalSteps.length>0)
})

test('background memory maintenance does not block the next message or show a busy job',async t=>{
  let release,started,analyzed=false
  const gate=new Promise(resolve=>{release=resolve}),analysisStarted=new Promise(resolve=>{started=resolve})
  const services=mockServices(async options=>{
    if(options.purpose){if(!analyzed){analyzed=true;started();await gate}return [{type:'text',text:'{"summary":"聊天","overview":"聊天"}'}]}
    return [{type:'text',text:'我在。'}]
  })
  const {host,call}=await fixture(t,services),chat=await call('createChat',{})
  try {
    await call('send',{chatId:chat.id,text:'第一句话',requestId:randomUUID()})
    await analysisStarted
    const snapshot=await call('snapshot',{chatId:chat.id})
    assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(snapshot.partial,null)
    const second=await call('send',{chatId:chat.id,text:'接着聊第二句',requestId:randomUUID()})
    assert.equal(second.status,'running')
  } finally {release()}
  await settle(host)
  assert.equal((await call('snapshot',{chatId:chat.id})).messages.filter(m=>m.role==='user').length,2)
})

test('web search acknowledges before network, follows sources and keeps tool output out of bubbles',{timeout:15000},async t=>{
  let turn=0,release,started
  const gate=new Promise(resolve=>{release=resolve}),searchStarted=new Promise(resolve=>{started=resolve})
  const services=mockServices(options=>{
    if(options.purpose)return [{type:'text',text:'{"summary":"聊天","overview":"聊天"}'}]
    turn++
    assert.ok(options.tools.some(tool=>tool.name==='web_search'))
    assert.match(options.system,/联网工具/)
    if(turn===1)return [{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:'INTERNAL_WEB_PLAN'},
      {type:'tool-call',id:'web1',name:'web_search',arguments:'{"query":"显卡价格"}'},
      {type:'tool-call',id:'reply1',name:'reply_to_user',arguments:'{"text":"我帮你看看现在的价格。"}'}]
    if(turn===2){assert.match(options.messages.at(-1).content[0].text,/报价来源/);return [{type:'tool-call',id:'read1',name:'web_read',arguments:'{"url":"https://example.org/gpu"}'}]}
    assert.match(options.messages.at(-1).content[0].text,/测试报价/)
    return [{type:'text',text:'**查到了**：[报价来源](https://example.org/gpu)。'}]
  })
  services.web={search:async()=>{started();await gate;return {sources:[{url:'https://example.org/gpu',title:'报价来源',snippet:'测试资料'}]}},
    fetch:async()=>({url:'https://example.org/gpu',statusCode:200,body:{kind:'text',content:'测试报价'}})}
  const {host,call}=await fixture(t,services),chat=await call('createChat',{})
  try {
    await call('send',{chatId:chat.id,text:'帮我查显卡价格',requestId:randomUUID()})
    await searchStarted
    const during=await call('snapshot',{chatId:chat.id})
    assert.equal(during.messages.at(-1).text,'我帮你看看现在的价格。')
    assert.equal(during.partial.stage,'正在查资料…')
    assert.doesNotMatch(JSON.stringify(during),/INTERNAL_WEB_PLAN|PRIVATE_REASONING|internalSteps/)
  }finally{release()}
  await settle(host)
  const after=await call('snapshot',{chatId:chat.id})
  assert.equal(after.jobs.at(-1).status,'done',after.jobs.at(-1).error)
  assert.equal(after.messages.length,3)
  assert.equal(after.messages.at(-1).webSources[0].url,'https://example.org/gpu')
  assert.equal(after.messages.at(-1).webSources[0].title,'报价来源')
  assert.doesNotMatch(JSON.stringify(after),/INTERNAL_WEB_PLAN|PRIVATE_REASONING|internalSteps|测试报价/)
})

test('web settings remove both model tools and prevent network use',async t=>{
  const services=mockServices(options=>{
    if(!options.purpose){assert.ok(!options.tools.some(tool=>tool.name.startsWith('web_')));assert.match(options.system,/联网功能未开启/)}
    return [{type:'text',text:'现在没有启用联网。'}]
  })
  services.web={search:async()=>{throw new Error('network must not run')}}
  const {host,call}=await fixture(t,services),chat=await call('createChat',{})
  await call('settings',{settings:{webSearch:false}})
  await call('send',{chatId:chat.id,text:'现在显卡价格如何？',requestId:randomUUID()});await settle(host)
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.jobs.at(-1).status,'done',snapshot.jobs.at(-1).error)
})
