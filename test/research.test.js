import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {tmpdir} from 'node:os'

const tool=(name,args,id=randomUUID())=>({type:'tool-call',name,id,arguments:JSON.stringify(args)})
const say=text=>[{type:'text',text}]
async function until(fn,message='condition',limit=8000){const end=Date.now()+limit;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+message)}
async function fixture(t,handler){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-research-'))
  const requests=[],services={defaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},stream:async function*(options){requests.push(options);const blocks=await handler(options);for(let i=0;i<blocks.length;i++)yield {type:'block-end',index:i,block:blocks[i]};yield {type:'finish',reason:{kind:'stop'}}}}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:path.join(root,'workspace'),password:'test-password-only',settings:{autoPermanent:false,autoProfile:false,autoLearn:false,persona:'PRIVATE_PERSONA_MARKER，使用温柔语气。'}})
  assert.equal(open.ok,true,JSON.stringify(open));const token=open.value.token
  const call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  await call('extension',{request:{operation:'savePolicy',policy:{analysisEnabled:false}}})
  const chat=await call('createChat')
  const send=async text=>{await call('send',{chatId:chat.id,text,requestId:randomUUID()});await until(async()=>!(await host.vault.read()).catalog.jobs.some(j=>j.kind!=='continuation'&&j.status==='running'),'foreground finished')}
  return {host,services,requests,call,chat,send,token,root}
}

test('hidden lookup releases foreground, preserves current persona, and delivers through main agent exactly once',async t=>{
  let turns=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      assert.doesNotMatch(o.system+JSON.stringify(o.messages),/PRIVATE_PERSONA_MARKER|PRIVATE_REASONING/)
      return o.messages.some(m=>m.role==='tool')?say('WORKER_FINDING_ONLY'): [tool('web_search',{query:'public test'})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      assert.match(o.system,/PRIVATE_PERSONA_MARKER/);assert.match(JSON.stringify(o.messages),/我现在更关心温柔的交流/)
      return [tool('finish_reply',{text:'好，我把刚才那件事核对好了。',expression:'happy'})]
    }
    if(++turns===1)return [{type:'reasoning',text:'PRIVATE_REASONING'},tool('background_research',{objective:'public test',domain:'web',reply:'好，我看看。',expression:'agree'})]
    return say('嗯，我在听。')
  })
  f.services.web={search:async(q,options)=>{started=true;await new Promise(resolve=>{release=resolve});return {sources:[{url:'https://example.org/test',title:'测试资料',snippet:'EVIDENCE_ONLY'}]}}}
  await f.send('帮我核对公开资料');await until(()=>started)
  let snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.backgroundPhase,'searching');assert.equal(snapshot.jobs.at(-1).status,'done')
  await f.send('我现在更关心温柔的交流')
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.at(-1).text,'嗯，我在听。')
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_REASONING|backgroundResearch|objective|WORKER_FINDING_ONLY|EVIDENCE_ONLY/)
  release()
  await until(async()=> (await f.call('snapshot',{chatId:f.chat.id})).messages.some(m=>m.text==='好，我把刚才那件事核对好了。'),'result delivery')
  await f.host.engine.research.pump();await f.host.engine.research.pump()
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.filter(m=>m.text==='好，我把刚才那件事核对好了。').length,1)
  assert.equal(snapshot.presentationEvents.at(-1).expression,'happy')
  assert.equal((await f.host.command({action:'extension',token:f.token,request:{action:'monitorSnapshot'}})).ok,false)
  assert.equal((await f.host.command({action:'extension',token:'a'.repeat(64),request:{action:'monitorMode',enabled:true}})).ok,false)
})

test('installed bili tool can run hidden research without a general web service and preserves foreground conversation',async t=>{
  let turns=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      assert.deepEqual(o.tools.map(t=>t.name),['read_bilibili_video','discover_dsh_tools'])
      return o.messages.some(m=>m.role==='tool')?say('BILI_PRIVATE_FINDING'):[tool('read_bilibili_video',{bv:'BV1xx411c7mD'})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]'))return say('这个视频的内容已核对。')
    if(++turns===1)return [tool('background_research',{objective:'读取 BV1xx411c7mD',domain:'web',reply:'我看看这个视频。'})]
    return say('嗯，先聊你现在说的。')
  })
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{assert.equal(request.name,'bili_watch');started=true;await new Promise(r=>{release=r});return {content:[{type:'text',text:'BILI_PRIVATE_EVIDENCE'}]}}}
  await f.send('看看 BV1xx411c7mD');await until(()=>started)
  await f.send('我想先聊别的')
  let snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(snapshot.messages.at(-1).text,'嗯，先聊你现在说的。');assert.doesNotMatch(JSON.stringify(snapshot),/BILI_PRIVATE/)
  release();await until(async()=>(await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  const state=await f.host.vault.read();assert.match(state.catalog.backgroundResearch[0].result.sources[0].url,/bilibili.com\/video\/BV1xx411c7mD/)
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.at(-1).text,'这个视频的内容已核对。');assert.doesNotMatch(JSON.stringify(snapshot),/BILI_PRIVATE/)
})

