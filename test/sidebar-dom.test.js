import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import React,{act} from 'react'
import {z} from 'zod'
import {JSDOM} from 'jsdom'
import {DotHost} from '../src/host.js'
import {MarkdownText} from './markdown-stub.js'

test('real DOM sidebar opens Orivii, toggles inline chats, switches transcripts and clears private UI on lock',async()=>{
  const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true})
  const globals={window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true}
  const saved=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  const ReactDOM=await import('react-dom'),{createRoot}=await import('react-dom/client')
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url));await fs.mkdir(base,{recursive:true})
  const fixture=await fs.mkdtemp(path.join(base,'dot-sidebar-dom-'))
  let releaseReply,replyGate,sendGate,releaseSend,live=false,bodyGate,releaseBody,endGate,releaseEnd,sourceGate,releaseSource,legacyTags=false
  const host=new DotHost({defaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{
    listProviders:()=>[],
    async prepareCall(config){return {config,context:{contextWindow:512000},stream:async function*(options){
      if(!options.purpose&&replyGate)await replyGate
      if(!options.purpose&&live){
        yield {type:'reasoning-delta',index:0,text:'PRIVATE_REASONING'}
        yield {type:'text-delta',index:1,text:'[dot-reply:heart]\n'}
        await bodyGate
        yield {type:'text-delta',index:1,text:'第一段，收到啦。\n第二段，慢慢聊。'}
        await endGate
        yield {type:'finish',reason:{kind:'stop'}}
        return
      }
      yield {type:'block-end',index:0,block:{type:'text',text:options.purpose?'{"summary":"测试","overview":"测试","salient":[],"profile":[]}':'我在，慢慢说。'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }}}
  }},{pointer:path.join(fixture,'pointer.json')})
  await fs.writeFile(host.pointer,JSON.stringify({workspace:path.join(fixture,'workspace')}))
  let root,plugin,selected=null,regularClicks=0,setupRequest,sidebarEntry,registrationId=0,collapsed=false,settingsExtension=false
  const listeners=new Set(),registrations=[],slotListeners=new Set(),effects=[]
  const notifySlots=()=>{for(const listener of slotListeners)listener()}
  const layout={panelInfo:{getSnapshot:()=>({activePanelId:selected})},selectPanel(id){selected=id;for(const listener of listeners)listener()}}
  const ctx={layout,remote:{async $mount(){return async()=>{}},dotCompanion:{async command(request){
    if(request.action==='setup')setupRequest=request;if(request.action==='send'&&sendGate)await sendGate
    if(request.action==='source'&&sourceGate)await sourceGate
    if(settingsExtension&&request.action==='extension'){
      assert.equal(request.request.operation,'view','navigation must not save or mutate preferences')
      const views={persona:{card:{template:'blank',description:'',axes:{},interests:[],examples:[]},templates:[{id:'blank',label:'自定义',axes:{}}],axes:{}},care:{policy:{enabled:true,quietStart:'23:00',quietEnd:'08:00',timeZone:'Asia/Shanghai'}},privacy:{encrypted:false,policy:{analysisEnabled:true,allowTasks:true}},tasks:{tasks:[]}}
      return {ok:true,value:{ok:true,value:views[request.request.section]}}
    }
    const value=await host.command(request)
    if(legacyTags&&request.action==='snapshot'&&value.ok)value.value.messages=value.value.messages.map(m=>m.role==='assistant'?{...m,text:'[dot-reply:happy]\n'+m.text}:m)
    if(settingsExtension&&request.action==='snapshot'){value.value.extensionAvailable=true;value.value.personaAvailable=true}
    return {ok:true,value}
  }}},
    inject(dependencies,fn){if(dependencies.includes('remote.dotCompanion'))return Object.assign(Promise.resolve(fn(ctx)),{dispose:async()=>{}});return {dispose:async()=>{}}},
    slots:{inject(_name,fn){effects.push(fn())},register(options,component){
      const entry={options,component,id:++registrationId};registrations.push(entry)
      if(options.name==='sidebar.panellist'){sidebarEntry=entry;notifySlots()}
      return()=>{if(sidebarEntry===entry){sidebarEntry=null;notifySlots()}}
    }},
  }
  try {
    vm.runInNewContext(await fs.readFile(new URL('../dsh/client.js',import.meta.url),'utf8'),{
      window:{__ModuleLoader__:{load({factory}){plugin=factory(name=>{if(name==='react')return React;if(name==='@deepseek-ai/dsh-client-ui-primitives')return {MarkdownText};if(name==='react-dom')return ReactDOM;if(name==='zod')return {z};throw new Error(name)})}}},
      AbortController,setInterval,clearInterval,setTimeout,clearTimeout,crypto,
    })
    await plugin.apply(ctx)
    const Panel=registrations.find(r=>r.options.name==='main').component
    function App(){
      const active=React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selected,()=>selected)
      const sidebar=React.useSyncExternalStore(fn=>{slotListeners.add(fn);return()=>slotListeners.delete(fn)},()=>sidebarEntry,()=>sidebarEntry)
      return React.createElement(React.Fragment,null,
        React.createElement('aside',{'data-native-sidebar':true},
          sidebar&&React.createElement('button',{'data-dot-row':true,'aria-label':sidebar.options.label,title:collapsed?sidebar.options.label:undefined,onClick:()=>layout.selectPanel('dsh-companion-dot')},React.createElement('span',{'aria-hidden':true},React.createElement(sidebar.component,{key:sidebar.id,size:collapsed?18:16,active:active==='dsh-companion-dot'})),!collapsed&&React.createElement('span',{'data-dot-title':true},sidebar.options.label)),
          React.createElement('button',{'aria-label':'普通 DSH 会话',onClick:()=>{regularClicks++;layout.selectPanel(null)}},'普通 DSH 会话')),
        React.createElement('main',null,active==='dsh-companion-dot'?React.createElement(Panel):React.createElement('p',null,'普通会话')))
    }
    root=createRoot(dom.window.document.getElementById('app'))
    await act(async()=>{root.render(React.createElement(App))})
    const doc=dom.window.document
    const button=label=>[...doc.querySelectorAll('button')].find(b=>!b.closest('[inert]')&&(b.getAttribute('aria-label')===label||b.textContent===label))
    const input=label=>doc.querySelector(`[aria-label="${label}"]`)
    const dotRow=()=>doc.querySelector('[data-dot-row]')
    async function click(element){assert.ok(element,'expected control');await act(async()=>{element.click()})}
    async function waitFor(predicate){const until=Date.now()+12000;while(!predicate()){
      assert.equal(doc.querySelector('[role=alert]')?.textContent||'','')
      if(Date.now()>=until)assert.fail('UI timeout '+JSON.stringify({out:[...doc.querySelectorAll('.dot-outgoing .dot-bubble')].map(e=>e.textContent),incoming:[...doc.querySelectorAll('.dot-incoming .dot-bubble')].map(e=>e.textContent),header:doc.querySelector('.dot-contact')?.textContent,jobs:(await host.vault?.read())?.catalog.jobs}))
      await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})
    }}
    async function change(element,value){assert.ok(element);await act(async()=>{const prototype=element.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})}
    async function createChat(){
      const previous=doc.querySelector('.dot-sidebar-chat-title[aria-current="page"]')
      await click(button('新建 Orivii 聊天'))
      await waitFor(()=>{const selected=doc.querySelector('.dot-sidebar-chat-title[aria-current="page"]');return selected&&selected!==previous&&doc.querySelector('.dot-contact span')?.textContent==='新的聊天'})
    }
    await click(button('Orivii'))
    assert.equal(button('Orivii').getAttribute('aria-expanded'),'false')
    assert.equal(doc.querySelector('.dot-sidebar-tree'),null)
    await waitFor(()=>doc.querySelector('.dot-vault-form button[type=submit]')?.disabled===false)
    assert.equal(input('Orivii 的名字').value,'Orivii')
    await change(input('Orivii 的名字'),'小点')
    await change(input('希望 Orivii 如何称呼你'),'阿林')
    await click(doc.querySelector('.dot-vault-form input[type=checkbox]'))
    await click(doc.querySelector('.dot-vault-form button[type=submit]'))
    await waitFor(()=>doc.querySelector('.dot-conversation')&&button('新建聊天')?.disabled===false)
    assert.equal(setupRequest.settings.name,'小点');assert.equal(setupRequest.profile.preferredName,'阿林')
    assert.equal(doc.querySelector('.dot-contact strong').textContent,'小点')
    assert.equal(doc.querySelector('.dot-sidebar-eye').dataset.eyeAnimated,'true')
    assert.equal(doc.querySelector('.dot-contact .dot-eye').dataset.eyeAnimated,'true')
    for(const rim of doc.querySelectorAll('.dot-eye-outline')){assert.equal(rim.tagName,'circle');assert.equal(Number(rim.getAttribute('stroke-width')),9.2)}
    for(const pupil of doc.querySelectorAll('.dot-eye-pupil'))assert.equal(pupil.getAttribute('fill'),'currentColor')
    assert.equal(dotRow().getAttribute('aria-label'),'小点')
    assert.equal(doc.querySelector('[data-dot-title]').textContent,'小点')
    assert.equal(doc.querySelector('main .dot-inbox'),null)
    await click(dotRow())
    assert.equal(dotRow().getAttribute('aria-expanded'),'true')
    assert.ok(dotRow().nextElementSibling.contains(doc.querySelector('.dot-sidebar-tree')))
    assert.equal(doc.querySelector('main .dot-sidebar-tree'),null)
    await click(dotRow())
    assert.equal(doc.querySelector('.dot-sidebar-presence').getAttribute('aria-hidden'),'true');await waitFor(()=>!doc.querySelector('.dot-sidebar-tree'));assert.ok(doc.querySelector('.dot-conversation'))
    await click(dotRow())
    await click(button('更多'));await click(button('设置'))
    assert.equal(doc.querySelector('.dot-menu').getAttribute('aria-hidden'),'true')
    await click(button('关闭'))
    assert.ok(doc.querySelector('.dot-details').hasAttribute('inert'),'closing settings cannot receive another click')
    await click(button('更多'));await click(button('设置'))
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,210))})
    assert.ok(doc.querySelector('.dot-details:not([inert])'),'quickly reopened settings remain mounted')
    const nameField=[...doc.querySelectorAll('.dot-settings label')].find(label=>label.querySelector('span')?.textContent==='名字')?.querySelector('input')
    await change(nameField,'小圆')
    const animationToggle=[...doc.querySelectorAll('.dot-settings label')].find(label=>label.textContent==='角色动画')?.querySelector('input')
    assert.equal(animationToggle.checked,true);await click(animationToggle)
    await click(button('保存设置'))
    await waitFor(()=>!doc.querySelector('.dot-details')&&dotRow().getAttribute('aria-label')==='小圆')
    assert.equal(doc.querySelector('[data-dot-title]').textContent,'小圆')
    assert.equal(doc.querySelector('.dot-contact strong').textContent,'小圆')
    assert.equal(doc.querySelector('.dot-sidebar-eye').dataset.eyeAnimated,'false','saved preference also stops the sidebar')
    assert.equal(doc.querySelector('.dot-contact .dot-eye').dataset.eyeAnimated,'false')
    assert.equal(doc.querySelectorAll('.dot-sidebar-mount').length,1)
    assert.ok(doc.querySelector('.dot-sidebar-tree'),'renaming keeps the list expanded')
    await act(async()=>{collapsed=true;root.render(React.createElement(App))})
    assert.equal(dotRow().title,'小圆','collapsed native tooltip follows the name')
    assert.equal(doc.querySelector('.dot-sidebar-tree'),null)
    await act(async()=>{collapsed=false;root.render(React.createElement(App))})
    assert.equal(doc.querySelector('[data-dot-title]').textContent,'小圆')
    for(const text of ['第一段聊天的小星星','第二段聊天的小月亮']){
      replyGate=new Promise(resolve=>{releaseReply=resolve})
      sendGate=new Promise(resolve=>{releaseSend=resolve})
      await createChat()
      await change(input('消息'),text)
      await click(button('发送消息'))
      assert.equal(doc.querySelector('.dot-outgoing .dot-bubble')?.textContent,text,'outgoing bubble appears before host acceptance')
      assert.equal(input('消息').value,'')
      const outgoing=doc.querySelector('.dot-outgoing')
      assert.equal(outgoing.dataset.dotNew,'true')
      await act(async()=>{releaseSend();sendGate=null})
      await waitFor(()=>!!doc.querySelector('.dot-pending:not([inert]) .dot-typing'))
      assert.ok(doc.querySelector('.dot-pending .dot-bubble .dot-typing'),'animation belongs inside an assistant bubble')
      assert.ok(doc.querySelector('.dot-pending .dot-avatar'),'pending reply retains its avatar')
      await act(async()=>{releaseReply();replyGate=null})
      await waitFor(()=>doc.querySelector('.dot-outgoing .dot-bubble')?.textContent===text&&doc.querySelector('.dot-incoming:not(.dot-pending) .dot-bubble')?.textContent==='我在，慢慢说。')
      await waitFor(()=>!doc.querySelector('.dot-typing'))
      assert.equal(doc.querySelectorAll('.dot-outgoing').length,1)
      assert.equal(doc.querySelector('.dot-outgoing'),outgoing,'accepted message reuses the optimistic bubble')
      assert.ok(doc.querySelector('.dot-incoming .dot-rich-text [data-native-markdown]'),'reply uses the native Markdown component')
    }
    live=true;bodyGate=new Promise(r=>{releaseBody=r});endGate=new Promise(r=>{releaseEnd=r})
    await createChat()
    await change(input('消息'),'给你一颗小爱心')
    await click(button('发送消息'))
    await waitFor(()=>doc.querySelector('.dot-contact .dot-eye')?.dataset.eyeState==='heart')
    assert.equal(doc.querySelector('.dot-live-reply'),null,'expression arrives before visible text')
    await act(async()=>releaseBody())
    await waitFor(()=>doc.querySelectorAll('.dot-live-reply .dot-bubble').length===2&&doc.querySelectorAll('.dot-live-reply .dot-bubble')[1].textContent==='第二段，慢慢聊。')
    const liveRow=doc.querySelector('.dot-live-reply'),liveId=liveRow.dataset.messageId,firstBubble=liveRow.querySelector('.dot-bubble')
    assert.deepEqual([...liveRow.querySelectorAll('.dot-bubble')].map(b=>b.textContent),['第一段，收到啦。','第二段，慢慢聊。'])
    assert.equal(liveRow.querySelectorAll('.dot-stream-caret').length,0,'no detached cursor line is rendered')
    assert.doesNotMatch(doc.querySelector('main').textContent,/dot-reply|PRIVATE_REASONING/)
    await act(async()=>releaseEnd())
    await waitFor(()=>!doc.querySelector('.dot-live-reply')&&!doc.querySelector('.dot-typing'))
    const finalRow=doc.querySelector(`[data-message-id="${liveId}"]`)
    assert.equal(finalRow,liveRow,'final commit does not remount or replay the reply')
    assert.equal(finalRow.querySelector('.dot-bubble'),firstBubble)
    assert.equal(finalRow.querySelectorAll('.dot-bubble').length,2)
    assert.equal(doc.querySelectorAll('.dot-incoming:not(.dot-pending)').length,1)
    if(process.env.DOT_VISUAL_FIXTURE){
      // Export this actual component's synthetic DOM for browser raster QA.
      // Host actions and Markdown parsing remain covered separately above.
      await fs.writeFile(path.join(base,'dot-ui-0.8.0-frame.html'),'<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0;font:14px "Segoe UI",sans-serif}body{overflow:hidden}</style>'+doc.querySelector('.dot-page').outerHTML)
    }
    live=false;legacyTags=true
    await createChat()
    replyGate=new Promise(r=>{releaseReply=r});sendGate=new Promise(r=>{releaseSend=r})
    for(const text of ['连续输入一','连续输入二','连续输入三']){
      await change(input('消息'),text)
      assert.equal(button('发送消息').disabled,false,'model work and pending requests must not disable sending')
      await click(button('发送消息'))
    }
    assert.deepEqual([...doc.querySelectorAll('.dot-outgoing .dot-bubble')].map(e=>e.textContent),['连续输入一','连续输入二','连续输入三'])
    await change(input('消息'),'下一句还在编辑')
    await act(async()=>{releaseSend();sendGate=null})
    await waitFor(()=>doc.querySelector('.dot-pending:not([inert]) .dot-typing'))
    assert.equal(input('消息').value,'下一句还在编辑');assert.equal(button('发送消息').disabled,false)
    await act(async()=>{releaseReply();replyGate=null})
    await waitFor(()=>doc.querySelectorAll('.dot-incoming:not(.dot-pending)').length===3&&!doc.querySelector('.dot-typing'))
    assert.equal(doc.querySelectorAll('.dot-outgoing').length,3,'acknowledgements do not duplicate optimistic messages')
    assert.doesNotMatch(doc.querySelector('main').textContent,/dot-reply/)
    assert.equal(input('消息').value,'下一句还在编辑')
    legacyTags=false;settingsExtension=true
    await act(async()=>host.vault.transaction(state=>state.permanent.entries.push({id:crypto.randomUUID(),text:'导航测试记录',sourceIds:[state.catalog.messages[0].id],time:Date.now(),enabled:true,origin:'user'})))
    await click([...doc.querySelectorAll('.dot-sidebar-chat-title')].find(b=>b.textContent==='第一段聊天的小星星'))
    await waitFor(()=>doc.querySelector('.dot-outgoing .dot-bubble')?.textContent==='第一段聊天的小星星')
    assert.equal(doc.querySelector('main').textContent.includes('第二段聊天的小月亮'),false)
    await click(button('普通 DSH 会话'));assert.equal(regularClicks,1)
    await click(dotRow())
    await waitFor(()=>doc.querySelector('.dot-outgoing .dot-bubble')?.textContent==='第一段聊天的小星星')
    assert.equal(doc.querySelector('.dot-sidebar-tree'),null,'returning opens Orivii before expanding management')
    assert.equal(button('永久记住'),undefined)
    assert.equal(doc.querySelector('.dot-compose').textContent.includes('记忆'),false)
    await click(button('更多'))
    assert.equal(button('四层记忆'),undefined)
    assert.equal(button('对你的印象'),undefined)
    await click(button('设置'))
    assert.equal(doc.querySelector('.dot-more-preferences').open,false,'advanced preferences start collapsed')
    assert.equal(button('性格与相处'),undefined);assert.equal(button('主动关心'),undefined)
    await click(doc.querySelector('.dot-more-preferences summary'))
    assert.equal(doc.querySelector('.dot-more-preferences').open,true)
    const nameDraft=()=>[...doc.querySelectorAll('.dot-settings label')].find(label=>label.querySelector('span')?.textContent==='名字')?.querySelector('input')
    await change(nameDraft(),'保留尚未保存的名字')
    for(const label of ['交流方式','消息与安静时段']){
      await click(button(label));await waitFor(()=>doc.querySelector('.dot-companion-settings'))
      assert.equal(doc.querySelector('.dot-details-header h2').textContent,label)
      assert.equal(button('返回设置').textContent,'返回','back has a visible label, not only an icon')
      await click(button('返回设置'))
      assert.equal(nameDraft().value,'保留尚未保存的名字')
      assert.equal(doc.querySelector('.dot-more-preferences').open,true,'return keeps the preferences group open')
    }
    await click(button('开发者模式'));assert.ok(doc.querySelector('.dot-developer'))
    assert.equal(doc.querySelector('.dot-developer input').checked,false)
    await click(doc.querySelector('.dot-developer input'))
    await waitFor(()=>doc.querySelector('.dot-developer').textContent.includes('当前运行'))
    assert.ok(host.developerTokens.size>0)
    await click(button('返回设置'));await waitFor(()=>host.developerTokens.size===0)
    assert.equal(nameDraft().value,'保留尚未保存的名字')
    await click(button('数据与权限'));await waitFor(()=>button('查看聊过的重要内容'))
    assert.doesNotMatch(doc.querySelector('.dot-details').textContent,/人格|主动关心|心跳|评分/)
    await click([...doc.querySelectorAll('summary')].find(s=>s.textContent==='管理与修正资料'))
    await click(button('查看聊过的重要内容'));await waitFor(()=>doc.querySelector('.dot-memory-entry'))
    await click([...doc.querySelectorAll('summary')].find(s=>s.textContent==='相关聊天'))
    await click(doc.querySelector('.dot-memory-entry .dot-source-link'))
    await waitFor(()=>doc.querySelector('.dot-original'))
    assert.equal(button('返回聊过的内容').textContent,'返回')
    await click(button('返回聊过的内容'));assert.equal(doc.querySelector('.dot-details-header h2').textContent,'聊过的内容')
    await act(async()=>doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    await waitFor(()=>doc.querySelector('.dot-companion-settings'))
    assert.equal(doc.querySelector('.dot-details-header h2').textContent,'数据与权限','Escape returns to the actual parent')
    await click(button('返回设置'))
    assert.equal(nameDraft().value,'保留尚未保存的名字')
    await click(button('关闭'));await waitFor(()=>!doc.querySelector('.dot-details'))
    await click(button('更多'));await click(button('查聊天记录'))
    await change(doc.querySelector('.dot-settings input'),'小星星')
    await click(button('搜索所有聊天'));await waitFor(()=>button('查看原文'))
    await click(button('查看原文'));await waitFor(()=>doc.querySelector('.dot-original'))
    await click(button('返回查聊天记录'))
    assert.equal(doc.querySelector('.dot-settings input').value,'小星星','back preserves the search query and results')
    assert.ok(button('查看原文'))
    sourceGate=new Promise(resolve=>{releaseSource=resolve})
    await click(button('查看原文'))
    await act(async()=>doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    await waitFor(()=>!doc.querySelector('.dot-details'))
    await act(async()=>{releaseSource();sourceGate=null;await new Promise(resolve=>setTimeout(resolve,40))})
    assert.equal(doc.querySelector('.dot-details'),null,'a late private source cannot reopen a closed panel')
    await click(button('更多'));await click(button('设置'));await click(button('关于你'))
    assert.equal(input('你喜欢的称呼').value,'阿林')
    await change(input('你喜欢的称呼'),'亲爱的')
    await click(button('保存偏好'))
    await waitFor(()=>!doc.querySelector('.dot-details'))
    assert.equal((await host.vault.read()).permanent.profile.fields.preferredName.value,'亲爱的')
    await click(dotRow());await click(button('更多'));await click(button('锁定'))
    await waitFor(()=>!!doc.querySelector('[data-testid=dot-locked]'))
    assert.equal(doc.querySelector('.dot-sidebar-chat-title'),null)
    assert.equal(dotRow().getAttribute('aria-label'),'Orivii')
    assert.equal(doc.body.textContent.includes('第一段聊天的小星星'),false)
    assert.equal(host.vault,null)
    assert.equal(doc.querySelector('.dot-sidebar-eye').dataset.eyeAnimated,'false')
    await act(async()=>{root.unmount();root=null})
    assert.equal(doc.querySelector('.dot-sidebar-mount'),null)
  } finally {
    releaseReply?.();releaseSend?.();releaseBody?.();releaseEnd?.();releaseSource?.()
    if(root)await act(async()=>{root.unmount()})
    for(const dispose of effects.reverse())dispose?.()
    await host.dispose();await fs.rm(fixture,{recursive:true,force:true});dom.window.close()
    for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
  }
})
