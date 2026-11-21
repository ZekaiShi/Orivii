import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {promises as fs} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {Vault,initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS,appendBubble} from '../src/memory.js'
import {companionOf} from '../src/assistant-state.js'
import {continuityOf} from '../src/continuity.js'
import {deliveryDay} from '../src/reminders.js'
import {Followups,followupsOf,rememberFollowups,followupAllowed,publicQuery,verifiedFollowup} from '../src/followups.js'

const MINUTE=60000,HOUR=60*MINUTE
const NOW=Date.parse('2026-11-15T10:00:00+08:00')
const URL='https://example.org/public-guide'
const PAGE='The public guide confirms that the documented compatibility fix is available. This is synthetic public evidence.'
const QUOTE='The public guide confirms that the documented compatibility fix is available.'
const QUESTION='Orivii 在 Linux 上的兼容问题还有什么公开修复办法？'
const QUERY='Orivii Linux public compatibility fix'
const VAULT_PASSWORD='synthetic-followup-password-only'
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const source=(text=QUESTION,extra={})=>({id:randomUUID(),chatId:'chat',role:'user',text,time:NOW-4*HOUR,...extra})
const candidate=(s,extra={})=>({sourceId:s.id,quote:s.text,query:QUERY,confidence:.95,...extra})
function stateOf(sources=[]){
  const state=initialState({...MEMORY_DEFAULTS,webSearch:true})
  state.catalog.chats=[{id:'chat',title:'Synthetic followup chat',archived:false}]
  state.catalog.messages=sources;continuityOf(state).revision=3
  companionOf(state).policy.timeZone='Asia/Shanghai'
  return state
}
const proposal=(extra={})=>({send:true,text:'刚才的兼容问题找到了一条公开修复线索。',expression:'happy',evidence:[{url:URL,quote:QUOTE}],...extra})
async function fixture(t,{time=NOW,compose,search,fetch,answer,encrypted=false}={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-followups-'))
  const vault=new Vault(path.join(root,'workspace'));await vault.initialize(encrypted?VAULT_PASSWORD:'',{...MEMORY_DEFAULTS,webSearch:true,persona:'PRIVATE_PERSONA_CANARY'},!encrypted)
  const clock={now:time},timers=[],runtimes=[],searches=[],reads=[],compositions=[],presentations=[],notifications=[]
  const services={web:{
    async search(request,signal){searches.push(structuredClone(request));return search?search(request,signal):{sources:[{url:URL,title:'Synthetic public guide'}]}},
    async fetch(request,signal){reads.push(structuredClone(request));return fetch?fetch(request,signal):{url:request.url,statusCode:200,body:{kind:'text',content:PAGE}}},
  }}
  const engine={stopped:false,accepting:0,delivering:false,foreground:false,deliveryRevision:0,
    isForegroundBusy(){return this.foreground},
    async composeFollowup(item,pages,signal){compositions.push({item:structuredClone(item),pages:structuredClone(pages)});return compose?compose(item,pages,signal):proposal(answer?{text:answer}:{})},
    async prepareVisibleReply(text){return text},
    present(...args){presentations.push(args)},notifyVisible(message){notifications.push(message)},
  }
  await vault.transaction(s=>{s.catalog.chats.push({id:'chat',title:'Synthetic followup chat',archived:false});continuityOf(s).revision=3;companionOf(s).policy.timeZone='Asia/Shanghai'})
  const create=(options={})=>{
    const runtime=new Followups({vault,engine,services,now:()=>clock.now,setTimer:(fn,delay)=>{const timer={fn,delay,cleared:false,unref(){}};timers.push(timer);return timer},clearTimer:timer=>{if(timer)timer.cleared=true},...options})
    runtimes.push(runtime);return runtime
  }
  const add=async({text=QUESTION,query=QUERY,id=randomUUID(),chatId='chat',at=clock.now-4*HOUR}={})=>vault.transaction(async s=>{
    if(!s.catalog.chats.some(c=>c.id===chatId))s.catalog.chats.push({id:chatId,title:'Other synthetic chat',archived:false})
    const row=await appendBubble(vault,s,chatId,'user',text,{id,time:at})
    rememberFollowups(s,{candidates:[candidate(row,{query})]},[row],s.catalog.continuity.revision)
    return structuredClone(followupsOf(s).items.find(item=>item.sourceId===row.id))
  })
  t.after(async()=>{await Promise.all(runtimes.map(r=>r.stop()));await vault.queue;vault.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,vault,clock,timers,services,engine,create,add,searches,reads,compositions,presentations,notifications}
}

test('candidate extraction requires an exact user source, current revision, confidence, and an open source chat',async t=>{
  const cases=[
    ['invented quote',(s,row)=>({entry:candidate(row,{quote:'这段话从来没有说过'}),sources:[row]})],
    ['assistant source',(s,row)=>{row.role='assistant';return {entry:candidate(row),sources:[row]}}],
    ['missing catalog source',(s,row)=>{s.catalog.messages=[];return {entry:candidate(row),sources:[row]}}],
    ['different chat reference',(s,row)=>({entry:candidate({...row,chatId:'other'}),sources:[{...row,chatId:'other'}]})],
    ['stale analysis',(s,row)=>({entry:candidate(row),sources:[row],revision:2})],
    ['low confidence',(s,row)=>({entry:candidate(row,{confidence:.89}),sources:[row]})],
    ['invalid confidence',(s,row)=>({entry:candidate(row,{confidence:1.1}),sources:[row]})],
    ['archived chat',(s,row)=>{s.catalog.chats[0].archived=true;return {entry:candidate(row),sources:[row]}}],
  ]
  for(const [name,setup] of cases)await t.test(name,()=>{
    const row=source(),s=stateOf([row]),args=setup(s,row)
    rememberFollowups(s,{candidates:[args.entry]},args.sources,args.revision??3)
    assert.equal(followupsOf(s).items.length,0)
  })
  const row=source(),s=stateOf([row]);rememberFollowups(s,{candidates:[candidate(row)]},[row],3)
  assert.equal(followupsOf(s).items.length,1)
  assert.equal(followupsOf(s).items[0].quote,row.text)
  assert.ok(followupsOf(s).items[0].dueAt>=row.time+2*HOUR)
  assert.ok(followupsOf(s).items[0].dueAt<=row.time+3*HOUR)
  assert.equal(followupsOf(s).items[0].expiresAt,row.time+72*HOUR)
})

test('candidate deduplication survives repeated analysis and normalized equivalent public queries',()=>{
  const rows=[source(),source('Orivii Linux 兼容问题仍然没有解决'),source('另一个真实的公开技术疑问')],s=stateOf(rows)
  rememberFollowups(s,{candidates:[candidate(rows[0])]},rows,3)
  rememberFollowups(s,{candidates:[candidate(rows[0],{query:'An entirely different query'}),candidate(rows[1],{query:'ORIVII, Linux public compatibility fix!'})]},rows,3)
  assert.equal(followupsOf(s).items.length,1)
  followupsOf(s).items[0].status='sent'
  rememberFollowups(s,{candidates:[candidate(rows[2])]},rows,3)
  assert.equal(followupsOf(s).items.length,1,'a completed topic must not be automatically scheduled again')
})

test('first lookup waits 2–3 hours and its stored deadline survives encrypted reopen',async t=>{
  const f=await fixture(t,{encrypted:true}),item=await f.add({at:NOW}),first=f.create()
  assert.ok(item.dueAt>=NOW+2*HOUR&&item.dueAt<=NOW+3*HOUR)
  first.start();f.clock.now=NOW+2*HOUR-1;await first.tick()
  assert.equal(f.searches.length,0);assert.equal(f.compositions.length,0)
  await first.stop();f.vault.close();await f.vault.unlock(VAULT_PASSWORD)
  const restarted=f.create();restarted.start()
  assert.equal(followupsOf(await f.vault.read()).items[0].dueAt,item.dueAt)
  f.clock.now=item.dueAt-1;await restarted.tick();assert.equal(f.searches.length,0)
  f.clock.now=NOW+3*HOUR;await restarted.tick();assert.equal(f.searches.length,1)
})

test('old untouched candidates move to a stable 2–3 hour deadline without changing retries or sent records',()=>{
  const row=source(QUESTION,{time:NOW}),s=stateOf([row])
  rememberFollowups(s,{candidates:[candidate(row)]},[row],3)
  const f=followupsOf(s),pending=f.items[0]
  pending.dueAt=NOW+30*MINUTE
  const retry={...pending,id:randomUUID(),attempts:1,dueAt:NOW+6*HOUR},sent={...pending,id:randomUUID(),status:'sent',messageId:'delivered'},checking={...retry,id:randomUUID(),status:'checking',leaseUntil:NOW+MINUTE,runtimeId:'owner'}
  f.items.push(retry,sent,checking);f.version=1
  const preserved=structuredClone([retry,sent,checking]),budget=structuredClone(f.budget)
  followupsOf(s)
  assert.equal(f.version,2);assert.ok(pending.dueAt>=NOW+2*HOUR&&pending.dueAt<=NOW+3*HOUR)
  assert.deepEqual(f.items.slice(1),preserved);assert.deepEqual(f.budget,budget)
  const deadline=pending.dueAt
  assert.equal(followupsOf(structuredClone(s)).items[0].dueAt,deadline)
  f.version=1;assert.equal(followupsOf(s).items[0].dueAt,deadline)
})

test('malformed analysis entries and evidence are ignored without breaking memory maintenance',()=>{
  const row=source(),s=stateOf([row])
  assert.doesNotThrow(()=>rememberFollowups(s,{candidates:[null,false],updates:[null,'invalid']},[row],3))
  assert.equal(followupsOf(s).items.length,0)
  assert.equal(verifiedFollowup(proposal({evidence:[null]}),[{url:URL,content:PAGE}]),null)
})

test('query boundary rejects credentials, contacts, links, addresses, paths, and control characters',()=>{
  const privateQueries=['contact synthetic@example.test about Orivii','https://example.org/private guide','www.example.org/private guide','C:\\private\\chat.txt compatibility','/home/synthetic/private compatibility','Node failure 192.168.10.7','account 1234567890 problem','api_key=synthetic-secret','password: synthetic-secret','token = synthetic-secret','我的邮箱无法登录','Orivii\nPRIVATE_SECOND_LINE','Orivii '+ 'a'.repeat(30)]
  for(const query of privateQueries)assert.equal(publicQuery(query),null,query)
  assert.equal(publicQuery('   '+QUERY+'   '),QUERY)
  assert.equal(publicQuery('Node.js streaming parser regression'),'Node.js streaming parser regression')
  for(const query of ['OpenReview 投稿编号14049 收不到通知','OpenReview submission id 1234 notifications','OpenReview account ID abc12 notifications','OpenReview #14 email issue'])assert.equal(publicQuery(query),null,query)
  const named=stateOf([]);named.permanent.profile={fields:{preferredName:{value:'小林'},identity:{value:'姓名：张三'}}}
  assert.equal(publicQuery('小林 OpenReview 通知收不到',named),null)
  assert.equal(publicQuery('张三 OpenReview 通知收不到',named),null)
  const row=source(),s=stateOf([row]);rememberFollowups(s,{candidates:[candidate(row,{query:privateQueries[0]})]},[row],3)
  assert.equal(followupsOf(s).items.length,0)
})

test('cancellation and resolution require a later exact user quote and do not trust assistant text',()=>{
  const row=source(),s=stateOf([row]);rememberFollowups(s,{candidates:[candidate(row)]},[row],3)
  const item=followupsOf(s).items[0],update=source('这个兼容问题已经解决，不需要继续查了',{time:NOW})
  s.catalog.messages.push(update)
  rememberFollowups(s,{updates:[{id:item.id,sourceId:update.id,quote:'编造的取消理由',status:'cancelled'}]},[update],3)
  assert.equal(item.status,'pending')
  const assistant=source(update.text,{role:'assistant',time:NOW});s.catalog.messages.push(assistant)
  rememberFollowups(s,{updates:[{id:item.id,sourceId:assistant.id,quote:assistant.text,status:'resolved'}]},[assistant],3)
  assert.equal(item.status,'pending')
  rememberFollowups(s,{updates:[{id:item.id,sourceId:update.id,quote:update.text,status:'resolved'}]},[update],3)
  assert.equal(item.status,'resolved');assert.equal(item.resolvedBy,update.id)
})

test('idle boundary and shared proactive policy block lookup without a model or web call',async t=>{
  const row=source(QUESTION,{time:NOW-31*MINUTE}),s=stateOf([row])
  assert.equal(followupAllowed(s,row.time+15*MINUTE-1),false)
  assert.equal(followupAllowed(s,row.time+15*MINUTE),true)
  assert.equal(followupAllowed(s,NOW,true),false)
  const cases=[
    ['disabled',state=>{companionOf(state).policy.enabled=false}],
    ['analysis disabled',state=>{companionOf(state).policy.analysisEnabled=false}],
    ['web disabled',state=>{state.catalog.settings.webSearch=false}],
    ['quiet hours',state=>{companionOf(state).policy.quietStart='09:00';companionOf(state).policy.quietEnd='11:00'}],
    ['daily zero',state=>{companionOf(state).policy.dailyLimit=0}],
    ['daily exhausted',state=>{const c=companionOf(state);c.deliveryDay=deliveryDay(c.policy,NOW);c.deliveries=c.policy.dailyLimit}],
    ['cooldown',state=>{companionOf(state).lastDelivery=NOW-MINUTE}],
    ['queued job',state=>{state.catalog.jobs.push({status:'queued'})}],
    ['memory job',state=>{state.catalog.jobs.push({status:'memory'})}],
    ['ready explicit research',state=>{state.catalog.backgroundResearch=[{status:'ready'}]}],
  ]
  for(const [name,mutate] of cases)await t.test(name,async sub=>{
    const f=await fixture(sub);await f.add();await f.vault.transaction(mutate)
    const r=f.create();r.start();await r.tick()
    assert.equal(f.searches.length,0);assert.equal(f.compositions.length,0)
    assert.equal(followupsOf(await f.vault.read()).budget.attempts,0)
  })
})

test('heartbeat is ten minutes, duplicate starts do not multiply timers, and stopping clears its timer',async t=>{
  const f=await fixture(t),r=f.create();r.start();r.start()
  assert.equal(f.timers.length,1);assert.equal(f.timers[0].delay,10*MINUTE)
  await r.stop();assert.equal(f.timers[0].cleared,true);assert.equal(r.timer,null)
  await r.tick();assert.equal(f.searches.length,0)
})

test('successful lookup sends one ordinary sourced bubble and keeps private context out of web requests and visible output',async t=>{
  const f=await fixture(t),item=await f.add({text:QUESTION+' 我的邮箱是 synthetic@example.test，PRIVATE_CHAT_CANARY。'})
  const r=f.create();r.start();await r.tick();await r.tick()
  assert.deepEqual(f.searches,[{query:QUERY,maxResults:8}]);assert.deepEqual(f.reads,[{url:URL}])
  assert.doesNotMatch(JSON.stringify([...f.searches,...f.reads]),/PRIVATE_|synthetic@example|quote|persona/)
  assert.equal(f.compositions.length,1);assert.equal(f.compositions[0].item.id,item.id)
  const state=await f.vault.read(),messages=state.short.messages.filter(m=>m.role==='assistant')
  assert.equal(messages.length,1);assert.equal(messages[0].origin,'followup');assert.equal(messages[0].followupId,item.id)
  assert.equal(messages[0].chatId,'chat');assert.deepEqual(messages[0].sourceIds,[item.sourceId])
  assert.match(messages[0].text,/\[来源\]\(https:\/\/example.org\/public-guide\)/)
  assert.doesNotMatch(messages[0].text,/PRIVATE_|synthetic@example|confidence|checking|sourceId|leaseUntil|后台|补查/)
  assert.equal(followupsOf(state).items[0].status,'sent');assert.equal(companionOf(state).deliveries,1)
  assert.equal(companionOf(state).lastDelivery,NOW);assert.equal(f.engine.deliveryRevision,1)
  assert.equal(f.presentations.length,1);assert.equal(f.notifications.length,1)
})

test('new evidence must be read verbatim and output cannot cite an unread URL',()=>{
  const pages=[{url:URL,content:PAGE}]
  assert.ok(verifiedFollowup(proposal(),pages))
  for(const value of [proposal({send:false}),proposal({evidence:[]}),proposal({evidence:[{url:URL,quote:'Invented evidence never found in source'}]}),proposal({evidence:[{url:'https://example.org/unread',quote:QUOTE}]}),proposal({text:'详见 https://example.org/unread'}),proposal({text:'x'.repeat(1401)})])assert.equal(verifiedFollowup(value,pages),null)
})

test('no valuable result is silent, retries once after six hours, and spends at most two daily lookup attempts',async t=>{
  const f=await fixture(t,{compose:async()=>({send:false})}),r=f.create();await f.add();r.start()
  await r.tick();let state=await f.vault.read()
  assert.equal(f.searches.length,1);assert.equal(state.short.messages.filter(m=>m.role==='assistant').length,0)
  assert.equal(followupsOf(state).items[0].dueAt,NOW+6*HOUR);assert.equal(companionOf(state).deliveries,undefined)
  await r.tick();assert.equal(f.searches.length,1)
  f.clock.now+=6*HOUR;await r.tick();state=await f.vault.read()
  assert.equal(f.searches.length,2);assert.equal(followupsOf(state).items[0].status,'exhausted')
  await f.add({text:'另一个公开兼容问题仍待查证',query:'Orivii Linux installation error public fix'})
  f.clock.now+=6*HOUR;await r.tick();assert.equal(f.searches.length,2,'a fresh candidate cannot bypass the identity daily attempt budget')
  f.clock.now=NOW+24*HOUR;await r.tick()
  assert.equal(f.searches.length,3);assert.equal(followupsOf(await f.vault.read()).budget.attempts,1)
  assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,0)
})

test('shared delivery quota blocks a second topic after an actual followup delivery',async t=>{
  const f=await fixture(t);await f.add();await f.add({text:'另外一个公开问题还没有解决',query:'Orivii documented renderer crash fix'})
  await f.vault.transaction(s=>{companionOf(s).policy.dailyLimit=1})
  const r=f.create();r.start();await r.tick();f.clock.now+=2*HOUR;await r.tick()
  assert.equal(f.searches.length,1);assert.equal(f.compositions.length,1)
  assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,1)
})

