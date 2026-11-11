import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {Context,Service} from '@deepseek-ai/cordis'
import vm from 'node:vm'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import {z} from 'zod'
import {createDotRemote} from '../src/protocol.js'
import {apply,DotService} from '../src/host.js'
import {MarkdownText} from './markdown-stub.js'

async function installed(name,entry='index.js') {
  // Resolve declared development dependencies through their public exports.
  // A contributor's standalone checkout does not have the author's pnpm tree.
  return import('@deepseek-ai/'+name+(entry==='client.node.js'?'/client':''))
}
test('built Orivii activates through actual DSH Client Remote and Host Gateway; old src-json contract reproduces boot failure',async()=>{
  const [{default:Registry},{default:Gateway}]=await Promise.all([installed('dsh-typert-registry'),installed('dsh-api-gateway')])
  const ctx=new Context()
  class Dependencies extends Service {
    constructor(ctx){super(ctx,'remoteAccess');this.decide=()=>({kind:'deny',reason:'test-denied'});ctx.provide('llm',{});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'p',model:'m'})})}
  }
  await ctx.plugin(Dependencies);await ctx.plugin(Registry);await ctx.plugin(Gateway,{websocketHeartbeatIntervalMs:2000,streamInboxBytes:262144})
  await ctx.plugin({inject:['typert','llm','agentDefaultModel'],apply})
  try {
    assert.ok(ctx.dotCompanion instanceof DotService)
    assert.ok(ctx.typert.local.get('dotCompanion/command'))
    let queries=0
    ctx.provide('web',{async search({query}){queries++;assert.equal(query,'DeepSeek Harness official documentation');return {sources:[{url:'https://example.org/',title:'公开来源'}]}}})
    await new Promise(resolve=>setTimeout(resolve,0))
    const peer={id:'test-owner',ctx,principal:{kind:'owner'},signal:new AbortController().signal,interactions:'none'}
    const result=await ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action:'status'}},peer})
    assert.equal(result.ok,true);assert.equal(result.value.unlocked,false)
    const online=await ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action:'webCheck'}},peer})
    assert.equal(online.ok,true,JSON.stringify(online));assert.equal(online.value.sources.length,1);assert.equal(queries,1)
    // Run the built plugin against the ACTUAL Client Remote implementation.
    // A direct Host invocation alone never exercises browser mount validation.
    const client=new Context()
    const registrations=[]
    try {
      await client.plugin(Registry)
      client.provide('connection',{interactions:'none',rpc:{open(){throw new Error('Unexpected stream')},
        async call(channel,endpoint,payload,signal){
          assert.equal(channel,'/api')
          const [namespace,method]=endpoint.split('/')
          return {ok:true,value:await ctx.typertGateway.invoke({namespace,method,args:payload.args,signal,peer})}
        },
      }})
      await client.plugin(await installed('dsh-api-gateway','client.node.js'))
      const old=createDotRemote(z)
      old.descriptors[0].parameters[0].codec={mode:'src-json'}
      await assert.rejects(()=>client.remote.$mount(old),/has no strict codec/)
      client.provide('slots',{inject(_name,fn){fn()},register(options,component){registrations.push({options,component});return()=>{}}})
      client.provide('layout',{})
      let plugin
      vm.runInNewContext(await fs.readFile(new URL('../dsh/client.js',import.meta.url),'utf8'),{
        window:{__ModuleLoader__:{load({factory}){plugin=factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-ui-primitives')return {MarkdownText};if(name==='zod')return {z};throw new Error('Unexpected dependency')})}}},
      })
      await client.plugin(plugin)
      assert.equal(registrations.length,2)
      assert.equal(registrations.find(r=>r.options.name==='sidebar.panellist').options.label,'Orivii')
      const throughClient=await client.remote.dotCompanion.command({action:'status'})
      assert.equal(throughClient.ok,true)
      assert.equal(throughClient.value.ok,true)
      assert.equal(throughClient.value.value.unlocked,false)
      const live=await client.remote.dotCompanion.command({action:'liveSettings'})
      assert.equal(live.ok,true,'new settings action must pass the Host boundary')
      assert.equal(live.value.error.code,'locked','only the workspace lock should reject this request')
      for(const action of ['voiceStart','voiceModels','voiceCheck']){const refused=await client.remote.dotCompanion.command({action});assert.ok(refused.ok===false||refused.value?.ok===false,'voice calls are unavailable in this release')}
      for(const request of [{action:'resume'},{action:'identitySwitch',identityId:'12345678-1234-4234-8234-123456789012'},{action:'identityCreate',name:'Test',password:'test-only-password'},{action:'sessionPolicy',mode:'8h'}]){
        const response=await client.remote.dotCompanion.command(request)
        assert.equal(response.ok,true,'identity action must pass both strict gateway contracts');assert.equal(response.value.error.code,'locked')
      }
      assert.equal((await client.remote.dotCompanion.command({action:'identities'})).value.ok,true)
      await assert.rejects(()=>ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action:'unlock',password:'test-only',unexpected:true}},peer}))
      await client.fiber.dispose()
    } finally {await client.fiber.dispose()}
    await assert.rejects(()=>ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action:'status'}},peer:{...peer,principal:{kind:'guest'}}}),/access denied/)
    for(const action of ['resume','identities'])await assert.rejects(()=>ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action}},peer:{...peer,principal:{kind:'guest'}}}),/access denied/)
    await assert.rejects(()=>ctx.typertGateway.invoke({namespace:'dotCompanion',method:'command',args:{request:{action:'status'},unexpected:true},peer}))
  } finally {await ctx.fiber.dispose()}
})

