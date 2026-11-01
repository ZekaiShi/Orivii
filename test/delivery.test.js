import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {appendBubble} from '../src/memory.js'
import {cleanReply,publicBubble} from '../src/expression.js'
import {visibleReply} from '../src/reply.js'

const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
const text=value=>[{type:'text',text:value}]
const tool=(name,args)=>[{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}]
async function fixture(t,handler){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-delivery-'))
  const services={defaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},stream:async function*(o){
    const blocks=o.purpose?text('{}'):await handler(o)
    for(let i=0;i<blocks.length;i++)yield {type:'block-end',index:i,block:blocks[i]}
    yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:path.join(root,'workspace'),plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  assert.equal(open.ok,true,JSON.stringify(open))
  const call=async(action,args={})=>{const r=await host.command({action,token:open.value.token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  await call('extension',{request:{operation:'savePolicy',policy:{analysisEnabled:false}}})
  const chat=await call('createChat')
  const send=(value,id=randomUUID())=>call('send',{chatId:chat.id,text:value,requestId:id})
  const settle=()=>Promise.all([...host.engine.jobs.values()].map(e=>e.promise))
  return {host,call,chat,send,settle}
}

test('rapid messages persist during a reply, run FIFO without seeing future queued input, and retries deduplicate',async t=>{
  const started=gate(),release=gate(),calls=[]
  const f=await fixture(t,async o=>{
    const body=JSON.stringify(o.messages);calls.push(body)
    if(calls.length===1){started.resolve();await release.promise}
    return text('[dot-reply:happy]\n回复'+calls.length)
  })
  t.after(()=>release.resolve())
  await f.send('第一条');await started.promise
  const second=await f.send('第二条'),id=randomUUID(),third=await f.send('第三条',id)
  assert.equal(second.status,'queued');assert.equal(third.status,'queued')
  assert.equal((await f.send('第三条',id)).id,third.id)
  const waiting=await f.call('snapshot',{chatId:f.chat.id})
  assert.deepEqual(waiting.messages.map(m=>m.text),['第一条','第二条','第三条'])
  release.resolve();await f.settle()
  assert.equal(calls.length,3);assert.doesNotMatch(calls[0],/第二条|第三条/)
  assert.match(calls[1],/第二条/);assert.doesNotMatch(calls[1],/第三条/);assert.match(calls[2],/第三条/)
  const done=await f.call('snapshot',{chatId:f.chat.id})
  assert.deepEqual(done.messages.filter(m=>m.role==='assistant').map(m=>m.text),['回复1','回复2','回复3'])
  assert.ok(done.jobs.every(j=>j.status==='done'))
})

test('stop cancels queued replies without losing user messages or starting another model call',async t=>{
  const started=gate();let calls=0
  const f=await fixture(t,async o=>{calls++;started.resolve();await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));return text('不能送达')})
  await f.send('正在说的话');await started.promise;await f.send('紧接着补充的话')
  await f.call('cancel')
  const snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(calls,1);assert.ok(snapshot.jobs.every(j=>j.status==='cancelled'))
  assert.deepEqual(snapshot.messages.map(m=>m.text),['正在说的话','紧接着补充的话'])
  assert.equal(f.host.engine.jobs.size,0)
})

test('structured stage and final replies cannot persist expression control tags in bubbles or their search index',async t=>{
  let round=0
  const f=await fixture(t,()=>++round===1?tool('reply_to_user',{text:'[dot-reply:agree]\n好，我听到了。',expression:'agree'}):tool('finish_reply',{text:'[dot-reply:happy]\n\n行，那就先放着。\n[dot-reply:happy]\n有事随时喊我。',expression:'happy'}))
  await f.send('不用了');await f.settle()
  const snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(snapshot.messages.filter(m=>m.role==='assistant').length,2)
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/dot-reply/)
  assert.equal(snapshot.messages.at(-1).presentation.expression,'happy')
  const state=await f.host.vault.read()
  assert.doesNotMatch(JSON.stringify(state.short.messages),/dot-reply/)
  assert.doesNotMatch(JSON.stringify(state.catalog.messages),/dot-reply/)
  assert.deepEqual(snapshot.presentationEvents.map(e=>e.expression),['agree','happy'])
})

test('legacy assistant bubbles are cleaned for display without rewriting archives or altering user literals',async t=>{
  const f=await fixture(t,()=>text('你好'))
  const legacyVault={putMessage:m=>f.host.vault.putMessage({...m,text:'[dot-reply:happy]\n旧消息正文'})}
  const old=await f.host.vault.transaction(s=>appendBubble(legacyVault,s,f.chat.id,'assistant','原文'))
  await f.host.vault.transaction(s=>appendBubble(f.host.vault,s,f.chat.id,'user','[dot-reply:happy]'))
  const snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(snapshot.messages[0].text.trim(),'旧消息正文')
  assert.equal(snapshot.messages[1].text,'[dot-reply:happy]')
  assert.match((await f.host.vault.message(old.id)).text,/dot-reply/)
  assert.doesNotMatch((await f.call('source',{id:old.id})).text,/dot-reply/)
})

test('metadata filtering preserves Markdown and hides repeated, malformed and chunked tags',()=>{
  assert.equal(cleanReply('    code\n\n正文').text,'    code\n\n正文')
  for(const suffix of ['[dot-reply:happy]','`[dot-reply:happy]`','[dot-reply:script]','[dot-reply:ha','[dot-re']){
    assert.equal(cleanReply('正文\n'+suffix).text,'正文\n')
    assert.equal(visibleReply('[dot-reply:happy]\n正文\n'+suffix).text,'正文\n')
  }
  assert.equal(publicBubble({role:'user',text:'[dot-reply:happy]'}).text,'[dot-reply:happy]')
  assert.equal(cleanReply('[dot-reply:script]\n正文').expression,'neutral')
})
