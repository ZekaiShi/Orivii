import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {appendBubble} from '../src/memory.js'

async function* answer(text,replayState){
  yield {type:'text-delta',index:0,text}
  yield {type:'block-end',index:0,block:{type:'text',text}}
  yield {type:'finish',reason:{kind:'stop'},...(replayState?{replayState}:{})}
}
async function* tool(name,args,id='synthetic-tool'){
  yield {type:'block-end',index:0,block:{type:'tool-call',name,id,arguments:JSON.stringify(args)}}
  yield {type:'finish',reason:{kind:'stop'}}
}
async function fixture(t,generate,policy){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-policy-delivery-')),heard=[]
  const services={extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(options){if(options.purpose)yield* answer('{}');else yield* generate(options)}}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const opened=await host.command({action:'setup',workspace:root,password:'synthetic-password',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  assert.equal(opened.ok,true,JSON.stringify(opened))
  const token=opened.value.token,call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  host.vault.responsePolicy=policy
  host.engine.voice={status:()=>null,accepted:message=>heard.push(message)}
  const chat=await call('createChat')
  const run=async()=>{const job=await call('send',{chatId:chat.id,text:'Synthetic question',requestId:randomUUID()});await host.engine.jobs.get(job.id)?.promise;return call('snapshot',{chatId:chat.id})}
  return {host,call,chat,heard,run,services}
}
const policy={allowEmpty:true,preview:text=>text,filter:text=>text==='SYNTHETIC_OMITTED'?'':text}

test('suppressed streamed final replies emit no draft, expression or voice, and retry retains provider replay state',async t=>{
  let round=0,reached,release
  const started=new Promise(resolve=>{reached=resolve}),gate=new Promise(resolve=>{release=resolve}),replay={synthetic:'native-replay'}
  const {host,call,chat,heard}=await fixture(t,async function*(options){
    if(++round===1){
      yield {type:'text-delta',index:0,text:'[dot-reply:happy]\nSYNTHETIC_OMITTED'}
      reached();await gate
      yield {type:'block-end',index:0,block:{type:'text',text:'[dot-reply:happy]\nSYNTHETIC_OMITTED'}}
      yield {type:'finish',reason:{kind:'stop'},replayState:replay}
    }else{
      const previous=options.messages.findLast(message=>message.role==='assistant')
      assert.equal(previous.source.provider,'fixture');assert.equal(previous.source.model,'fixture');assert.deepEqual(previous.source.replayState,replay)
      yield* answer('[dot-reply:relieved]\nSYNTHETIC_ACCEPTED')
    }
  },policy)
  let job
  try{
    job=await call('send',{chatId:chat.id,text:'Synthetic question',requestId:randomUUID()});await started
    const progress=await call('progress',{chatId:chat.id})
    assert.equal(progress.partial.text,'');assert.equal(progress.presentationEvents.length,0);assert.equal(heard.length,0)
    assert.equal((await call('snapshot',{chatId:chat.id})).messages.length,1)
  }finally{release()}
  await host.engine.jobs.get(job.id)?.promise
  const snapshot=await call('snapshot',{chatId:chat.id}),state=await host.vault.read()
  assert.equal(round,2);assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.deepEqual(snapshot.messages.filter(m=>m.role==='assistant').map(m=>m.text),['SYNTHETIC_ACCEPTED'])
  assert.deepEqual(snapshot.presentationEvents.map(e=>e.expression),['relieved'])
  assert.deepEqual(heard.map(m=>m.text),['SYNTHETIC_ACCEPTED'])
  assert.doesNotMatch(JSON.stringify(state.short.messages),/SYNTHETIC_OMITTED|输出整理提示|native-replay/)
})

test('suppressed stage and terminal tool replies receive receipts before a useful final reply',async t=>{
  let round=0
  const {run,heard}=await fixture(t,async function*(options){
    round++
    if(round===1){yield* tool('reply_to_user',{text:'SYNTHETIC_OMITTED',expression:'happy'});return}
    const receipt=options.messages.findLast(message=>message.role==='tool')
    if(round===2){assert.deepEqual(JSON.parse(receipt.content[0].text),{sent:false,reason:'empty_after_review'});yield* tool('finish_reply',{text:'SYNTHETIC_OMITTED',expression:'sad'});return}
    assert.equal(receipt.isError,true)
    yield* tool('finish_reply',{text:'SYNTHETIC_ACCEPTED',expression:'neutral'})
  },policy)
  const snapshot=await run()
  assert.equal(round,3);assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.deepEqual(snapshot.messages.filter(m=>m.role==='assistant').map(m=>m.text),['SYNTHETIC_ACCEPTED'])
  assert.deepEqual(snapshot.presentationEvents.map(e=>e.expression),['neutral'])
  assert.deepEqual(heard.map(m=>m.text),['SYNTHETIC_ACCEPTED'])
})

for(const terminalTool of [false,true])test('empty final regeneration is bounded for '+(terminalTool?'tool':'text')+' replies',async t=>{
  let rounds=0
  const {run,heard}=await fixture(t,async function*(){rounds++;if(terminalTool)yield* tool('finish_reply',{text:'SYNTHETIC_OMITTED',expression:'neutral'});else yield* answer('[dot-reply:neutral]\nSYNTHETIC_OMITTED')},policy)
  const snapshot=await run()
  assert.equal(rounds,2);assert.equal(snapshot.jobs.at(-1).status,'failed');assert.equal(snapshot.messages.length,1)
  assert.equal(snapshot.presentationEvents.length,0);assert.equal(heard.length,0)
})

test('an omitted automatic lookup acknowledgement does not cancel the lookup or add an empty bubble',async t=>{
  let rounds=0,lookups=0
  const {run,services,heard}=await fixture(t,async function*(){if(++rounds===1)yield* tool('web_search',{query:'synthetic public source'});else yield* answer('SYNTHETIC_ACCEPTED')},{...policy,revise:(text,{scope})=>scope.kind==='stage'?'':text})
  services.web={search:async()=>{lookups++;return {sources:[]}}}
  const snapshot=await run()
  assert.equal(lookups,1);assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.deepEqual(snapshot.messages.filter(m=>m.role==='assistant').map(m=>m.text),['SYNTHETIC_ACCEPTED']);assert.equal(heard.length,1)
})

test('an omitted image caption preserves the image as an artifact-only bubble without voice',async t=>{
  const {host,chat,heard}=await fixture(t,async function*(){yield* answer('SYNTHETIC_ACCEPTED')},policy)
  const file={id:randomUUID(),name:'fixture.png',kind:'image',mediaType:'image/png',size:1}
  t.mock.method(host.engine.files,'outgoingImage',async()=>file)
  const result=await host.engine.preparePresentation('send_chat_image',{id:file.id,caption:'SYNTHETIC_OMITTED'},new AbortController().signal,{scope:{chatId:chat.id,kind:'attachment-caption'}})
  assert.equal(result.text,'图片');assert.equal(result.artifactOnly,true);assert.equal(result.file,file)
  host.engine.notifyVisible({text:result.text,presentation:{artifactOnly:result.artifactOnly},attachments:[file]})
  assert.equal(heard.length,0)
})

test('complete bodies survive missing metadata separators in bubbles, archives and speech',async t=>{
  const cases=[['[dot-reply:happy]SYNTHETIC_BODY','happy'],['[dot-reply:happy\nSYNTHETIC_BODY','neutral'],['[dot-reply:unknown]SYNTHETIC_BODY','neutral']]
  let round=0
  const {host,run,heard}=await fixture(t,async function*(){yield* answer(cases[round++][0])},policy)
  for(const [,expression]of cases){
    const snapshot=await run(),message=snapshot.messages.at(-1)
    assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(message.text,'SYNTHETIC_BODY');assert.equal(message.presentation.expression,expression)
    assert.equal((await host.vault.message(message.id)).text,'SYNTHETIC_BODY')
  }
  assert.equal(round,3);assert.deepEqual(heard.map(m=>m.text),['SYNTHETIC_BODY','SYNTHETIC_BODY','SYNTHETIC_BODY'])
  const state=await host.vault.read();assert.doesNotMatch(JSON.stringify([state.short.messages,state.catalog.messages]),/dot-reply/)
})

test('metadata-only and empty completed responses retry once with native replay and no phantom user messages',async t=>{
  const cases=['[dot-reply:happy]','[dot-reply:happy]\n','[dot-reply:ha',''],replay={synthetic:'format-recovery'}
  let round=0
  const {host,run,heard}=await fixture(t,async function*(options){
    if(++round%2){yield* answer(cases[(round-1)/2],replay);return}
    const previous=options.messages.findLast(m=>m.role==='assistant')
    assert.deepEqual(previous.source.replayState,replay)
    yield* answer('[dot-reply:relieved]\nSYNTHETIC_ACCEPTED')
  },policy)
  for(const _ of cases){const snapshot=await run();assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(snapshot.messages.at(-1).text,'SYNTHETIC_ACCEPTED')}
  assert.equal(round,8);assert.equal(heard.length,4)
  const state=await host.vault.read();assert.equal(state.short.messages.filter(m=>m.role==='user').length,4)
  assert.doesNotMatch(JSON.stringify(state.short.messages),/dot-reply|输出整理提示|format-recovery/)
})

test('repeated metadata-only output stops after one retry without blank bubbles or voice',async t=>{
  let rounds=0
  const {run,heard}=await fixture(t,async function*(){rounds++;yield* answer('[dot-reply:happy]')},policy)
  const snapshot=await run()
  assert.equal(rounds,2);assert.equal(snapshot.jobs.at(-1).status,'failed');assert.equal(snapshot.messages.length,1)
  assert.equal(snapshot.presentationEvents.length,0);assert.equal(heard.length,0)
})

test('a recovered body remains terminal while metadata-only text can accompany a tool',async t=>{
  let lookups=0
  const blocked=await fixture(t,async function*(){
    yield {type:'block-end',index:0,block:{type:'text',text:'[dot-reply:happy]SYNTHETIC_TERMINAL'}}
    yield {type:'block-end',index:1,block:{type:'tool-call',id:'lookup',name:'web_search',arguments:'{"query":"synthetic"}'}}
    yield {type:'finish',reason:{kind:'stop'}}
  },policy)
  blocked.services.web={search:async()=>{lookups++;return {sources:[]}}}
  const failed=await blocked.run();assert.equal(failed.jobs.at(-1).status,'failed');assert.equal(lookups,0);assert.equal(failed.messages.length,1)
  const accepted=await fixture(t,async function*(){
    yield {type:'text-delta',index:0,text:'[dot-reply:happy]\n'}
    yield {type:'block-end',index:0,block:{type:'text',text:'[dot-reply:happy]\n'}}
    yield {type:'block-end',index:1,block:{type:'tool-call',id:'final',name:'finish_reply',arguments:'{"text":"SYNTHETIC_ACCEPTED","expression":"happy"}'}}
    yield {type:'finish',reason:{kind:'stop'}}
  },policy)
  const snapshot=await accepted.run();assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(snapshot.messages.at(-1).text,'SYNTHETIC_ACCEPTED')
})

test('truncated responses keep recoverable body and mark it incomplete',async t=>{
  const {run,heard}=await fixture(t,async function*(){
    yield {type:'block-end',index:0,block:{type:'text',text:'[dot-reply:concerned]SYNTHETIC_PARTIAL'}}
    yield {type:'finish',reason:{kind:'max-tokens'}}
  },policy)
  const snapshot=await run(),message=snapshot.messages.at(-1)
  assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(message.text,'SYNTHETIC_PARTIAL');assert.equal(message.incomplete,true)
  assert.deepEqual(heard.map(m=>m.text),['SYNTHETIC_PARTIAL'])
})

test('recent prompt history uses the original request context and projects matching continuity copies',async t=>{
  const historyPolicy={...policy,filter(text,{state,scope}){
    if(scope?.kind!=='history')return text
    const [source]=state.short.messages
    assert.equal(source.id,scope.userId)
    if(source.text==='SYNTHETIC_AVAILABILITY')return text
    if(source.text==='SYNTHETIC_LEGACY_REQUEST')return text.replace(' OMIT_LEGACY_ENDING','')
    return text.replace(' OMIT_OTHER_ENDING','')
  }}
  let request
  const {host,call,chat,run,services}=await fixture(t,async function*(options){request=options;yield* answer('Current result')},historyPolicy)
  services.web={search:async()=>({sources:[]})}
  const other=await call('createChat')
  const [direct,legacy,background]=await host.vault.transaction(async state=>{
    const asked=await appendBubble(host.vault,state,chat.id,'user','SYNTHETIC_AVAILABILITY')
    const jobId=randomUUID()
    state.catalog.jobs.push({id:jobId,chatId:chat.id,userId:asked.id,status:'done'})
    await appendBubble(host.vault,state,chat.id,'user','SYNTHETIC_LEGACY_REQUEST')
    await appendBubble(host.vault,state,other.id,'user','SYNTHETIC_OTHER_CHAT')
    const direct=await appendBubble(host.vault,state,chat.id,'assistant','Requested answer OMIT_OTHER_ENDING',{jobId})
    const legacy=await appendBubble(host.vault,state,chat.id,'assistant','Legacy answer OMIT_LEGACY_ENDING')
    const background=await appendBubble(host.vault,state,chat.id,'assistant','Background update OMIT_LEGACY_ENDING',{origin:'followup'})
    return [direct,legacy,background]
  })
  const snapshot=await run()
  assert.equal(snapshot.jobs.at(-1).status,'done')
  const history=request.messages.filter(message=>message.role==='assistant').map(message=>message.content[0].text.split('\n').at(-1))
  assert.deepEqual(history,[direct.text,'Legacy answer',background.text])
  assert.match(request.system,/"text":"Legacy answer"/)
  assert.doesNotMatch(request.system,/Legacy answer OMIT_LEGACY_ENDING|主动补充：/)
  for(const original of [direct,legacy,background])assert.equal((await host.vault.message(original.id)).text,original.text)
  const state=await host.vault.read()
  assert.equal(state.catalog.continuity.recent.find(message=>message.id===legacy.id).text,legacy.text)
})