test('strict contract accepts frontend setup, unlock, snapshots, edits and legacy import; rejects unexpected fields',()=>{
  const descriptor=createDotRemote(z).descriptors[0],parse=value=>descriptor.parameters[0].codec.create().parse(value)
  const id='12345678-1234-4234-8234-123456789012'
  for(const value of [
    {action:'status',token:''},
    {action:'status',workspace:'H:\\DotWorkspace'},
    {action:'profile',profile:{preferredName:'亲爱的',identity:'研究生',preferences:'喜欢简短聊天'}},
    {action:'settings',settings:{autoProfile:false}},
    {action:'settings',settings:{autoLearn:false}},
    {action:'liveSettings'},
    {action:'liveSettings',settings:{mediaEnabled:true}},
    {action:'memories',layer:'knowledge'},
    {action:'memories',layer:'memes'},
    {action:'setup',workspace:'H:\\DotWorkspace',password:'test-only-password',plaintext:false},
    {action:'unlock',workspace:'H:\\DotWorkspace',password:'test-only-password'},
    {action:'unlock',workspace:'H:\\DotWorkspace',password:'test-only-password',sessionMode:'24h'},
    {action:'resume',identityId:id},
    {action:'identities'},
    {action:'identitySwitch',identityId:id,password:'test-only-password'},
    {action:'identityCreate',name:'Second',persona:'温柔',password:'test-only-password',sessionMode:'8h'},
    {action:'sessionPolicy',mode:'run'},
    {action:'snapshot',chatId:null},
    {action:'developerMode',enabled:true},
    {action:'developerSnapshot',chatId:id},
    {action:'snapshot',chatId:id,beforeId:id},
    {action:'editMemory',id,text:'经过修订的记忆'},
    {action:'import',legacyId:'old-session',title:'旧对话',messages:[{seq:1,role:'user',time:1,text:'你好'}]},
  ])assert.doesNotThrow(()=>parse(value))
  assert.throws(()=>parse({action:'unknown'}))
  assert.throws(()=>parse({action:'resume',password:'not-accepted'}))
  assert.throws(()=>parse({action:'sessionPolicy',mode:'forever'}))
  assert.throws(()=>parse({action:'developerMode',enabled:'true'}))
  assert.throws(()=>parse({action:'developerSnapshot',includeReasoning:true}))
  assert.throws(()=>parse({action:'status',password:'unexpected'}))
  assert.throws(()=>parse({action:'import',legacyId:'old',messages:[{role:'system',text:'hidden'}]}))
})

