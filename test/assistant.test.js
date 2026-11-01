import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {promises as fs} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {companionOf,rememberCare} from '../src/assistant-state.js'
import {rememberReminders,quiet,dueReminders,updatePolicy,createReminder,listReminders,updateReminder,nextReminderDelay,deliveryDay} from '../src/reminders.js'
import {Assistant as Companion} from '../src/assistant.js'
import {Vault,initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS,appendBubble} from '../src/memory.js'
import {DotHost} from '../src/host.js'
const now=Date.parse('2026-10-30T12:00:00+08:00')
const source=(text='今天毕业了，我很开心',role='user')=>({id:randomUUID(),chatId:'chat',role,text,time:now-3600000})
function stateOf(sources=[]){const s=initialState(MEMORY_DEFAULTS);s.catalog.messages=sources;s.catalog.chats=[{id:'chat',title:'synthetic',archived:false}];companionOf(s).policy.timeZone='Asia/Shanghai';return s}
const reminder=s=>({sourceId:s.id,quote:s.text,title:'交材料',dueAt:new Date(now-1000).toISOString(),confidence:.95})
const reminderArgs=s=>({title:'交材料',dueAt:new Date(now+60000).toISOString(),quote:s.text})
async function fixture(t){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-assistant-'))
  const vault=new Vault(path.join(root,'workspace'));await vault.initialize('',MEMORY_DEFAULTS,true)
  await vault.transaction(s=>{s.catalog.chats.push({id:'chat',title:'synthetic',archived:false});companionOf(s).policy.timeZone='Asia/Shanghai'})
  const runtimes=[]
  t.after(async()=>{await Promise.all(runtimes.map(r=>r.stop()));vault.close();await fs.rm(root,{recursive:true,force:true})})
  const create=(options={})=>{const timers=[];const r=new Companion({vault,services:{},appendBubble,selection:()=>({provider:'test',model:'model'}),isForegroundBusy:()=>false,complete:async()=>'{"text":"你之前提到要交材料，别忘啦。"}',now:()=>now,setTimer:(fn,delay)=>{const id={fn,delay,unref(){}};timers.push(id);return id},clearTimer:()=>{},...options});r.testTimers=timers;runtimes.push(r);return r}
  return {root,vault,create}
}
test('reminders require exact user quotes and a future timezone-qualified date; evidence can cancel',()=>{
  const s=source('今天中午交材料'),a=source('今天中午交材料','assistant'),state=stateOf([s,a])
  rememberReminders(state,{reminders:[reminder(s),{...reminder(s),quote:'编造'},{...reminder(a)},{...reminder(s),dueAt:'2026-10-30T12:00:00'},{...reminder(s),dueAt:'2026-10-29T12:00:00Z'}]},[s,a])
  assert.equal(companionOf(state).reminders.length,1)
  rememberReminders(state,{reminders:[reminder(s)]},[s]);assert.equal(companionOf(state).reminders.length,1)
  const r=companionOf(state).reminders[0],cancel={...source('取消交材料的提醒'),time:now}
  rememberReminders(state,{reminderUpdates:[{id:r.id,sourceId:cancel.id,quote:cancel.text,status:'cancelled'}]},[cancel]);assert.equal(r.status,'cancelled')
})

test('quiet hours use configured timezone and daily/cooldown gates run without model calls',async t=>{
  const {vault,create}=await fixture(t);let calls=0
  const r=create({complete:async()=>{calls++;return '{}'}});await r.start();await r.tick();assert.equal(calls,0);assert.equal(r.testTimers.at(-1).delay,600000)
  const p=companionOf(await vault.read()).policy
  assert.equal(quiet(p,Date.parse('2026-10-30T23:30:00+08:00')),true)
  assert.equal(quiet({...p,timeZone:'UTC'},Date.parse('2026-10-30T23:30:00+08:00')),false)
  assert.throws(()=>updatePolicy(p,{intervalMinutes:0}));assert.throws(()=>updatePolicy(p,{timeZone:'bogus'}))
})

