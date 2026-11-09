import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {discoverTools,capabilityContext} from '../src/capabilities.js'
import {biliAvailable,availableBiliTools,readBili,executeBiliTool,checkBiliConnection} from '../src/bili.js'
import {DotHost} from '../src/host.js'
import {DotEngine} from '../src/engine.js'

const schema=name=>({name,description:'Registered '+name,parameters:{type:'object',properties:{query:{type:'string'}},additionalProperties:false}})
function registry(rows){return {schemas:()=>rows,get:name=>rows.find(t=>t.name===name),execute:async()=>{throw new Error('Discovery must not execute tools')}}}

test('discovery enumerates every registered interface by pages without executing or copying private fields',()=>{
  const rows=Array.from({length:83},(_,i)=>({...schema('office_'+String(i).padStart(3,'0')),execute:()=>{},output:{secret:'private-renderer'}}))
  const services={tools:registry(rows),workspaceTasks:{}}
  const found=[];let offset=0
  do {const r=discoverTools(services,{offset,limit:30});found.push(...r.items);offset=r.nextOffset}while(offset!==null)
  assert.equal(found.length,83);assert.equal(new Set(found.map(t=>t.name)).size,83)
  assert.ok(found.every(t=>t.execution==='delegate_workspace_task'))
  assert.doesNotMatch(JSON.stringify(found),/private-renderer|parameters/)
  const detail=discoverTools(services,{names:['office_001','missing']})
  assert.deepEqual(detail.items[0].parameters,rows[1].parameters);assert.deepEqual(detail.missing,['missing'])
  detail.items[0].parameters.properties.query.type='number'
  assert.equal(rows[1].parameters.properties.query.type,'string')
  assert.throws(()=>discoverTools(services,{limit:500}),/分页/)
})

test('unready registries differ from empty ones and hot registration is visible immediately',()=>{
  assert.equal(discoverTools({}).registryReady,false)
  const rows=[],services={tools:registry(rows)}
  assert.equal(discoverTools(services).registryReady,true);assert.equal(discoverTools(services).total,0)
  rows.push(schema('bili_search'));assert.equal(discoverTools(services,{query:'B站'}).matched,1)
  assert.match(capabilityContext(services),/bili_search/)
  rows.length=0;assert.equal(discoverTools(services,{query:'B站'}).matched,0)
  assert.doesNotMatch(capabilityContext(services),/bili_search/)
  services.tools.schemas=()=>{throw new Error('disposed')};assert.equal(discoverTools(services).registryReady,false)
})

test('large schemas remain bounded and unknown names are never invented',()=>{
  const rows=[{...schema('huge'),parameters:{description:'x'.repeat(30000)}}]
  const detail=discoverTools({tools:registry(rows)},{names:['huge','no_such_tool']})
  assert.equal(detail.items[0].parametersOmitted,'schema_too_large_use_host_agent')
  assert.deepEqual(detail.missing,['no_such_tool']);assert.ok(JSON.stringify(detail).length<3000)
})

test('Bili connection distinguishes missing plugin, missing credentials, verified login and failed verification without exposing account data',async()=>{
  const rows=['bili_search','bili_status','bili_whoami','bili_login_start','bili_login_poll'].map(schema),calls=[]
  let credential=false,logged=true,broken=false
  const services={tools:{...registry(rows),execute:async({name})=>{calls.push(name);if(broken)throw new Error('timeout');return {value:name==='bili_status'?{loggedIn:credential,home:'private-path'}:{ok:true,raw:JSON.stringify({logged_in:logged,username:'private-user',sessdata:'private-cookie'})}}}}}
  assert.equal((await checkBiliConnection({tools:registry([])})).state,'plugin_missing')
  assert.equal((await checkBiliConnection({})).state,'unavailable')
  let info=await checkBiliConnection(services)
  assert.equal(info.state,'needs_login');assert.equal(info.loginProvider,'scroll');assert.deepEqual(calls,['bili_status'])
  credential=true;info=await checkBiliConnection(services)
  assert.equal(info.state,'connected');assert.equal(info.credentialPresent,true)
  assert.doesNotMatch(JSON.stringify(info),/private-path|private-user|private-cookie/)
  logged=false;assert.equal((await checkBiliConnection(services)).state,'unknown','a plugin network failure is not proof of expired login')
  broken=true;assert.equal((await checkBiliConnection(services)).state,'unknown')
  calls.length=0;await checkBiliConnection(services,{verify:false});assert.equal(calls.length,0)
})