test('rendered workspace form uses its injected plugin context for setup, chat, lock and unlock',async()=>{
  const [{default:Registry},{default:Gateway},ClientRemote]=await Promise.all([
    installed('dsh-typert-registry'),installed('dsh-api-gateway'),installed('dsh-api-gateway','client.node.js'),
  ])
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url))
  await fs.mkdir(base,{recursive:true})
  const fixture=await fs.mkdtemp(path.join(base,'dot-ui-test-'))
  const host=new Context(),client=new Context(),registrations=[],calls=[]
  let renderer,delaySnapshot,releaseSnapshot
  try {
    class Dependencies extends Service {
      constructor(ctx){super(ctx,'remoteAccess');this.decide=()=>({kind:'deny'});ctx.provide('llm',{listProviders:()=>[],listModels:async()=>[]});ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'})})}
    }
    await host.plugin(Dependencies);await host.plugin(Registry)
    await host.plugin(Gateway,{websocketHeartbeatIntervalMs:2000,streamInboxBytes:262144})
    await host.plugin({inject:['typert','llm','agentDefaultModel'],apply})
    // Use only this test's workspace and pointer; never the owner's settings.
    host.dotCompanion.host.pointer=path.join(fixture,'pointer.json')
    await fs.writeFile(host.dotCompanion.host.pointer,JSON.stringify({workspace:path.join(fixture,'first-use')}))
    const peer={id:'test-owner',ctx:host,principal:{kind:'owner'},signal:new AbortController().signal,interactions:'none'}
    await client.plugin(Registry)
    client.provide('connection',{interactions:'none',rpc:{open(){throw new Error('Unexpected stream')},
      async call(channel,endpoint,payload,signal){
        assert.equal(channel,'/api');calls.push(payload.args.request.action)
        const [namespace,method]=endpoint.split('/')
        const result={ok:true,value:await host.typertGateway.invoke({namespace,method,args:payload.args,signal,peer})}
        if(delaySnapshot&&payload.args.request.action==='snapshot'){
          const entered=delaySnapshot;delaySnapshot=null
          await new Promise(resolve=>{releaseSnapshot=resolve;entered()})
        }
        return result
      },
    }})
    await client.plugin(ClientRemote)
    let pickerMode='browse',nativePath=null,finishPick
    const pickerCalls=[]
    client.provide('remote.directoryPicker',{
      async list(target,signal){
        assert.ok(signal instanceof AbortSignal);pickerCalls.push('list')
        if(pickerMode==='native')return {ok:false,error:{code:'directory-picker/unavailable',message:'native chooser',details:{capability:'native'}}}
        target=target||fixture
        const dirs=await fs.readdir(target,{withFileTypes:true})
        return {ok:true,value:{path:target,home:fixture,crumbs:[{name:'测试目录',path:fixture,hidden:false}],entries:dirs.filter(d=>d.isDirectory()).map(d=>({name:d.name,path:path.join(target,d.name),hidden:d.name.startsWith('.')})),truncated:false}}
      },
      async createDirectory(parent,name){pickerCalls.push('createDirectory');const target=path.join(parent,name);await fs.mkdir(target);return {ok:true,value:target}},
      async pick(signal){
        assert.ok(signal instanceof AbortSignal);pickerCalls.push('pick')
        if(pickerMode==='browse')return {ok:false,error:{code:'directory-picker/unavailable',message:'browse backend',details:{capability:'browse'}}}
        if(pickerMode==='failure')return {ok:false,error:{code:'gateway/internal',message:'test native failure'}}
        if(pickerMode==='pending')return new Promise(resolve=>{finishPick=resolve})
        return {ok:true,value:nativePath}
      },
    })
    client.provide('slots',{inject(_name,fn){fn()},register(options,component){registrations.push({options,component});return()=>{}}})
    client.provide('layout',{})
    let plugin
    vm.runInNewContext(await fs.readFile(new URL('../dsh/client.js',import.meta.url),'utf8'),{
      window:{__ModuleLoader__:{load({factory}){plugin=factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-ui-primitives')return {MarkdownText};if(name==='zod')return {z};throw new Error('Unexpected dependency')})}}},
      AbortController,setInterval,clearInterval,setTimeout,clearTimeout,crypto,btoa,atob,Blob,
    })
    let fiber=client.plugin(plugin);await fiber
    // Root contexts bypass injection checks. Prove this test exercises a plugin
    // scope, which is where alpha.2 failed on the first effect and button click.
    let missingDependency
    await client.plugin({inject:['remote'],apply(ctx){try{void ctx.remote.dotCompanion}catch(e){missingDependency=e}}})
    assert.match(missingDependency?.message||'',/remote\.dotCompanion.*without inject/)
    let Panel=registrations.find(r=>r.options.name==='main').component
    const visible=node=>{for(let parent=node;parent;parent=parent.parent)if(parent.props.inert!==undefined)return false;return true}
    const find=(type,predicate)=>renderer.root.findAllByType(type).find(node=>visible(node)&&predicate(node))
    const button=label=>find('button',n=>n.props['aria-label']===label)
    const field=label=>find('input',n=>n.props['aria-label']===label)
    async function change(input,value){await act(async()=>{input.props.onChange({target:{value}})})}
    async function click(node){assert.ok(node,'expected control');await act(async()=>{await node.props.onClick()})}
    async function waitFor(predicate){
      const until=Date.now()+10000
      while(!predicate()){
        const errors=renderer.root.findAll(n=>n.props.role==='alert'&&visible(n)).map(n=>n.findAllByType('span').map(s=>s.children.join('')).join(' '))
        assert.deepEqual(errors,[])
        assert.ok(Date.now()<until,'UI did not reach expected state; recent actions: '+calls.slice(-12).join(', '))
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})
      }
      assert.equal(renderer.root.findAll(n=>n.props.role==='alert'&&visible(n)).length,0,'UI must not display an error')
    }
    for(const plaintext of [true,false]) {
      const workspace=path.join(fixture,plaintext?'plain':'encrypted')
      await act(async()=>{renderer=TestRenderer.create(React.createElement(Panel))})
      const submit=()=>find('button',n=>n.props.type==='submit')
      await waitFor(()=>calls.includes('status')&&submit()?.props.disabled===false)
      if(plaintext)assert.equal(submit().children.join(''),'创建工作空间','first use must open creation without a mode switch')
      if(plaintext){
        const original=field('Orivii 工作空间').props.value
        pickerMode='pending'
        let choosing
        await act(async()=>{choosing=button('浏览…').props.onClick();await Promise.resolve()})
        assert.equal(button('浏览…').props.disabled,true)
        assert.equal(renderer.root.findAllByProps({'aria-label':'浏览工作空间目录'}).length,0,'native picker never opens the web listing')
        await click(button('取消选择'))
        await act(async()=>{finishPick({ok:true,value:path.join(fixture,'ignored-late-choice')});await choosing})
        assert.equal(field('Orivii 工作空间').props.value,original,'cancel ignores late native response')
        pickerMode='failure'
        const beforeFailure=pickerCalls.length
        await click(button('浏览…'))
        assert.deepEqual(pickerCalls.slice(beforeFailure),['pick'],'native failure must not silently change backends')
        assert.equal(renderer.root.findAll(n=>n.props.role==='alert').length,1)
        await click(button('关闭提示'))
      }
      pickerMode='native';nativePath=null
      const beforeCancel=field('Orivii 工作空间').props.value
      const beforeNative=pickerCalls.length
      await click(button('浏览…'))
      await waitFor(()=>renderer.root.findAllByProps({'aria-label':'浏览工作空间目录'}).length===0)
      assert.deepEqual(pickerCalls.slice(beforeNative),['pick'],'native selection must be the first and only call')
      assert.equal(field('Orivii 工作空间').props.value,beforeCancel,'cancel must preserve path')
      if(plaintext){
        pickerMode='browse'
        const beforeBrowse=pickerCalls.length
        await click(button('浏览…'))
        await waitFor(()=>button('使用此目录')?.props.disabled===false)
        assert.deepEqual(pickerCalls.slice(beforeBrowse),['pick','list'],'only a browse capability activates the web listing')
        await change(field('新文件夹名称'),'plain')
        await click(button('新建文件夹'))
        await waitFor(()=>field('浏览目录路径')?.props.value===workspace&&button('使用此目录')?.props.disabled===false)
        await click(button('使用此目录'))
      }else{
        await fs.mkdir(workspace);nativePath=workspace
        await click(button('浏览…'))
      }
      await waitFor(()=>submit()?.props.disabled===false&&field('Orivii 工作空间').props.value===workspace)
      assert.equal(submit().children.join(''),'创建工作空间')
      if(plaintext)await act(async()=>{find('input',n=>n.props.type==='checkbox').props.onChange({target:{checked:true}})})
      else {await change(field('记忆库密码'),'test-only-password');await change(field('确认密码'),'test-only-password')}
      await act(async()=>{renderer.root.findByType('form').props.onSubmit({preventDefault(){}})})
      await waitFor(()=>renderer.root.findAll(n=>n.props['data-testid']==='dot-page').length===1&&button('新建聊天')?.props.disabled===false)
      assert.equal(host.dotCompanion.host.identities.runtime(workspace).vault.workspace,workspace)
      assert.equal(host.dotCompanion.host.identities.runtime(workspace).vault.meta.encrypted,!plaintext)
      await click(button('新建聊天'))
      await waitFor(()=>renderer.root.findAll(n=>n.props.className==='dot-contact').some(n=>n.findAllByType('span').some(s=>s.children.includes('新的聊天'))))
      assert.equal(renderer.root.findAll(n=>n.props.className==='dot-inbox').length,0,'chat management must not occupy the main panel')
      await click(button('更多'))
      await click(button('设置'))
      await click(button('外观'))
      await change(field('我的气泡'),'#e2d7ff')
      await change(field('Orivii 颜色'),'#abcdef')
      await click(button('保存外观'))
      await waitFor(()=>Boolean(button('我的 Orivii')))
      const appearance=await host.dotCompanion.host.identities.runtime(workspace).vault.read()
      assert.equal(appearance.catalog.settings.bubbleColor,'#e2d7ff')
      assert.equal(appearance.catalog.settings.characterColor,'#abcdef')
      const bytes=new Blob(['synthetic upload']),upload={name:'sample.txt',size:bytes.size,type:'text/plain',slice:(...args)=>bytes.slice(...args)}
      await act(async()=>{field('选择图片或文件').props.onChange({target:{files:[upload],value:'sample.txt'}})})
      await waitFor(()=>renderer.root.findAll(n=>n.props.className==='dot-draft-file').some(n=>n.findAllByType('span').some(s=>s.children.includes('sample.txt'))))
      assert.ok(calls.includes('fileFinish'),'upload uses the actual strict host gateway')
      await click(button('移除 sample.txt'))
      await click(button('我的 Orivii'))
      await waitFor(()=>renderer.root.findAllByProps({'aria-label':'切换 Orivii'}).length===1)
      assert.equal(renderer.root.findByProps({'aria-label':'解锁期限'}).props.value,'run')
      if(plaintext){
        const originalId=host.dotCompanion.host.identities.runtime(workspace).vault.meta.id
        await change(find('textarea',n=>n.props['aria-label']==='消息'),'尚未发送的草稿')
        await change(field('新 Orivii 名字'),'第二个 Orivii')
        await change(find('textarea',n=>n.props['aria-label']==='新 Orivii 相处方式'),'爱玩梗，活泼健谈。')
        await act(async()=>{find('input',n=>n.props.type==='checkbox').props.onChange({target:{checked:true}})})
        const count=calls.filter(action=>action==='identityCreate').length
        await click(button('创建并切换'))
        assert.equal(calls.filter(action=>action==='identityCreate').length,count,'draft must block switching before any Host mutation')
        assert.equal(find('textarea',n=>n.props['aria-label']==='消息').props.value,'尚未发送的草稿')
        await click(button('关闭提示'))
        await change(find('textarea',n=>n.props['aria-label']==='消息'),'')
        await click(button('创建并切换'))
        await waitFor(()=>find('textarea',n=>n.props['aria-label']==='消息')?.props.placeholder==='发消息给第二个 Orivii…'&&button('新建聊天')?.props.disabled===false)
        assert.equal(host.dotCompanion.host.identities.runtimes.size,2)
        assert.equal(renderer.root.findAll(n=>n.props.className==='dot-contact').some(n=>n.findAllByType('span').some(s=>s.children.includes('新的聊天'))),false,'new identity must not display the original chat')
        await click(button('更多'));await click(button('设置'));await click(button('我的 Orivii'))
        await waitFor(()=>find('select',n=>n.props['aria-label']==='切换 Orivii'))
        // Hold B's old snapshot after it left the Host but before the browser
        // receives it, then complete the identity switch in the meantime.
        const oldSnapshot=new Promise(resolve=>{delaySnapshot=resolve})
        await act(async()=>{await oldSnapshot})
        await change(find('select',n=>n.props['aria-label']==='切换 Orivii'),originalId)
        await click(button('切换到这个 Orivii'))
        await act(async()=>{releaseSnapshot();releaseSnapshot=null;await new Promise(resolve=>setTimeout(resolve,0))})
        await waitFor(()=>find('textarea',n=>n.props['aria-label']==='消息')?.props.placeholder==='发消息给Orivii…'&&button('新建聊天')?.props.disabled===false)
        const unlockCount=calls.filter(action=>action==='unlock').length
        // Re-register the entire browser module, losing every in-memory renderer
        // capability, as on a genuine page reload. No browser storage is supplied.
        await act(async()=>{renderer.unmount();renderer=undefined});await fiber.dispose()
        fiber=client.plugin(plugin);await fiber;Panel=registrations.findLast(r=>r.options.name==='main').component
        await act(async()=>{renderer=TestRenderer.create(React.createElement(Panel))})
        await waitFor(()=>find('textarea',n=>n.props['aria-label']==='消息')?.props.placeholder==='发消息给Orivii…'&&button('新建聊天')?.props.disabled===false)
        assert.equal(calls.filter(action=>action==='unlock').length,unlockCount,'page reload must resume without another password submission')
        await click(button('更多'));await click(button('设置'));await click(button('我的 Orivii'))
        await waitFor(()=>find('select',n=>n.props['aria-label']==='切换 Orivii'))
      }
      await click(button('返回设置'))
      await click(button('陪伴与连接'))
      await waitFor(()=>renderer.root.findAllByType('p').some(n=>n.children.some(s=>typeof s==='string'&&s.includes('画面默认交给当前对话模型'))))
      await click(button('返回设置'))
      await click(button('关闭'))
      await click(button('更多'))
      await click(button('锁定'))
      assert.equal(host.dotCompanion.host.vault,null)
      // A fresh renderer loses its capability and has to use the unlock form.
      await act(async()=>{renderer.unmount();renderer=TestRenderer.create(React.createElement(Panel))})
      await waitFor(()=>field('Orivii 工作空间')?.props.value===workspace&&submit()?.props.disabled===false)
      assert.equal(submit().children.join(''),plaintext?'打开记忆库':'解锁','existing vault must be detected automatically')
      if(!plaintext)await change(field('记忆库密码'),'test-only-password')
      await act(async()=>{renderer.root.findByType('form').props.onSubmit({preventDefault(){}})})
      await waitFor(()=>renderer.root.findAll(n=>n.props.className==='dot-contact').some(n=>n.findAllByType('span').some(s=>s.children.includes('新的聊天'))))
      await click(button('更多'))
      await click(button('锁定'))
      await act(async()=>{renderer.unmount();renderer=undefined})
    }
    for(const action of ['status','setup','snapshot','createChat','lock','unlock'])assert.ok(calls.includes(action),action)
    for(const action of ['list','pick','createDirectory'])assert.ok(pickerCalls.includes(action),action)
    await fiber.dispose()
    assert.equal(client.reflect.get('remote.dotCompanion'),undefined,'plugin disposal withdraws the mounted namespace')
  } finally {
    releaseSnapshot?.()
    if(renderer)await act(async()=>{renderer.unmount()})
    await client.fiber.dispose();await host.fiber.dispose()
    await fs.rm(fixture,{recursive:true,force:true})
  }
})

