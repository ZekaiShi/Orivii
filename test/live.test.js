import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {Vault,initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS,appendBubble,buildContext,searchArchive,readSources} from '../src/memory.js'
import {continuityOf,applyContinuityAnalysis,continuityContext} from '../src/continuity.js'
import {CompanionMedia,mediaUrl,validatePublicPage,watchedIntervals,boundedCues,parseSubtitles,observationScript} from '../src/media.js'
import {Exploration,explorationDue} from '../src/exploration.js'
import {DotHost} from '../src/host.js'

async function fixture(t,{encrypted=false}={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-live-')),vault=new Vault(root)
  await vault.initialize(encrypted?'test-only-continuity':'',MEMORY_DEFAULTS,!encrypted)
  const chatId=randomUUID();await vault.transaction(s=>s.catalog.chats.push({id:chatId,title:'synthetic'}))
  t.after(async()=>{await vault.queue;vault.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,vault,chatId}
}
test('continuity survives encrypted reopen and new chats, rejects stale analysis and filters queued future evidence',async t=>{
  const {vault,root,chatId}=await fixture(t,{encrypted:true})
  const a=await vault.transaction(s=>appendBubble(vault,s,chatId,'user','明天继续讨论海洋论文，先别结束。'))
  const before=await vault.read(),revision=continuityOf(before).revision
  const result={topic:{text:'海洋论文',sourceId:a.id,quote:'海洋论文'},threads:[{text:'继续讨论',sourceId:a.id,quote:'明天继续讨论'}]}
  assert.equal(applyContinuityAnalysis(before,result,[a],revision),true)
  await vault.transaction(s=>Object.assign(s.catalog,{continuity:before.catalog.continuity}))
  const b=await vault.transaction(s=>appendBubble(vault,s,chatId,'user','其实改成今天，称呼我小林。'))
  await vault.transaction(s=>assert.equal(applyContinuityAnalysis(s,result,[a],revision),false))
  vault.close();await vault.unlock('test-only-continuity')
  const state=await vault.read(),chat2=randomUUID();state.catalog.chats.push({id:chat2,title:'new'})
  const context=buildContext(state,chat2,128000,{provider:'test',model:'test'})
  assert.ok(context.messages.some(m=>JSON.stringify(m).includes('改成今天')))
  assert.match(context.system,/海洋论文/);assert.equal((await vault.message(a.id)).text,a.text)
  const earlier=structuredClone(state);earlier.catalog.messages=earlier.catalog.messages.filter(m=>m.id!==b.id)
  assert.doesNotMatch(continuityContext(earlier),/小林/)
  const bytes=await fs.readFile(path.join(root,'.dot-memory','archive',a.id+vault.ext()),'utf8');assert.doesNotMatch(bytes,/海洋论文/)
})
test('transient HEAD replacement visibility is retried, but missing state is never recreated and locks return locked',async t=>{
  const {vault}=await fixture(t),read=fs.readFile;let failures=2
  t.mock.method(fs,'readFile',async(file,...args)=>{if(path.basename(file)==='HEAD'&&failures-->0)throw Object.assign(new Error('transient host filesystem gap'),{code:'ENOENT'});return read.call(fs,file,...args)})
  assert.ok((await vault.read()).catalog)
  t.mock.restoreAll()
  await fs.unlink(path.join(vault.root,'HEAD'));await assert.rejects(()=>vault.read(),{code:'ENOENT'})
  assert.equal(await fs.access(path.join(vault.root,'HEAD')).then(()=>true,()=>false),false)
  vault.close();assert.throws(()=>vault.ext(),e=>e.code==='locked')
})

test('watched intervals exclude fast-forwarded content, future subtitle cues and approximate timelines',()=>{
  const previous={time:10,paused:false,rate:2,source:'a'}
  assert.deepEqual(watchedIntervals([[0,10]],previous,{...previous,time:12},1000),[[0,12]])
  assert.deepEqual(watchedIntervals([[0,10]],previous,{...previous,time:100},1000),[[0,10]])
  assert.deepEqual(watchedIntervals([[0,10]],{...previous,paused:true},{...previous,time:15},1000),[[0,10]])
  const cues=[{from:9,to:10,text:'seen'},{from:50,to:51,text:'skipped'},{from:101,to:102,text:'future'}]
  assert.deepEqual(boundedCues(cues,102,[[0,10],[100,101]]),[])
  assert.equal(parseSubtitles({text:'{"timeline":{"exact":false},"cues":[]}'}).length,0)
  assert.throws(()=>mediaUrl('http://127.0.0.1/'));assert.throws(()=>mediaUrl('http://user:pass@example.com/'))
  assert.match(observationScript('reading'),/getBoundingClientRect/);assert.match(observationScript('reading'),/input\[type="password"\]/)
})
test('companion uses a separate visible session, archives only observed text, pauses out-of-scope navigation and closes only its page',async t=>{
  const {vault,chatId}=await fixture(t);await vault.transaction(s=>s.catalog.liveSettings={mediaEnabled:true})
  let url='https://example.org/read',opened,closed,now=10000
  const browser={status:async()=>({headless:false}),open:async(u,o)=>opened={u,...o},evaluate:async()=>({url,resultJson:JSON.stringify({url,title:'Paper',paragraphs:['正在读的海洋段落'],position:30})}),sessionState:({id})=>({id}),closePage:async s=>closed=s}
  const media=new CompanionMedia({vault,services:{browser},engine:{},key:()=>'',now:()=>now,validate:async u=>new URL(u)});t.after(()=>media.stop())
  await media.start({url,mode:'reading',chatId},'owner');assert.match(opened.session,/^session:orivii:/)
  const state=await vault.read();assert.equal(state.catalog.experiences.length,1);assert.equal(state.catalog.experiences[0].archived,true);assert.equal(state.catalog.experiences[0].text,undefined)
  const results=await searchArchive(vault,state,'海洋');assert.ok(results.some(r=>r.id===state.catalog.experiences[0].id))
  const read=await readSources(vault,state,[state.catalog.experiences[0].id]);assert.match(read[0].text,/海洋段落/)
  now+=20000;await media.sample();assert.equal((await vault.read()).catalog.experiences.length,1)
  url='https://other.org/private';await media.sample();assert.equal(media.status().state,'paused');assert.match((await media.context(false)).text,/不可读/)
  const identity=media.active.identity;await media.stop();assert.equal(closed.id,identity)
})
test('media rejects headless or unavailable dependencies without changing browser settings',async t=>{
  const {vault,chatId}=await fixture(t);await vault.transaction(s=>s.catalog.liveSettings={mediaEnabled:true})
  const browser={status:async()=>({headless:true}),open:()=>assert.fail('must not open'),evaluate:()=>{}}
  const media=new CompanionMedia({vault,services:{browser},engine:{},key:()=>'',validate:async u=>new URL(u)})
  await assert.rejects(()=>media.start({url:'https://example.org',chatId},'owner'),/headless/)
  await assert.rejects(()=>validatePublicPage('https://example.org',async()=>[{address:'192.168.1.2'}]),/内网/)
})
test('stopping while a browser window opens closes that late window and never starts collection',async t=>{
  const {vault,chatId}=await fixture(t);await vault.transaction(s=>s.catalog.liveSettings={mediaEnabled:true})
  let resolve,closed=0
  const browser={status:async()=>({headless:false}),open:()=>new Promise(r=>resolve=r),evaluate:()=>assert.fail('closed activity must not read'),sessionState:()=>({id:'own'}),closePage:async()=>closed++}
  const media=new CompanionMedia({vault,services:{browser},engine:{},key:()=>'',validate:async u=>new URL(u)})
  const opening=media.start({url:'https://example.org',chatId},'owner');const rejected=assert.rejects(opening,/停止/)
  while(!resolve)await new Promise(setImmediate)
  await media.stop();resolve();await rejected;assert.equal(media.status(),null);assert.ok(closed>=2)
})
test('exploration is opt-in, idle-only, rate limited and sends no private conversation/persona to public research',async t=>{
  const {vault}=await fixture(t),now=Date.parse('2026-11-02T12:00:00Z'),calls=[]
  const state=initialState(MEMORY_DEFAULTS);assert.equal(explorationDue(state,now,false),false)
  await vault.transaction(s=>{s.catalog.liveSettings={exploration:true,exploreTopics:['ocean']};s.permanent.privateCanary='PRIVATE_CANARY';s.permanent.companion={policy:{timeZone:'UTC'}}})
  const web={search:async input=>{calls.push(input);return {sources:[{url:'https://example.org/ocean',title:'ocean'}]}},fetch:async input=>{calls.push(input);return {url:input.url,statusCode:200,body:{kind:'text',content:'The ocean has tides.'}}}}
  const engine={isForegroundBusy:()=>false,prepare:async()=>({config:{},stream:async function*(input){calls.push(input);yield {type:'block-end',index:0,block:{type:'text',text:'{"topic":"ocean","quote":"ocean has tides","text":"海洋有潮汐","kind":"knowledge","confidence":0.9}'}};yield {type:'finish',reason:{kind:'stop'}}}})}
  const exploration=new Exploration({vault,engine,services:{web},now:()=>now});t.after(()=>exploration.stop())
  await exploration.tick();await exploration.tick()
  const saved=await vault.read();assert.equal(saved.catalog.exploration.length,1);assert.equal(saved.catalog.exploration[0].status,'read');assert.equal(saved.permanent.knowledge.length,1)
  assert.doesNotMatch(JSON.stringify(calls),/PRIVATE_CANARY/)
  assert.equal(explorationDue(saved,now,true),false);assert.equal(explorationDue(saved,now+1000,false),false)
  const source=await readSources(vault,saved,[saved.catalog.exploration[0].id]);assert.equal(source[0].text,'The ocean has tides.')
})
