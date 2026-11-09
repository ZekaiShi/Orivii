import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {Vault,initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS,appendBubble,searchArchive,buildContext,parseAnalysis} from '../src/memory.js'
import {rememberLearned,recallLearned,learnedText} from '../src/recall.js'

async function fixture(t){
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const dir=await fs.mkdtemp(path.join(base,'dot-recall-')),vault=new Vault(dir)
  await vault.initialize('recall-test-password',MEMORY_DEFAULTS)
  t.after(async()=>{vault.close();await fs.rm(dir,{recursive:true,force:true})})
  return vault
}
test('archive index decrypts only ranked hits, reuses legacy indexing, follows new messages, and clears on lock',async t=>{
  const vault=await fixture(t),chatId=randomUUID()
  await vault.transaction(async state=>{
    state.catalog.chats.push({id:chatId,title:'测试'})
    for(let i=0;i<300;i++)await appendBubble(vault,state,chatId,'user',i===143?'蓝瘦香菇是那年一起聊过的梗':'普通生活片段编号 '+i)
  })
  let reads=0;const original=vault.message.bind(vault);vault.message=async id=>{reads++;return original(id)}
  let state=await vault.read(),start=performance.now()
  const hits=await searchArchive(vault,state,'蓝瘦香菇',5)
  const cold=performance.now()-start
  assert.equal(hits.length,1);assert.equal(reads,1,'new encrypted catalog has all index terms')
  reads=0;start=performance.now();await searchArchive(vault,state,'蓝瘦香菇',5)
  t.diagnostic(`300 records: first indexed query ${cold.toFixed(1)}ms, warm query ${(performance.now()-start).toFixed(1)}ms; archive reads per query: 1`)
  assert.equal(reads,1)
  delete vault.searchIndex;for(const ref of state.catalog.messages)delete ref.searchTerms
  reads=0;await searchArchive(vault,state,'蓝瘦香菇',5);assert.equal(reads,301)
  reads=0;await searchArchive(vault,state,'蓝瘦香菇',5);assert.equal(reads,1,'legacy archive is scanned once per unlock, not once per query')
  await vault.transaction(s=>appendBubble(vault,s,chatId,'user','紫色水獭的独特新故事'))
  state=await vault.read();reads=0
  assert.equal((await searchArchive(vault,state,'紫色水獭',5)).length,1);assert.equal(reads,1)
  vault.close();assert.equal(vault.searchIndex,null)
  await assert.rejects(()=>searchArchive(vault,state,'蓝瘦香菇'),/锁定/)
})
test('small context uses intact recent bubbles without deleting older history',()=>{
  const state=initialState({...MEMORY_DEFAULTS}),chatId=randomUUID()
  for(let i=0;i<70;i++)state.short.messages.push({id:randomUUID(),chatId,role:i%2?'assistant':'user',time:i+1,text:`第${i}条 `+'生活细节'.repeat(300)})
  state.short.messages.push({id:randomUUID(),chatId,role:'user',time:80,text:'还记得蓝瘦香菇吗？'})
  const original=JSON.stringify(state)
  const context=buildContext(state,chatId,32000,{provider:'test',model:'test'})
  assert.ok(context.messages.length<state.short.messages.length)
  assert.match(context.messages.at(-1).content[0].text,/蓝瘦香菇/)
  assert.match(context.system,/先用 reply_to_user/)
  assert.equal(JSON.stringify(state),original)
})
test('complementary knowledge stays active; an explicit question marks uncertainty without declaring a replacement true',()=>{
  const state=initialState({...MEMORY_DEFAULTS})
  const sources=[{id:randomUUID(),role:'user',time:1,text:'木材有不同的纹理。'}, {id:randomUUID(),role:'user',time:2,text:'含水率也会影响木材。'}, {id:randomUUID(),role:'user',time:3,text:'前面那个纹理的判断我还不能确定。'}]
  state.catalog.messages=sources
  for(const source of sources.slice(0,2))rememberLearned(state,parseAnalysis(JSON.stringify({knowledge:[{topic:'木材',text:source.text,quote:source.text,sourceId:source.id}]}),[source]).learned)
  assert.deepEqual(state.permanent.knowledge.map(e=>e.status),['active','active'])
  rememberLearned(state,parseAnalysis(JSON.stringify({knowledge:[{topic:'木材',text:sources[2].text,quote:sources[2].text,sourceId:sources[2].id,supersedes:state.permanent.knowledge[0].id,relation:'questions'}]}),[sources[2]]).learned)
  assert.deepEqual(state.permanent.knowledge.map(e=>e.status),['disputed','active','disputed'])
})
test('knowledge corrections and memes persist with evidence, uncertainty and manual precedence',async t=>{
  const vault=await fixture(t),chatId=randomUUID();let oldId,newId
  await vault.transaction(async state=>{
    state.catalog.chats.push({id:chatId,title:'知识'})
    const first=await appendBubble(vault,state,chatId,'user','我以前以为实木家具都是假的。')
    const parsed=parseAnalysis(JSON.stringify({knowledge:[{topic:'实木家具',text:'用户曾认为实木家具都是假的',sourceId:first.id,quote:'实木家具都是假的'}]}),[first])
    rememberLearned(state,parsed.learned);oldId=state.permanent.knowledge[0].id
    const next=await appendBubble(vault,state,chatId,'user','现在改正一下，实木家具要分材料，并且需要实地考察。蓝瘦香菇这个老梗我还记得。')
    const analysis=parseAnalysis(JSON.stringify({knowledge:[{topic:'实木家具',text:'用户修正为按材料区分并实地考察',sourceId:next.id,quote:'实木家具要分材料，并且需要实地考察',supersedes:oldId,relation:'corrects'}],memes:[{topic:'蓝瘦香菇',text:'用户仍记得蓝瘦香菇这个老梗',sourceId:next.id,quote:'蓝瘦香菇这个老梗我还记得'}]}),[next])
    rememberLearned(state,analysis.learned);newId=state.permanent.knowledge.at(-1).id
    const bad=parseAnalysis(JSON.stringify({knowledge:[{topic:'假证据',text:'任意断言',sourceId:next.id,quote:'并不存在的原话'}]}),[next])
    assert.equal(bad.learned.length,0)
  })
  vault.close();await vault.unlock('recall-test-password')
  let state=await vault.read()
  assert.equal(state.permanent.knowledge.find(e=>e.id===oldId).status,'superseded')
  assert.equal(state.permanent.knowledge.find(e=>e.id===oldId).replacedBy,newId)
  const recalled=recallLearned(state,'实木家具')
  assert.equal(recalled.length,1);assert.equal(recalled[0].id,newId)
  assert.match(learnedText(recalled[0]),/未经外部核验/)
  assert.equal(recallLearned(state,'蓝瘦香菇')[0].kind,'memes')
  await vault.transaction(s=>{const e=s.permanent.knowledge.find(e=>e.id===newId);e.origin='user';e.enabled=false;rememberLearned(s,[{...e,id:randomUUID(),origin:'model',enabled:true}])})
  state=await vault.read();assert.equal(recallLearned(state,'实木家具').length,0)
  const head=(await fs.readFile(path.join(vault.root,'HEAD'),'utf8')).trim()
  assert.doesNotMatch(await fs.readFile(path.join(vault.root,'generations',head,'permanent.json.enc'),'utf8'),/实木|蓝瘦/)
})
