import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'

const password='identity-test-password',otherPassword='other-test-password'
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function services(handler){return {extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{
  listProviders:()=>[{id:'test'}],listModels:async()=>[{id:'test'}],async prepareCall(config){return {config,context:{contextWindow:512000},stream:async function*(options){
    const text=options.purpose?'{}':handler?await handler(options):'来自同一个角色的回复。'
    yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
  }}}
}}}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-identities-')),pointer=path.join(root,'pointer.json'),workspace=path.join(root,'workspace')
  let now=Date.now()
  const api=new DotHost(services(options.handler),{pointer,now:()=>now})
  t.after(async()=>{await api.dispose();await fs.rm(root,{recursive:true,force:true})})
  const call=async(action,data={})=>{const result=await api.command({action,...data});assert.equal(result.ok,true,JSON.stringify(result));return result.value}
  const first=await call('setup',{workspace,password,settings:{name:'安静',persona:'温柔，简短，耐心。'},sessionMode:options.mode||'run'})
  return {api,call,first,pointer,workspace,advance:ms=>{now+=ms},clock:()=>now}
}
const using=(call,token)=>(action,data={})=>call(action,{token,...data})

test('owner resume keeps an encrypted identity and absolute deadline; no password or bearer credential persists',async t=>{
  const {api,call,first,pointer,advance}=await fixture(t,{mode:'8h'}),run=using(call,first.token)
  const chat=await run('createChat',{title:'连续聊天'}),deadline=first.session.expiresAt,key=Buffer.from(api.vault.key)
  advance(3600000)
  const resumed=await call('resume')
  assert.notEqual(resumed.token,first.token);assert.equal(resumed.identityId,first.identityId);assert.equal(resumed.session.expiresAt,deadline)
  assert.equal((await using(call,resumed.token)('snapshot')).chats[0].id,chat.id)
  const metadata=(await fs.readFile(pointer,'utf8'))+(await fs.readFile(api.identities.file,'utf8'))
  for(const secret of [password,first.token,resumed.token,key.toString('hex'),key.toString('base64'),'温柔，简短，耐心。'])assert.ok(!metadata.includes(secret))
  advance(7*3600000)
  assert.equal((await api.command({action:'snapshot',token:first.token})).error.code,'locked')
  assert.equal((await api.command({action:'resume'})).error.code,'locked')
  assert.equal(api.vault,null);assert.equal(api.engine,null)
})

test('expired leases stop in the background and policy changes cannot silently extend an unlock',async t=>{
  const {api,call,first,advance,clock}=await fixture(t,{mode:'8h'}),run=using(call,first.token),deadline=first.session.expiresAt
  advance(3600000)
  assert.equal((await run('sessionPolicy',{mode:'24h'})).expiresAt,deadline)
  assert.equal((await run('sessionPolicy',{mode:'run'})).expiresAt,deadline)
  const reopened=await call('unlock',{password,sessionMode:'24h'})
  assert.equal(reopened.session.expiresAt,clock()+24*3600000)
  // Exercise the actual timer rather than calling expire() directly.
  const key=api.vault.key
  api.access.expiresAt=clock()+15;api.identities.schedule(api)
  // A wall-clock correction may make a timer fire before its deadline.
  // It must re-arm instead of losing expiry enforcement entirely.
  await new Promise(r=>setTimeout(r,30));assert.ok(api.vault);advance(16)
  await new Promise(r=>setTimeout(r,60));await api.identities.control
  assert.equal(api.vault,null);assert.ok(key.every(value=>value===0));assert.equal(api.tokens.size,0)
})

test('independent identities hot-switch without crossing chats, personality or preferences',async t=>{
  const {api,call,first}=await fixture(t),a=using(call,first.token)
  const chatA=await a('createChat',{title:'A 的聊天'})
  await a('profile',{profile:{preferredName:'A的昵称'}})
  const second=await a('identityCreate',{name:'活泼',persona:'喜欢玩梗，表达活泼。',password:otherPassword}),b=using(call,second.token)
  assert.notEqual(first.identityId,second.identityId);assert.notEqual(first.workspace,second.workspace)
  const snapshotB=await b('snapshot')
  assert.deepEqual(snapshotB.chats,[]);assert.equal(snapshotB.settings.name,'活泼');assert.equal(snapshotB.settings.persona,'喜欢玩梗，表达活泼。')
  assert.doesNotMatch(JSON.stringify(snapshotB),/A的昵称/)
  assert.deepEqual((await b('snapshot',{chatId:chatA.id})).messages,[])
  const chatB=await b('createChat',{title:'B 的聊天'})
  const back=await b('identitySwitch',{identityId:first.identityId}),again=using(call,back.token)
  const snapshotA=await again('snapshot')
  assert.equal(snapshotA.chats[0].id,chatA.id);assert.equal(snapshotA.settings.name,'安静');assert.equal(snapshotA.settings.persona,'温柔，简短，耐心。')
  assert.ok(!snapshotA.chats.some(c=>c.id===chatB.id));assert.doesNotMatch(JSON.stringify(snapshotA),/B 的聊天|喜欢玩梗/)
  await b('settings',{settings:{name:'新名字'}})
  assert.equal((await again('identities')).items.find(item=>item.id===second.identityId).name,'新名字')
})