test('expired candidates and unavailable public evidence never create a progress or failure bubble',async t=>{
  await t.test('expired candidate',async sub=>{
    const f=await fixture(sub);await f.add();await f.vault.transaction(s=>{followupsOf(s).items[0].expiresAt=NOW})
    const r=f.create();r.start();await r.tick()
    assert.equal(f.searches.length,0);assert.equal(followupsOf(await f.vault.read()).items[0].status,'expired')
  })
  for(const [name,options] of [['empty search',{search:async()=>({sources:[]})}],['failed search',{search:async()=>{throw Error('SYNTHETIC_PROVIDER_FAILURE')}}],['short page',{fetch:async()=>({url:URL,statusCode:200,body:{kind:'text',content:'too short'}})}]])await t.test(name,async sub=>{
    const f=await fixture(sub,options);await f.add();const r=f.create();r.start();await r.tick()
    assert.equal(f.compositions.length,0);assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,0)
    assert.equal(followupsOf(await f.vault.read()).items[0].attempts,1)
  })
})

test('concurrent heartbeats and host instances acquire one durable lease and deliver once',async t=>{
  const entered=deferred(),release=deferred(),f=await fixture(t,{compose:async()=>{entered.resolve();await release.promise;return proposal()}})
  await f.add();const a=f.create(),b=f.create();a.start();b.start()
  const first=a.tick();await entered.promise
  assert.equal(a.tick(),first);await b.tick()
  assert.equal(f.searches.length,1);assert.equal(f.compositions.length,1)
  release.resolve();await first;await b.tick()
  assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,1)
  assert.equal(followupsOf(await f.vault.read()).budget.attempts,1)
})