test('connection tool produces a local login card with no QR keys or plugin diagnostics in message history',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-connection-'));let step=0
  const services={tools:registry([]),extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(options){
    const block=options.purpose?{type:'text',text:'{}'}:step++===0?{type:'tool-call',id:'connection',name:'check_bilibili_connection',arguments:'{}'}:{type:'text',text:'连接入口已经放在这里了。'}
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const setup=await host.command({action:'setup',workspace:root,plaintext:true,plaintextAcknowledgement:'明文没有密码保护'})
  const token=setup.value.token,call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true);return r.value}
  assert.equal((await call('biliConnection')).state,'plugin_missing')
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,requestId:randomUUID(),text:'检查 B站连接'})
  await host.engine.jobs.get(job.id)?.promise
  const {messages}=await call('snapshot',{chatId:chat.id})
  assert.equal(messages.filter(m=>m.connection==='bilibili').length,1)
  assert.doesNotMatch(messages.map(m=>m.text).join('\n'),/check_bilibili_connection|plugin_missing|qr|key|parameters/)
})

test('Bili scroll interfaces are discovered and executed through the host pipeline; login and mutations stay out of research',async()=>{
  const rows=['bili_subtitle','bili_search','bili_recommend','bili_login_start','bili_reply','bili_send_message'].map(schema),calls=[]
  const services={tools:{...registry(rows),execute:async input=>{calls.push(input);return {isError:false,content:[{type:'text',text:'verified subtitle'}]}}}}
  assert.equal(biliAvailable(services),true)
  assert.deepEqual(availableBiliTools(services).map(t=>t.name).sort(),['bili_recommend','bili_search','bili_subtitle','read_bilibili_video'])
  const result=await readBili(services,{bv:'BV1xx411c7mD'})
  assert.equal(calls[0].name,'bili_subtitle');assert.deepEqual(calls[0].arguments,{bvid:'BV1xx411c7mD'});assert.match(result.content,/verified/)
  await executeBiliTool(services,'bili_search',{query:'test'})
  assert.equal(calls[1].name,'bili_search');assert.ok(calls[1].signal instanceof AbortSignal)
  await assert.rejects(()=>executeBiliTool(services,'bili_reply',{}),/不可用/)
  await assert.rejects(()=>readBili(services,{bv:'BV1xx411c7mD',p:2}),/分 P/)
  assert.deepEqual(availableBiliTools(services,{companionActive:true}),[])
  await assert.rejects(()=>executeBiliTool(services,'bili_search',{},undefined,{companionActive:true}),/陪看/)
  rows.length=0;assert.equal(biliAvailable(services),false)
  await assert.rejects(()=>executeBiliTool(services,'bili_search',{}),/不可用/)
  assert.equal(calls.length,2)
})