test('background reply stays with the originating identity while another identity is active',{timeout:15000},async t=>{
  const started=deferred(),finish=deferred()
  const {api,call,first}=await fixture(t,{handler:async()=>{started.resolve();await finish.promise;return '只属于 A 的结果。'}}),a=using(call,first.token)
  t.after(()=>finish.resolve())
  const chat=await a('createChat',{})
  await a('send',{chatId:chat.id,text:'帮我完成后台工作',requestId:randomUUID()});await started.promise
  const second=await a('identityCreate',{name:'B',password:otherPassword}),b=using(call,second.token)
  assert.equal((await a('snapshot',{chatId:chat.id})).jobs.at(-1).status,'running')
  finish.resolve();await Promise.all([...api.engine.jobs.values()].map(job=>job.promise))
  assert.equal((await a('snapshot',{chatId:chat.id})).messages.at(-1).text,'只属于 A 的结果。')
  const other=await b('snapshot',{chatId:chat.id});assert.deepEqual(other.messages,[]);assert.deepEqual(other.jobs,[])
})

test('manual lock revokes every identity; host restart cannot resume; failed target unlock keeps current data intact',async t=>{
  const {api,call,first,pointer}=await fixture(t),a=using(call,first.token)
  const second=await a('identityCreate',{name:'B',password:otherPassword}),b=using(call,second.token)
  const keys=[api.vault.key,api.identities.runtime(second.workspace).vault.key]
  await b('lock')
  for(const token of [first.token,second.token])assert.equal((await api.command({action:'snapshot',token})).error.code,'locked')
  for(const identityId of [first.identityId,second.identityId])assert.equal((await api.command({action:'resume',identityId})).error.code,'locked')
  assert.ok(keys.every(key=>key.every(value=>value===0)))
  const opened=await call('unlock',{workspace:first.workspace,password}),current=using(call,opened.token)
  const before=await fs.readFile(pointer,'utf8')
  assert.equal((await api.command({action:'identitySwitch',token:opened.token,identityId:second.identityId,password:'incorrect-password'})).ok,false)
  assert.equal(await fs.readFile(pointer,'utf8'),before);assert.equal((await current('snapshot')).settings.name,'安静')
  await api.dispose()
  const restarted=new DotHost(services(),{pointer});t.after(()=>restarted.dispose())
  assert.equal((await restarted.command({action:'resume'})).error.code,'locked')
  const restored=await restarted.command({action:'unlock',workspace:second.workspace,password:otherPassword})
  assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.value.identityId,second.identityId)
})

test('lock waits for a racing identity creation and late private responses are rejected',async t=>{
  const {api,call,first}=await fixture(t),entered=deferred(),release=deferred(),snapshot=api.snapshot.bind(api)
  api.snapshot=async request=>{const result=await snapshot(request);entered.resolve();await release.promise;return result}
  const late=api.command({action:'snapshot',token:first.token});await entered.promise
  const creating=api.command({action:'identityCreate',token:first.token,name:'B',password:otherPassword})
  const locking=api.command({action:'lock',token:first.token})
  assert.equal((await creating).ok,true);assert.equal((await locking).ok,true)
  release.resolve();assert.equal((await late).error.code,'locked')
  assert.ok([...api.identities.runtimes.values()].every(runtime=>!runtime.vault&&!runtime.tokens.size))
})

test('corrupt identity catalog is preserved and prevents creation instead of overwriting user data',async t=>{
  const {api,first}=await fixture(t)
  const corrupt='{"version":1,"items":[],"baseWorkspace":"../unsafe"}'
  await fs.writeFile(api.identities.file,corrupt)
  const result=await api.command({action:'identityCreate',token:first.token,name:'B',password:otherPassword})
  assert.equal(result.ok,false);assert.equal(await fs.readFile(api.identities.file,'utf8'),corrupt)
  assert.equal(api.vault.meta.id,first.identityId)
})

test('an extension shutdown failure cannot leave decryption keys resident after an explicit lock',async t=>{
  const {api,call,first}=await fixture(t),key=api.vault.key
  api.engine.shutdown=async()=>{throw new Error('synthetic extension shutdown failure')}
  await call('lock',{token:first.token})
  assert.equal(api.vault,null);assert.equal(api.engine,null);assert.ok(key.every(value=>value===0))
  assert.equal((await api.command({action:'resume'})).error.code,'locked')
})