test('expired lease resumes within attempt bounds and completed results stay completed after restart',async t=>{
  const f=await fixture(t);await f.add()
  await f.vault.transaction(s=>{const data=followupsOf(s);Object.assign(data.items[0],{status:'checking',runtimeId:'dead-runtime',leaseUntil:NOW-1,attempts:1});data.budget={day:deliveryDay(companionOf(s).policy,NOW),attempts:1}})
  const first=f.create();first.start();await first.tick();await first.stop()
  const restarted=f.create();restarted.start();await restarted.tick()
  const state=await f.vault.read();assert.equal(f.searches.length,1);assert.equal(state.short.messages.filter(m=>m.role==='assistant').length,1)
  assert.equal(followupsOf(state).items[0].status,'sent');assert.equal(followupsOf(state).items[0].attempts,2)
})

test('encrypted vault close and fresh unlock preserve delivered-topic deduplication and the attempt budget',async t=>{
  const f=await fixture(t,{encrypted:true}),item=await f.add(),first=f.create()
  assert.equal(f.vault.meta.encrypted,true)
  first.start();await first.tick();await first.stop()
  const before=await f.vault.read(),delivered=before.short.messages.find(m=>m.role==='assistant')
  assert.ok(delivered);f.vault.close()
  await assert.rejects(f.vault.read(),/锁定/)
  const reopened=new Vault(f.vault.workspace)
  await reopened.unlock(VAULT_PASSWORD)
  const restarted=f.create({vault:reopened})
  t.after(async()=>{await restarted.stop();await reopened.queue;reopened.close()})
  assert.equal(reopened.meta.encrypted,true)
  await reopened.transaction(async s=>{
    const original=await reopened.message(item.sourceId)
    rememberFollowups(s,{candidates:[candidate(original)]},[original],s.catalog.continuity.revision)
  })
  restarted.start();await restarted.tick()
  const after=await reopened.read(),saved=followupsOf(after)
  assert.equal(saved.items.length,1);assert.equal(saved.items[0].status,'sent')
  assert.equal(saved.items[0].messageId,delivered.id);assert.equal(saved.budget.attempts,1)
  assert.equal(after.short.messages.filter(m=>m.role==='assistant').length,1)
  assert.equal(f.searches.length,1);assert.equal(f.compositions.length,1)
})