test('updated task discards old results; cancelling prevents late delivery and cross-chat control',async t=>{
  let taskId,turn=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return [tool('web_search',{query:'old query'})]
    if(++turn===1)return [tool('background_research',{objective:'old objective',domain:'web'})]
    return say('好。')
  })
  f.services.web={search:async()=>{started=true;await new Promise(r=>{release=r});return {sources:[{url:'https://example.org/old',title:'OLD',snippet:'OLD'}]}}}
  await f.send('请查公开资料');await until(()=>started)
  taskId=(await f.host.vault.read()).catalog.backgroundResearch[0].id
  const job={id:randomUUID(),userId:randomUUID(),chatId:f.chat.id}
  await assert.rejects(f.host.engine.research.tool('cancel_research',{taskId},{...job,chatId:randomUUID()},'x'))
  await f.host.engine.research.tool('update_research',{taskId,objective:'new objective'},job,'update')
  await f.host.engine.research.tool('cancel_research',{taskId},job,'cancel')
  release();await Promise.allSettled([...f.host.engine.research.runs.values()].map(r=>r.promise))
  await f.host.engine.research.pump()
  const state=await f.host.vault.read(),task=state.catalog.backgroundResearch[0]
  assert.equal(task.status,'cancelled');assert.equal(task.objective,'new objective');assert.equal(task.result,null)
  assert.equal((await f.call('snapshot',{chatId:f.chat.id})).messages.length,2)
})

test('tool budget exhaustion keeps evidence; failed worker finalization never blocks foreground or executes non-read tools',async t=>{
  let rounds=0,searches=0,deliveredEvidence=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      rounds++
      if(!o.tools.length)return [tool('delegate_workspace_task',{quote:'must not execute'})]
      return [tool('web_search',{query:'query '+rounds})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){deliveredEvidence=JSON.stringify(o.messages).includes('EVIDENCE_RETAINED');return say('[dot-reply:uncertain]\n已经找到一部分依据，其他部分还不能确认。')}
    return [tool('background_research',{objective:'核对公开信息',domain:'web'})]
  })
  f.services.web={search:async()=>{searches++;return {sources:[{url:'https://example.org/evidence',title:'EVIDENCE_RETAINED'}]}}}
  await f.send('查询资料')
  await until(async()=> (await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  assert.equal(searches,6);assert.equal(rounds,7);assert.equal(deliveredEvidence,true)
  const s=await f.call('snapshot',{chatId:f.chat.id});assert.equal(s.messages.at(-1).presentation.expression,'uncertain');assert.doesNotMatch(JSON.stringify(s),/must not execute|internalSteps|这次没能整理/)
})

test('persisted ready result resumes once, stays in originating chat, and locking stops the coordinator',async t=>{
  const f=await fixture(t,o=>o.system.includes('[BACKGROUND_RESULT_DELIVERY]')?say('这是原聊天的查询结果。'):say('好。'))
  const other=await f.call('createChat'),id=randomUUID()
  await f.host.vault.transaction(s=>s.catalog.backgroundResearch=[{id,chatId:f.chat.id,userId:randomUUID(),objective:'公开合成资料',domain:'web',status:'ready',revision:1,createdAt:Date.now(),pid:-1,runtimeId:'old',result:{status:'partial',findings:'合成证据',sources:[],evidence:[]}}])
  await f.host.engine.research.stop();await f.host.engine.research.start()
  await until(async()=> (await f.host.vault.read()).catalog.backgroundResearch[0].status==='delivered')
  assert.equal((await f.call('snapshot',{chatId:other.id})).messages.length,0)
  await f.host.engine.research.stop();await f.host.engine.research.start();await f.host.engine.research.pump()
  assert.equal((await f.call('snapshot',{chatId:f.chat.id})).messages.length,1)
  assert.equal((await f.host.command({action:'extension',token:f.token,request:{action:'monitorSnapshot'}})).ok,false)
  await f.call('lock');assert.equal(f.host.engine,null)
})

test('new user input preempts result synthesis and resumes with the updated conversation',async t=>{
  let delivering=false,syntheses=0,turns=0
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return say('资料已核对。')
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      if(++syntheses===1){delivering=true;await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));return say('STALE_RESULT')}
      assert.match(JSON.stringify(o.messages),/只要一句话/);return say('一句话的结果。')
    }
    if(++turns===1)return [tool('background_research',{objective:'测试',domain:'memory'})]
    return say('好，简短说。')
  })
  await f.send('查一下以前的事情');await until(()=>delivering)
  await f.send('只要一句话')
  await until(async()=> (await f.call('snapshot',{chatId:f.chat.id})).messages.some(m=>m.text==='一句话的结果。'))
  const s=await f.call('snapshot',{chatId:f.chat.id});assert.doesNotMatch(JSON.stringify(s.messages),/STALE_RESULT/)
  assert.equal(s.messages.at(-2).text,'好，简短说。');assert.equal(s.messages.at(-1).text,'一句话的结果。')
})
