import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {appendBubble} from '../src/memory.js'
import {companionOf} from '../src/assistant-state.js'
import {followupsOf} from '../src/followups.js'
import * as community from '../src/assistant.js'

const now=Date.parse('2026-11-15T12:00:00+08:00')
const quote='OpenReview 一直收不到通知，我还没找到原因。'
const query='OpenReview 通知首选邮箱规则'
const url='https://docs.example.org/notifications'
const evidence='Notifications are sent to the preferred email address in your profile.'
async function fixture(t,extension=community){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-followup-host-')),calls=[],requests=[]
  let source
  const services={extension,defaultModel:{currentSelection:()=>({provider:'test',model:'same-orivii'})},web:{
    search:async input=>{requests.push(input);return {sources:[{url,title:'Notification settings'}]}},
    fetch:async input=>{requests.push(input);return {url:input.url,statusCode:200,body:{kind:'text',content:evidence}}}
  },llm:{prepareCall:async config=>({config,context:{contextWindow:128000},stream:async function*(options){
    calls.push(options)
    const drafting=options.messages.at(-1).content.some(c=>c.text?.startsWith('补查资料（不是新用户发言）'))
    let reply
    if(drafting){
      assert.equal(config.model,'same-orivii');assert.deepEqual(options.tools,[])
      assert.match(options.system,/你是Orivii/);assert.ok(JSON.stringify(options.messages).includes(quote))
      reply={send:true,text:'刚找到一个线索：OpenReview 的通知会发到首选邮箱，可以检查一下那个地址。',expression:'happy',evidence:[{url,quote:evidence}]}
    }else{
      assert.match(options.system,/followups:/)
      reply={summary:'收信问题还未解决',overview:'通知邮件',followups:{candidates:[{sourceId:source.id,quote,query,confidence:.95}],updates:[]}}
    }
    yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify(reply)}}
    yield {type:'finish',reason:{kind:'stop'}}
  }})}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')});t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const opened=await host.command({action:'setup',workspace:path.join(root,'workspace'),plaintext:true,plaintextAcknowledgement:'明文没有密码保护'})
  assert.equal(opened.ok,true,JSON.stringify(opened));const token=opened.value.token
  const result=await host.command({action:'createChat',token});assert.equal(result.ok,true)
  const chatId=result.value.id,job={id:randomUUID(),chatId,userId:null,status:'done'}
  await host.vault.transaction(async s=>{
    companionOf(s).policy.timeZone='Asia/Shanghai'
    source=await appendBubble(host.vault,s,chatId,'user',quote+' 联系邮箱是 local-private@example.invalid。',{time:now-4*3600000})
    job.userId=source.id
    await appendBubble(host.vault,s,chatId,'assistant','目前还没找到原因。',{jobId:job.id,time:now-4*3600000+1000})
    s.catalog.jobs.push(job)
  })
  host.engine.followups.now=()=>now
  return {host,job,source,token,chatId,calls,requests}
}

test('native host piggybacks analysis, main Orivii evaluates evidence and only the final reply reaches chat',async t=>{
  const f=await fixture(t),{host,job,calls,requests,token,chatId}=f
  assert.equal(host.engine.followups.stopped,false)
  await host.engine.maintain(job,new AbortController().signal)
  assert.equal(calls.length,1)
  assert.equal(followupsOf(await host.vault.read()).items.length,1)
  await host.engine.followups.tick()
  assert.equal(calls.length,2);assert.equal(requests[0].query,query)
  assert.doesNotMatch(JSON.stringify(requests),/local-private|sourceId|persona/)
  const state=await host.vault.read(),reply=state.short.messages.at(-1)
  assert.equal(reply.origin,'followup');assert.match(reply.text,/首选邮箱/);assert.match(reply.text,/\[来源\]/)
  assert.doesNotMatch(reply.text,/sourceId|confidence|followups|dot-reply|Notifications are sent/)
  assert.equal(reply.presentation.expression,'happy')
  const progress=host.engine.progress(chatId);assert.equal(progress.running,false);assert.equal(progress.backgroundPhase,null)
  assert.equal(progress.presentationEvents.at(-1).messageId,reply.id)
  const snapshot=await host.command({action:'snapshot',token,chatId})
  assert.equal(snapshot.ok,true);assert.doesNotMatch(JSON.stringify(snapshot.value),/leaseUntil|runtimeId|待补查疑问|followup-analysis/)
  await host.engine.followups.tick();assert.equal(calls.length,2)
  const locked=await host.command({action:'lock',token});assert.equal(locked.ok,true)
  assert.equal(host.vault,null)
})

test('owner-installed extension analysis cannot replace the engine follow-up protocol',async t=>{
  let applied=false
  const extension={createExtension:()=>({start:async()=>{},stop:async()=>{},context:()=> '当前相处方式：温暖、自然。',needsAnalysis:()=>true,analysisPrompt:()=> '另外输出 extension 对象。',applyAnalysis:()=>{applied=true},schedule:async()=>{}})}
  const {host,job}=await fixture(t,extension)
  await host.engine.maintain(job,new AbortController().signal)
  assert.equal(applied,true)
  assert.equal(followupsOf(await host.vault.read()).items[0].query,query)
  await host.engine.followups.tick()
  assert.equal((await host.vault.read()).short.messages.at(-1).origin,'followup')
})

test('host locking stops follow-ups immediately even while another subsystem takes time to close',async t=>{
  const {host,job}=await fixture(t)
  await host.engine.maintain(job,new AbortController().signal)
  let enter,releaseModel,releaseMedia
  const entered=new Promise(resolve=>{enter=resolve}),modelGate=new Promise(resolve=>{releaseModel=resolve}),mediaGate=new Promise(resolve=>{releaseMedia=resolve})
  const engine=host.engine,vault=host.vault
  engine.composeFollowup=async()=>{enter();await modelGate;return {send:true,text:'迟到的新线索。',expression:'neutral',evidence:[{url,quote:evidence}]}}
  host.media.stop=async()=>mediaGate
  const ticking=engine.followups.tick();await entered
  const closing=host.disposeLocal()
  assert.equal(engine.followups.stopped,true)
  releaseModel();await ticking
  assert.equal((await vault.read()).short.messages.filter(m=>m.role==='assistant').length,1)
  releaseMedia();await closing
  assert.equal(host.vault,null)
})

test('disabled analysis does not create follow-up candidates despite a model returning them',async t=>{
  const {host,job,calls}=await fixture(t)
  await host.vault.transaction(s=>{companionOf(s).policy.analysisEnabled=false})
  // The normal memory-analysis call is still needed for other enabled memory
  // features; only this candidate lane is disabled.
  host.services.llm.prepareCall=async config=>({config,context:{contextWindow:128000},stream:async function*(options){
    calls.push(options);assert.doesNotMatch(options.system,/followups:/)
    yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify({followups:{candidates:[{sourceId:job.userId,quote,query,confidence:1}]}})}}
    yield {type:'finish',reason:{kind:'stop'}}
  }})
  await host.engine.maintain(job,new AbortController().signal)
  await host.engine.followups.tick()
  assert.equal(followupsOf(await host.vault.read()).items.length,0)
})
