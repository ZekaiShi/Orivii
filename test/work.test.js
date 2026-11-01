import test from 'node:test'
import assert from 'node:assert/strict'
import {workspaceBridge} from '../src/work.js'
import {indexedSearch,searchDocument,parseLearned,rememberLearned,recallLearned} from '../src/recall.js'

test('workspace bridge sends only delegated text and displays only model-authored public messages',async()=>{
  let listener,config,input,disposed=0,resolve
  const idle=new Promise(r=>resolve=r),seen=[],controller=new AbortController()
  const bridge=workspaceBridge({create:async c=>{config=c;c.setup({on:(name,fn)=>{assert.equal(name,'session/event');listener=fn}});return {agent:{followup:m=>{input=m},whenIdle:()=>idle,cancel:()=>{}},dispose:async()=>{disposed++}}}})
  const handle=await bridge.start({sessionId:'task-1',cwd:'workspace/work',text:'帮我制作一份PPT',selection:{provider:'p',model:'m'},signal:controller.signal,onMessage:m=>seen.push(m)})
  assert.equal(input.content[0].text,'帮我制作一份PPT');assert.deepEqual(config.meta,{cwd:'workspace/work'})
  const send=(type,message,surfaceOp='append',id='task-1')=>listener({id},{type,surfaceOp,data:{message}})
  send('user/message',{role:'user',source:{kind:'system'},content:[{type:'text',text:'PRIVATE_RUNTIME'}]})
  send('assistant/message',{role:'assistant',source:{kind:'injected'},content:[{type:'text',text:'PRIVATE_PROMPT'}]})
  send('assistant/message',{role:'assistant',source:{kind:'model'},content:[{type:'text',text:'PRIVATE_REPLACEMENT'}]},{op:'replace'})
  send('assistant/message',{role:'assistant',source:{kind:'model'},content:[{type:'text',text:'PRIVATE_OTHER_SESSION'}]},'append','other')
  send('assistant/message',{role:'assistant',source:{kind:'model'},content:[{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:'已创建演示文稿'}]})
  listener({id:'task-1'},{type:'turn/end',data:{reason:{kind:'completed'}}});resolve()
  assert.equal((await handle.promise).status,'done');assert.equal(disposed,1)
  assert.equal(seen.length,1);assert.equal(seen[0].text,'已创建演示文稿')
})

test('BM25 ranks concise rare facts; warm queries read only requested hits, never scan history',async()=>{
  const docs=['我喜欢海豚','我喜欢苹果 '.repeat(200),'量子纠错 使用重复编码','普通每日记录']
  const refs=docs.map((text,i)=>{const d=searchDocument(text);return {id:String(i),chatId:'c',role:'user',time:i,searchTerms:d.terms,searchFrequency:d.frequency,searchLength:d.length}})
  let reads=0
  const vault={requireOpen(){},message:async id=>{reads++;return {text:docs[Number(id)]}}},state={catalog:{messages:refs}}
  const result=await indexedSearch(vault,state,'我喜欢海豚',1)
  assert.equal(result[0].id,'0');assert.equal(reads,1)
  assert.equal((await indexedSearch(vault,state,'量子纠错',1))[0].id,'2');assert.equal(reads,2)
  assert.deepEqual(await indexedSearch(vault,state,'找不到的生僻詞',2),[]);assert.equal(reads,2)
})

test('native task cancellation is attached before submission and pre-aborted tasks never submit',async()=>{
  let submitted=0,cancelled=0,disposed=0,resolve
  const controller=new AbortController(),idle=new Promise(r=>resolve=r)
  const bridge=workspaceBridge({create:async()=>({agent:{followup:()=>{submitted++;controller.abort()},cancel:()=>{cancelled++;resolve()},whenIdle:()=>idle},dispose:async()=>{disposed++}})})
  const handle=await bridge.start({sessionId:'s',cwd:'work',text:'test',selection:{},signal:controller.signal,onMessage(){}});await handle.promise
  assert.equal(submitted,1);assert.equal(cancelled,1);assert.equal(disposed,1)
  await assert.rejects(bridge.start({sessionId:'s',cwd:'work',text:'test',selection:{},signal:controller.signal,onMessage(){}}),/cancelled/)
  assert.equal(submitted,1);assert.equal(disposed,2)
})

test('meme context has exact-source tags; corrections preserve provenance and suppress superseded claims',()=>{
  const sources=[{id:'a',role:'user',time:1,text:'蓝瘦香菇是难受想哭的谐音，不适合在真正难过时调侃'},{id:'b',role:'user',time:2,text:'补充一下，蓝瘦香菇来自方言发音'}]
  const state={catalog:{messages:sources},permanent:{}}
  const old=parseLearned({memes:[{sourceId:'a',topic:'蓝瘦香菇',text:'网络谐音',quote:sources[0].text,tags:['蓝瘦香菇','虚构'],usage:'轻松引用',avoid:'真正难过时'}]},sources)
  rememberLearned(state,old)
  assert.deepEqual(old[0].tags,['蓝瘦香菇'])
  rememberLearned(state,parseLearned({memes:[{sourceId:'b',topic:'蓝瘦香菇',text:'方言发音',quote:sources[1].text,supersedes:old[0].id,relation:'corrects'}]},sources))
  assert.equal(state.permanent.memes[0].status,'superseded');assert.equal(recallLearned(state,'蓝瘦香菇').length,1)
})