test('watch exposes the full reading chain, blocks destructive commands and recognizes logical plugin failures',async()=>{
  const rows=[{name:'bili_watch',parameters:{type:'object',properties:{command:{type:'string'},bv:{type:'string'},out:{type:'string'}},required:['command']}}],calls=[]
  let fail=false,notice=false
  const services={tools:{...registry(rows),execute:async r=>{calls.push(r);return {value:{ok:!fail,text:notice?'（全文 8000 字，超限，JSON 已整体落盘；已存：fixture.tool.txt）':fail?'dependency missing':'verified transcript'},content:[{type:'text',text:fail?'dependency missing':'verified transcript'}]}}}}
  const tool=availableBiliTools(services).find(t=>t.name==='bili_watch')
  assert.ok(tool.parameters.properties.command.enum.includes('asr'));assert.equal(tool.parameters.properties.out,undefined)
  await executeBiliTool(services,'bili_watch',{command:'comments',bv:'BV1xx411c7mD'})
  assert.equal(calls[0].arguments.full,true)
  await assert.rejects(()=>executeBiliTool(services,'bili_watch',{command:'clean'}),/只允许/)
  await assert.rejects(()=>executeBiliTool(services,'bili_watch',{command:'text',out:'private.txt'}),/只允许/)
  assert.equal((await readBili(services,{bv:'BV1xx411c7mD'})).content,'verified transcript');assert.equal(calls.at(-1).arguments.format,'md')
  fail=true;await assert.rejects(()=>readBili(services,{bv:'BV1xx411c7mD'}),e=>e.code==='bili_read')
  await assert.rejects(()=>executeBiliTool(services,'bili_watch',{command:'text',bv:'BV1xx411c7mD'}),e=>e.code==='bili_read')
  assert.equal(calls.length,4)
  fail=false;notice=true
  await assert.rejects(()=>readBili(services,{bv:'BV1xx411c7mD'}),/缓存路径/)
  await assert.rejects(()=>executeBiliTool(services,'bili_watch',{command:'text',bv:'BV1xx411c7mD'}),/缓存路径/)
})

test('main model can discover tools and continue the same response; internal inventory never becomes a bubble',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-discovery-')),rows=[schema('bili_search')];let step=0
  const services={tools:registry(rows),extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(options){
    let block
    if(options.purpose)block={type:'text',text:'{}'}
    else if(step++===0){
      assert.ok(options.tools.some(t=>t.name==='discover_dsh_tools'));assert.match(options.system,/bili_search/)
      block={type:'tool-call',id:'inspect',name:'discover_dsh_tools',arguments:JSON.stringify({query:'B站'})}
    }else{
      const result=JSON.parse(options.messages.findLast(m=>m.role==='tool').content[0].text)
      assert.equal(result.items[0].name,'bili_search');assert.equal(result.registryReady,true)
      block={type:'text',text:'已经看到 B站搜索工具了。'}
    }
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const before=await host.command({action:'capabilities',query:{query:'B站'}});assert.equal(before.ok,true);assert.equal(before.value.matched,1)
  const setup=await host.command({action:'setup',workspace:root,plaintext:true,plaintextAcknowledgement:'明文没有密码保护'});assert.equal(setup.ok,true)
  const token=setup.value.token,call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,requestId:randomUUID(),text:'能看看 B站插件吗？'})
  await host.engine.jobs.get(job.id)?.promise
  const snapshot=await call('snapshot',{chatId:chat.id})
  assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.equal(snapshot.messages.filter(m=>m.role==='assistant').at(-1).text,'已经看到 B站搜索工具了。')
  assert.doesNotMatch(snapshot.messages.map(m=>m.text).join('\n'),/discover_dsh_tools|bili_search|registryReady|parameters/)
})

test('background research receives new Bili interfaces and rechecks companion and network state at execution',async()=>{
  let ports
  const rows=[schema('bili_search')],services={tools:{...registry(rows),execute:async()=>({content:[{type:'text',text:'a video'}]})},extension:{createExtension:()=>({createResearch:p=>{ports=p;return {}}})}}
  const engine=new DotEngine({},services),state={catalog:{settings:{}}},signal=new AbortController().signal
  assert.ok(ports.availableWebTools().some(t=>t.name==='bili_search'))
  assert.match((await ports.lookup('bili_search',{query:'test'},state,signal)).content,/a video/)
  engine.media={active:true};assert.ok(!ports.availableWebTools().some(t=>t.name==='bili_search'))
  await assert.rejects(()=>ports.lookup('bili_search',{},state,signal),/陪看/)
  engine.media.active=false;state.catalog.settings.webSearch=false
  await assert.rejects(()=>ports.lookup('bili_search',{},state,signal),/联网/)
})