test('activity, newer user input, cancellation, archived chats, and disabled settings discard late model output',async t=>{
  const cases=[
    ['activity',async(f,r)=>r.activity()],
    ['new user',async f=>f.vault.transaction(s=>appendBubble(f.vault,s,'chat','user','现在先不要继续刚才的问题',{time:NOW}))],
    ['cancelled',async f=>f.vault.transaction(s=>{followupsOf(s).items[0].status='cancelled'})],
    ['archived',async f=>f.vault.transaction(s=>{s.catalog.chats[0].archived=true})],
    ['web disabled',async f=>f.vault.transaction(s=>{s.catalog.settings.webSearch=false})],
    ['analysis disabled',async f=>f.vault.transaction(s=>{companionOf(s).policy.analysisEnabled=false})],
    ['proactive disabled',async f=>f.vault.transaction(s=>{companionOf(s).policy.enabled=false})],
    ['foreground work',async f=>{f.engine.foreground=true}],
  ]
  for(const [name,change] of cases)await t.test(name,async sub=>{
    const entered=deferred(),release=deferred(),f=await fixture(sub,{compose:async()=>{entered.resolve();await release.promise;return proposal({text:'STALE_SYNTHETIC_ANSWER'})}})
    await f.add();const r=f.create();r.start();const running=r.tick();await entered.promise
    await change(f,r);release.resolve();await running
    assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,0)
    assert.equal(f.notifications.length,0);assert.equal(f.presentations.length,0)
    assert.equal(companionOf(await f.vault.read()).deliveries,undefined)
  })
})

