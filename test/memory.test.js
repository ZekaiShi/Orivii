import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {Vault,initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS,appendBubble,rebalance,buildContext,parseAnalysis,searchArchive,settingsOf,tokens} from '../src/memory.js'

async function fixture(t,encrypted=true) {
  const base=process.env.DOT_TEST_TEMP||fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const root=await fs.mkdtemp(path.join(base,'dot-memory-test-'))
  const vault=new Vault(path.join(root,'workspace'))
  t.after(async()=>{vault.close();await fs.rm(root,{recursive:true,force:true})})
  await vault.initialize('test-only-password-9382',MEMORY_DEFAULTS,!encrypted)
  return {vault,root}
}
function chat(state){const c={id:randomUUID(),title:'测试聊天',createdAt:1,updatedAt:1,archived:false};state.catalog.chats.push(c);return c}
test('AES-GCM vault survives restart; archive and all four layers contain no plaintext; wrong password fails',async t=>{
  const {vault}=await fixture(t)
  let id,cid
  await vault.transaction(async s=>{cid=chat(s).id;id=(await appendBubble(vault,s,cid,'user','不能泄露的纪念日-今天很开心')).id})
  const head=(await fs.readFile(path.join(vault.root,'HEAD'),'utf8')).trim()
  for(const name of ['catalog','short','medium','long','permanent']) {
    const raw=await fs.readFile(path.join(vault.root,'generations',head,name+'.json.enc'),'utf8')
    assert.doesNotMatch(raw,/纪念日|test-only-password|测试聊天/)
    assert.ok(JSON.parse(raw).tag)
  }
  assert.doesNotMatch(await fs.readFile(path.join(vault.root,'archive',id+'.json.enc'),'utf8'),/纪念日/)
  vault.close()
  await assert.rejects(()=>vault.unlock('wrong-password'),/密码错误/)
  await vault.unlock('test-only-password-9382')
  assert.equal((await vault.read()).short.messages[0].text,'不能泄露的纪念日-今天很开心')
  assert.equal((await vault.message(id)).chatId,cid)
  const a=await fs.readFile(path.join(vault.root,'archive',id+'.json.enc'),'utf8')
  const changed=JSON.parse(a);changed.tag=Buffer.alloc(16).toString('base64')
  await fs.writeFile(path.join(vault.root,'archive',id+'.json.enc'),JSON.stringify(changed))
  await assert.rejects(()=>vault.message(id))
})
test('independent vault instances serialize writes, failed transactions keep HEAD, originals are immutable',async t=>{
  const {vault}=await fixture(t,false),second=new Vault(vault.workspace)
  await second.unlock('');t.after(()=>second.close())
  const cid=await vault.transaction(s=>chat(s).id)
  await Promise.all([vault.transaction(s=>appendBubble(vault,s,cid,'user','第一条原文')),second.transaction(s=>appendBubble(second,s,cid,'assistant','第二条原文'))])
  assert.equal((await vault.read()).catalog.messages.length,2)
  const before=await fs.readFile(path.join(vault.root,'HEAD'),'utf8')
  await assert.rejects(()=>vault.transaction(s=>{s.catalog.chats=[];throw new Error('abort')}))
  assert.equal(await fs.readFile(path.join(vault.root,'HEAD'),'utf8'),before)
  const message=(await vault.read()).short.messages[0]
  await assert.rejects(()=>vault.putMessage(message))
  await assert.rejects(()=>vault.message('../outside'))
})
test('100k recent memory stays verbatim across chats, aged tiers retain original links and archive search',async t=>{
  const {vault}=await fixture(t,false)
  let originals=[]
  await vault.transaction(async s=>{
    s.catalog.settings.shortBudget=100000;s.catalog.settings.mediumBudget=2000
    const a=chat(s),b=chat(s)
    for(let i=0;i<14;i++)originals.push(await appendBubble(vault,s,i%2?a.id:b.id,i%2?'assistant':'user',`独特天文馆纪念-${i} `+'完整消息'.repeat(2200)))
  })
  const state=await vault.read()
  assert.ok(state.short.messages.length<14)
  assert.ok(state.short.messages.reduce((n,m)=>n+tokens(m.text),0)<=100000)
  for(const message of state.short.messages)assert.equal(message.text,originals.find(m=>m.id===message.id).text)
  assert.ok(state.long.entries.length>0)
  const old=originals[0],hit=(await searchArchive(vault,state,'独特天文馆纪念-0',30)).find(m=>m.id===old.id)
  assert.ok(hit);assert.match(hit.link,/^dot:\/\/chat\//)
  assert.equal((await vault.message(old.id)).text,old.text)
  assert.equal(state.catalog.messages.length,14)
})
test('context includes shared originals and important memories; insufficient capacity for the current message fails safely',()=>{
  const state=initialState({...MEMORY_DEFAULTS}),a=chat(state),b=chat(state)
  state.short.messages=[{id:randomUUID(),chatId:a.id,role:'user',time:1,text:'我的猫叫春卷'},{id:randomUUID(),chatId:b.id,role:'user',time:2,text:'猫叫什么？'}]
  state.permanent.entries=[{text:'重要快乐回忆',sourceIds:[],enabled:true},{text:'停用的不注入',sourceIds:[],enabled:false}]
  const context=buildContext(state,b.id,300000,{provider:'p',model:'m'})
  assert.match(JSON.stringify(context.messages),/春卷/)
  assert.match(context.system,/重要快乐回忆/);assert.doesNotMatch(context.system,/停用的不注入/)
  assert.throws(()=>buildContext(state,b.id,1000,{provider:'p',model:'m'}),/没有丢弃或压缩/)
  assert.throws(()=>buildContext(state,b.id,undefined,{provider:'p',model:'m'}),/没有声明/)
  assert.equal(state.short.messages[0].text,'我的猫叫春卷')
  assert.throws(()=>settingsOf({shortBudget:50000}),/超出/)
})
test('peak/end heuristic preserves strong joy and sadness only with exact USER evidence',()=>{
  const id=randomUUID(),sources=[{id,role:'user',text:'今天毕业了，我真的特别幸福！'}]
  const event={sourceId:id,quote:'今天毕业了',text:'用户今天毕业，十分幸福。',valence:1,intensity:.99,importance:.95,ending:.95}
  const analysis=parseAnalysis(JSON.stringify({summary:'毕业',overview:'毕业',salient:[event,{...event,quote:'和 Dot 一起看过电影'},{...event,sourceId:randomUUID()}]}),sources)
  assert.equal(analysis.salient.length,1)
  assert.equal(analysis.salient[0].enabled,true)
  assert.equal(parseAnalysis(JSON.stringify({salient:[event]}),[{...sources[0],role:'assistant'}]).salient.length,0)
  assert.equal(parseAnalysis('not JSON',sources),null)
})

test('routine chat bounds prefill without compressing or deleting originals; a large current message expands the budget',()=>{
  const state=initialState({...MEMORY_DEFAULTS}),c=chat(state)
  state.short.messages=Array.from({length:50},(_,i)=>({id:randomUUID(),chatId:c.id,role:i%2?'user':'assistant',time:i,text:'完整原始聊天'.repeat(200)}))
  const before=JSON.stringify(state.short)
  const routine=buildContext(state,c.id,512000,{provider:'p',model:'m'})
  assert.equal(routine.report.promptLimit,24000)
  assert.ok(routine.report.includedRecent<state.short.messages.length)
  assert.equal(JSON.stringify(state.short),before,'fast prefill does not change the memory archive')
  const longText='长篇资料'.repeat(3500)
  state.short.messages.push({id:randomUUID(),chatId:c.id,role:'user',time:100,text:longText})
  const expanded=buildContext(state,c.id,512000,{provider:'p',model:'m'})
  assert.ok(expanded.report.promptLimit>24000&&expanded.report.promptLimit<=48000)
  assert.ok(expanded.messages.some(m=>m.content.some(b=>b.text.includes(longText))))
})