test('installed DSH chooser supports Windows, graphical Linux, and headless/SSH fallback',async()=>{
  const {resolveDirectoryPickerBackend}=await installed('dsh-host-directory-picker-auto')
  const {pickNativeDirectory}=await installed('dsh-host-directory-picker-native')
  const facts={bindHost:'127.0.0.1',allowsRemoteAuthorities:false,platform:'linux',ssh:false,env:{DISPLAY:':0'},linuxChooser:true}
  assert.equal(resolveDirectoryPickerBackend({...facts,platform:'win32',env:{}}),'native')
  assert.equal(resolveDirectoryPickerBackend(facts),'native')
  assert.equal(resolveDirectoryPickerBackend({...facts,env:{WAYLAND_DISPLAY:'wayland-0'}}),'native')
  for(const changed of [{env:{}},{linuxChooser:false},{ssh:true},{bindHost:'0.0.0.0'}])assert.equal(resolveDirectoryPickerBackend({...facts,...changed}),'browse')
  const signal=new AbortController().signal,calls=[]
  assert.equal(await pickNativeDirectory(signal,{platform:'win32',pickWin32Dialog:async s=>{assert.equal(s,signal);return 'M:\\Dotspace'}}),'M:\\Dotspace')
  assert.equal(await pickNativeDirectory(signal,{platform:'linux',run:async(command,args,s)=>{calls.push(command);assert.equal(s,signal);assert.ok(args.includes('--directory'));return {stdout:'/home/test/Dotspace\n'}}}),'/home/test/Dotspace')
  assert.deepEqual(calls,['zenity']);calls.length=0
  assert.equal(await pickNativeDirectory(signal,{platform:'linux',run:async(command,args)=>{
    calls.push(command)
    if(command==='zenity')throw Object.assign(new Error('not installed'),{code:'ENOENT'})
    assert.ok(args.includes('--getexistingdirectory'));return {stdout:'/home/test/Dotspace\n'}
  }}),'/home/test/Dotspace')
  assert.deepEqual(calls,['zenity','kdialog'])
  assert.equal(await pickNativeDirectory(signal,{platform:'linux',run:async()=>{throw Object.assign(new Error('cancel'),{code:1})}}),null)
})