test('concurrent heartbeats persist one delivery across extension restarts',async t=>{
  const {vault,create}=await fixture(t);let calls=0
  await vault.transaction(s=>{const row=source('今天中午交材料');s.catalog.messages.push(row);rememberReminders(s,{reminders:[reminder(row)]},[row])})
  const r=create({complete:async()=>{calls++;return '{"text":"记得交材料。"}'}}),other=create({complete:async()=>{calls++;return '{"text":"记得交材料。"}'}})
  await r.start();await other.start();await Promise.all([r.tick(),other.tick()]);await r.tick()
  assert.equal(calls,1);assert.equal((await vault.read()).short.messages.length,1)
  await r.stop();const restarted=create();await restarted.start();await restarted.tick();assert.equal((await vault.read()).short.messages.length,1)
  assert.equal(companionOf(await vault.read()).reminders[0].status,'sent')
})

test('cancel while drafting reminder prevents delivery; lock aborts pending model work',async t=>{
  const {vault,create}=await fixture(t);let release,started
  const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r)
  await vault.transaction(s=>{const row=source('今天中午交材料');rememberReminders(s,{reminders:[reminder(row)]},[row])})
  const r=create({complete:async()=>{started();await gate;return '{"text":"提醒"}'}});await r.start();const ticking=r.tick();await ready
  const id=companionOf(await vault.read()).reminders[0].id;await r.command({operation:'reminder',id,status:'cancelled'});release();await ticking
  assert.equal((await vault.read()).short.messages.length,0)
  let abortObserved=false,entered
  const observed=new Promise(r=>entered=r),locked=create({complete:({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>{abortObserved=true;reject(new Error('aborted'))},{once:true})})})
  await vault.transaction(s=>{companionOf(s).reminders[0].status='pending'});await locked.start();const pending=locked.tick();await observed;await locked.stop();await pending
  assert.equal(abortObserved,true);assert.equal((await vault.read()).short.messages.length,0)
})

test('foreground work prevents heartbeat API and leases; stale leases recover within bounds',async t=>{
  const {vault,create}=await fixture(t);let calls=0
  await vault.transaction(s=>{const row=source('今天中午交材料');rememberReminders(s,{reminders:[reminder(row)]},[row])})
  const r=create({isForegroundBusy:()=>true,complete:async()=>{calls++;return '{}'}});await r.start();await r.tick();assert.equal(calls,0)
  const state=await vault.read(),item=companionOf(state).reminders[0];item.status='claimed';item.lease={until:now-1};assert.equal(dueReminders(state,now).length,1)
  item.attempts=3;assert.equal(dueReminders(state,now).length,0)
})

test('task dispatch is deduplicated, carries only explicit text, and persists visible native replies',async t=>{
  const {vault,create}=await fixture(t);let request,calls=0
  const r=create({services:{workspaceTasks:{start:async req=>{request=req;calls++;req.onMessage({role:'assistant',text:'PPT 已完成',time:now});return {promise:Promise.resolve({status:'done'})}}}}})
  await r.start();await vault.transaction(s=>{companionOf(s).privatePersona='PRIVATE_PERSONA_CANARY';s.permanent.entries.push({text:'PRIVATE_MEMORY_CANARY'})})
  const task=await r.dispatchTask('帮我制作PPT','chat','request-1');await Promise.all([...r.work.values()].map(w=>w.promise));await r.dispatchTask('帮我制作PPT','chat','request-1')
  assert.equal(calls,1);assert.equal(request.text,'帮我制作PPT');assert.doesNotMatch(JSON.stringify(request),/PRIVATE_/)
  const saved=companionOf(await vault.read()).tasks.find(t=>t.id===task.id);assert.equal(saved.status,'done');assert.equal(saved.messages[1].text,'PPT 已完成')
  const delivered=(await vault.read()).short.messages;assert.equal(delivered.length,1);assert.equal(delivered[0].taskId,task.id);assert.match(delivered[0].text,/PPT 已完成/);assert.doesNotMatch(delivered[0].text,/PRIVATE_/)
  const user=await vault.transaction(s=>appendBubble(vault,s,'chat','user','今天挺开心'))
  await assert.rejects(r.tool('delegate_workspace_task',{quote:'帮我制作PPT'},await vault.read(),{userId:user.id,chatId:'chat',id:'job'}),/明确委托/)
  const negative=await vault.transaction(s=>appendBubble(vault,s,'chat','user','不要帮我制作PPT'))
  await assert.rejects(r.tool('delegate_workspace_task',{quote:'帮我制作PPT'},await vault.read(),{userId:negative.id,chatId:'chat',id:'no'}),/明确委托/)
  await assert.rejects(r.tool('delegate_workspace_task',{quote:negative.text},await vault.read(),{userId:negative.id,chatId:'chat',id:'no'}),/明确委托/)
  await r.stop();await assert.rejects(r.dispatchTask('帮我制作PPT','chat','after-lock'),/锁定/)
})