test('stop for locking aborts in-flight work and prevents a provider ignoring abort from delivering later',async t=>{
  const entered=deferred(),release=deferred();let modelSignal
  const f=await fixture(t,{compose:async(item,pages,signal)=>{modelSignal=signal;entered.resolve();await release.promise;return proposal({text:'LATE_AFTER_LOCK'})}})
  await f.add();const r=f.create();r.start();const pending=r.tick();await entered.promise
  const stopped=r.stop();assert.equal(modelSignal.aborted,true);release.resolve();await Promise.all([pending,stopped])
  assert.equal((await f.vault.read()).short.messages.filter(m=>m.role==='assistant').length,0)
  assert.equal(f.timers[0].cleared,true);await r.tick();assert.equal(f.searches.length,1)
})

test('independent identity vaults keep equal message IDs, topic keys, budgets, and deliveries isolated',async t=>{
  const first=await fixture(t,{answer:'甲角色的公开修复线索。'}),second=await fixture(t,{answer:'乙角色的公开修复线索。'}),id=randomUUID()
  await first.add({id,text:QUESTION+' PRIVATE_IDENTITY_A'});await second.add({id,text:QUESTION+' PRIVATE_IDENTITY_B'})
  const a=first.create(),b=second.create();a.start();b.start();await Promise.all([a.tick(),b.tick()])
  const sa=await first.vault.read(),sb=await second.vault.read()
  assert.equal(sa.short.messages.at(-1).text.startsWith('甲角色'),true);assert.equal(sb.short.messages.at(-1).text.startsWith('乙角色'),true)
  assert.doesNotMatch(JSON.stringify(first.compositions),/PRIVATE_IDENTITY_B/);assert.doesNotMatch(JSON.stringify(second.compositions),/PRIVATE_IDENTITY_A/)
  assert.equal(followupsOf(sa).budget.attempts,1);assert.equal(followupsOf(sb).budget.attempts,1)
  assert.equal(companionOf(sa).deliveries,1);assert.equal(companionOf(sb).deliveries,1)
})