test('direct reminder tools persist once; background extraction cannot duplicate a saved request',()=>{
  const s=source('一分钟后提醒我交材料'),state=stateOf([s]),args=reminderArgs(s)
  const saved=createReminder(state,args,s,now)
  assert.equal(saved.ok,true);assert.equal(saved.delivery,'active');assert.equal(saved.kind,'requested')
  assert.equal(createReminder(state,args,s,now).id,saved.id)
  rememberReminders(state,{reminders:[{...reminder(s),quote:'提醒我交材料',dueAt:args.dueAt}]},[s])
  assert.equal(companionOf(state).reminders.length,1)
  assert.equal(listReminders(state,{query:'材料'}).items[0].id,saved.id)
  assert.equal(listReminders(state,{query:'不存在'}).total,0)
  for(const bad of [{...args,dueAt:'2026-10-30T13:00:00'},{...args,dueAt:new Date(now-1).toISOString()},{...args,quote:'用户没说过'}])assert.throws(()=>createReminder(state,bad,s,now))
  for(const text of ['如果明天下雨，提醒我带伞','不用提醒我了']){const row=source(text);assert.throws(()=>createReminder(state,reminderArgs(row),row,now),/确认含义/)}
  companionOf(state).policy.enabled=false
  assert.throws(()=>createReminder(state,args,s,now),/已关闭/);assert.equal(listReminders(state).enabled,false)
})
test('reminder mutations require current explicit evidence and invalidate in-flight deliveries',()=>{
  const s=source('一分钟后提醒我交材料'),state=stateOf([s]),id=createReminder(state,reminderArgs(s),s,now).id,c=companionOf(state),r=c.reminders[0]
  r.status='claimed';r.lease={id:'old',until:now+120000}
  const change=source('改到半小时后提醒我'),args={id,operation:'reschedule',dueAt:new Date(now+1800000).toISOString(),quote:change.text}
  assert.equal(updateReminder(state,args,change,now).status,'pending');assert.equal(r.lease,undefined)
  assert.equal(updateReminder(state,args,change,now).id,id);assert.equal(r.operations.length,1)
  for(const [operation,text]of [['cancel','别取消提醒'],['complete','我还没做完'],['reschedule','如果改到明天呢']]){
    const row=source(text);assert.throws(()=>updateReminder(state,{...args,operation,quote:row.text},row,now),/明确/)
    assert.equal(r.status,'pending')
  }
  const cancel=source('取消交材料的提醒');updateReminder(state,{id,operation:'cancel',quote:cancel.text},cancel,now)
  assert.equal(listReminders(state).total,0);assert.equal(listReminders(state,{includeFinished:true}).items[0].status,'cancelled')
  const newChange=source(change.text);assert.throws(()=>updateReminder(state,args,newChange,now),/已经结束/)
})
test('agreed reminders bypass casual care limits but always respect the master switch',()=>{
  const s=source('一分钟后提醒我交材料'),state=stateOf([s]),c=companionOf(state)
  createReminder(state,reminderArgs(s),s,now);c.policy={...c.policy,quietStart:'00:00',quietEnd:'23:59',dailyLimit:0};c.lastDelivery=now;c.deliveryDay=deliveryDay(c.policy,now);c.deliveries=20
  assert.equal(dueReminders(state,now+60001).length,1)
  assert.equal(nextReminderDelay(state,now+60001,true),5000)
  assert.equal(nextReminderDelay(state,now+60001,false),1000)
  c.policy.enabled=false;assert.equal(dueReminders(state,now+60001).length,0)
  c.policy.enabled=true;c.reminders[0].mode='inferred';assert.equal(dueReminders(state,now+60001).length,0)
})
test('settings project only their own data; partial saves preserve other policy fields',async t=>{
  const {vault,create}=await fixture(t),r=create();await r.start()
  await vault.transaction(s=>{const c=companionOf(s);c.privateEvent='PRIVATE_EVENT';c.reminders.push({title:'PRIVATE_REMINDER'});c.tasks.push({id:'task',text:'工作',status:'done',messages:[],cwd:'PRIVATE_PATH',runtimeId:'PRIVATE_RUNTIME'})})
  const care=await r.command({operation:'view',section:'care'}),persona=await r.command({operation:'view',section:'privacy'})
  assert.deepEqual(Object.keys(care.policy).sort(),['enabled','quietEnd','quietStart','timeZone'])
  assert.doesNotMatch(JSON.stringify([care,persona]),/PRIVATE_|intervalMinutes|dailyLimit/)
  assert.doesNotMatch(JSON.stringify(await r.command({operation:'view',section:'tasks'})),/PRIVATE_PATH|PRIVATE_RUNTIME/)
  await r.command({operation:'savePolicy',policy:{allowTasks:false}});await r.command({operation:'savePolicy',policy:{enabled:false}})
  const p=companionOf(await vault.read()).policy;assert.equal(p.allowTasks,false);assert.equal(p.enabled,false);assert.equal(p.analysisEnabled,true)
  assert.deepEqual(r.tools(await vault.read()).map(t=>t.name),['reminder_create','reminder_list','reminder_update'])
  const input=await vault.transaction(s=>appendBubble(vault,s,'chat','user','一分钟后提醒我交材料'))
  const result=await r.tool('reminder_create',reminderArgs(input),await vault.read(),{userId:input.id})
  assert.equal(result.ok,false);assert.equal(result.code,'reminders_disabled')
  await r.stop();assert.equal((await r.tool('reminder_list',{},null,{})).code,'locked')
})
test('busy foreground retries due reminders promptly; concurrent scheduling leaves one timer',async t=>{
  const {vault,create}=await fixture(t);let busy=true,calls=0,time=now;const timers=new Set()
  const r=create({now:()=>time,isForegroundBusy:()=>busy,complete:async()=>{calls++;return '{"text":"记得交材料。"}'},setTimer:(fn,delay)=>{const timer={fn,delay,unref(){}};timers.add(timer);return timer},clearTimer:timer=>timers.delete(timer)})
  const s=source('一分钟后提醒我交材料');await vault.transaction(state=>createReminder(state,reminderArgs(s),s,now));time+=60001
  await r.start();assert.equal([...timers][0].delay,5000);await r.tick();assert.equal(calls,0)
  busy=false;await Promise.all([r.schedule(),r.schedule()]);assert.equal(timers.size,1);assert.equal([...timers][0].delay,1000)
  await r.tick();await r.tick();assert.equal(calls,1)
  const saved=await vault.read();assert.equal(companionOf(saved).reminders[0].status,'sent');assert.equal(saved.short.messages.length,1)
  await r.stop();assert.equal(timers.size,0)
})
test('native Dot reply confirms only after saved tool receipt and never exposes reminder metadata',async t=>{
  const {root}=await fixture(t);let host,turn=0,receipt
  const text='明天上午九点提醒我交材料',dueAt=new Date(Date.now()+86400000).toISOString()
  const services={defaultModel:{currentSelection:()=>({provider:'test',model:'model'})},llm:{prepareCall:async config=>({config,context:{contextWindow:512000},stream:async function*(options){
    let block
    if(turn++===0){
      assert.ok(options.tools.some(t=>t.name==='reminder_create'));assert.ok(!options.tools.some(t=>t.name==='delegate_workspace_task'))
      assert.match(typeof options.system==='string'?options.system:JSON.stringify(options.system),/主动提醒能力|reminder_create/)
      block={type:'tool-call',id:'save-reminder',name:'reminder_create',arguments:JSON.stringify({title:'交材料',dueAt,quote:text})}
    }else{
      receipt=JSON.parse(options.messages.findLast(m=>m.role==='tool').content[0].text)
      assert.equal(receipt.ok,true);assert.equal(companionOf(await host.vault.read()).reminders[0].id,receipt.id)
      block={type:'tool-call',id:'reply',name:'finish_reply',arguments:JSON.stringify({text:'好，到时我叫你。',expression:'agree'})}
    }
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }})}}
  host=new DotHost(services,{pointer:path.join(root,'reminder-pointer.json')});t.after(()=>host.dispose())
  const open=await host.command({action:'setup',workspace:path.join(root,'reminder-host'),plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{autoPermanent:false,autoLearn:false,autoProfile:false}})
  assert.equal(open.ok,true);const call=async(action,args={})=>{const result=await host.command({action,token:open.value.token,...args});assert.equal(result.ok,true,JSON.stringify(result));return result.value}
  await call('extension',{request:{operation:'savePolicy',policy:{analysisEnabled:false}}})
  const chat=await call('createChat');await call('send',{chatId:chat.id,text,requestId:randomUUID()});await Promise.all([...host.engine.jobs.values()].map(j=>j.promise))
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(turn,2);assert.equal(snapshot.messages.at(-1).text,'好，到时我叫你。')
  assert.doesNotMatch(JSON.stringify(snapshot),/reminder_create|save-reminder|dueAt|internalSteps/)
  assert.ok(!JSON.stringify(snapshot).includes(receipt.id));assert.equal(snapshot.messages.at(-1).presentation.expression,'agree')
})
test('casual care is evidence-backed, deduplicated and requires no private persona',()=>{
  const s=source(),state=stateOf([s]),candidate={sourceId:s.id,quote:s.text,subject:'user',temporalScope:'current',confidence:.95}
  rememberCare(state,{care:[candidate,candidate,{...candidate,quote:'不存在'}]},[s])
  assert.equal(companionOf(state).reminders.length,1)
  assert.equal(companionOf(state).reminders[0].dueAt,s.time+6*3600000)
  assert.equal(companionOf(state).card,undefined)
  for(const item of [{...candidate,temporalScope:'past'},{...candidate,subject:'story'},{...candidate,confidence:.3}]){
    const other=stateOf([s]);rememberCare(other,{care:[item]},[s]);assert.equal(companionOf(other).reminders.length,0)
  }
  const no=source('不要再问今天的事情');rememberCare(state,{care:[{...candidate,sourceId:no.id,quote:no.text}]},[no])
  assert.equal(companionOf(state).reminders.length,1)
  const disabled=stateOf([s]);companionOf(disabled).policy.analysisEnabled=false
  rememberCare(disabled,{care:[candidate]},[s]);assert.equal(companionOf(disabled).reminders.length,0)
})

test('community runtime is present without private files; persona and monitor are not implicitly published',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-default-')),host=new DotHost({},{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:path.join(root,'workspace'),plaintext:true,plaintextAcknowledgement:'明文没有密码保护'})
  assert.equal(open.ok,true,JSON.stringify(open));assert.ok(host.engine.extension instanceof Companion)
  const token=open.value.token
  const result=await host.command({action:'createChat',token});assert.equal(result.ok,true)
  const snap=await host.command({action:'snapshot',token,chatId:result.value.id})
  assert.equal(snap.value.extensionAvailable,true);assert.equal(snap.value.personaAvailable,false)
  assert.ok(host.engine.research);assert.equal(host.engine.research.command,undefined)
  const tools=host.engine.extension.tools(await host.vault.read()).map(t=>t.name)
  assert.ok(tools.includes('reminder_create'));assert.ok(!tools.includes('delegate_workspace_task'))
  for(const request of [{operation:'view',section:'persona'},{action:'monitorMode',enabled:true}]){
    assert.equal((await host.command({action:'extension',token,request})).ok,false)
  }
})
