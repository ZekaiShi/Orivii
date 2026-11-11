import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {z} from 'zod'
import {validateVisualSpec,visualValues,visualSummary} from '../src/visual.js'
import {createVisualRenderer,createArtifactPreview} from '../src/visual-client.js'
import {sanitizeMarkup,PREVIEW_SCRIPT,PREVIEW_SCRIPT_HASH} from '../src/preview.js'
import {validCanvasMessage,groupBubbleBlocks,bubbleContentLimit,previewColorPolicy} from '../src/canvas.js'
import {JSDOM} from 'jsdom'
import {messageBubbleParts} from '../src/reply.js'
import {imageDisplaySize} from '../src/file-client.js'
import {DotHost} from '../src/host.js'
import {createDotRemote} from '../src/protocol.js'

const spec=()=>({version:1,title:'参数与结果',demo:true,controls:[{id:'side',type:'select',label:'特征边长',value:64,options:[{label:'64²',value:64},{label:'128²',value:128}]},{id:'ticks',type:'slider',label:'思考次数',value:4,min:1,max:8,step:1},{id:'enabled',type:'toggle',label:'同步',value:true}],calculations:[{id:'positions',op:'power',inputs:[{ref:'side'},2]},{id:'total',op:'multiply',inputs:[{ref:'positions'},{ref:'ticks'},{ref:'enabled'}]}],blocks:[{type:'metrics',items:[{label:'位置数',value:{ref:'positions'}},{label:'位置 × 思考',value:{ref:'total'}}]},{type:'chart',kind:'bar',title:'当前配置对照',labels:['位置','更新次数'],series:[{name:'演示数值',values:[{ref:'positions'},{ref:'total'}]}]},{type:'table',columns:['参数','值'],rows:[['思考次数',{ref:'ticks'}]]},{type:'cards',columns:2,items:[{title:'计算说明',text:'这些值是配置演示。'}]},{type:'flow',items:[{title:'输入'},{title:'更新',text:'依据当前参数计算'}]}]})
const visibleControl=(renderer,label)=>renderer.root.findAllByProps({'aria-label':label}).find(node=>{for(let parent=node.parent;parent;parent=parent.parent)if(parent.props['aria-hidden']===true)return false;return true})

test('visual controls update metrics, chart data and table cells locally with bounded calculations',async()=>{
  const Visual=createVisualRenderer(React,{markdown:text=>React.createElement('p',null,text),markup:()=>null});let renderer
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Visual,{spec:spec()}))})
  try{
    assert.match(JSON.stringify(renderer.toJSON()),/16,384/)
    const before=renderer.root.findAllByType('rect').map(rect=>rect.props.height)
    await act(async()=>visibleControl(renderer,'特征边长').props.onChange({target:{value:'128'}}))
    await act(async()=>visibleControl(renderer,'思考次数').props.onChange({target:{value:'8'}}))
    assert.match(JSON.stringify(renderer.toJSON()),/131,072/)
    assert.notDeepEqual(renderer.root.findAllByType('rect').map(rect=>rect.props.height),before)
    assert.ok(renderer.root.findAllByType('td').some(cell=>cell.children.includes('8')))
    await act(async()=>visibleControl(renderer,'同步').props.onChange({target:{checked:false}}))
    assert.equal(visualValues(validateVisualSpec(spec()),{side:128,ticks:8,enabled:false}).values.get('total'),0)
  }finally{await act(async()=>renderer.unmount())}
  const invalid=[{...spec(),script:'fetch()'},{...spec(),controls:[{type:'slider',label:'无编号',value:1,min:0,max:2}]},{...spec(),calculations:[{id:'cycle',op:'add',inputs:[{ref:'cycle'}]}]},{...spec(),blocks:[{type:'table',columns:['a'],rows:[[1,2]]}]},{...spec(),blocks:[{type:'chart',kind:'bar',labels:['a'],series:[{name:'x',values:[NaN]}]}]}]
  for(const value of invalid)assert.throws(()=>validateVisualSpec(value))
  const zero=validateVisualSpec({version:1,title:'零分母',calculations:[{id:'ratio',op:'divide',inputs:[1,0]}],blocks:[{type:'metrics',items:[{label:'值',value:{ref:'ratio'}}]}]})
  assert.equal(visualValues(zero).values.get('ratio'),null)
  assert.doesNotMatch(visualSummary(validateVisualSpec(spec())),/"op"|"ref"|calculations/)
})

test('HTML, SVG and structured card files receive separate bubbles while streaming and archives stay intact',()=>{
  const message={role:'assistant',text:'先看这里。\n```html\n<section>对照图</section>\n```\n这是结论。\n```svg\n<svg><circle r="10"/></svg>\n```',attachments:[{id:'img',kind:'image',name:'photo.png'},{id:'html',kind:'text',name:'report.html'}]},original=JSON.stringify(message)
  const parts=messageBubbleParts(message)
  assert.equal(parts.filter(part=>part.kind==='markup').length,2)
  assert.equal(parts.filter(part=>part.kind==='artifact').length,1)
  assert.equal(parts.filter(part=>part.kind==='image').length,1)
  assert.ok(parts.filter(part=>part.kind==='text').every(part=>!part.text.includes('<section>')))
  assert.equal(JSON.stringify(message),original)
  const pending=messageBubbleParts({role:'assistant',text:'说明\n```html\n<section>尚未结束',live:true})
  assert.equal(pending.at(-1).kind,'markup-pending')
  const nested=messageBubbleParts({role:'assistant',text:'````js\nconst a = `\n```html\n<section>只是代码</section>\n```\n`;\n````'})
  assert.equal(nested.length,1);assert.equal(nested[0].kind,'text')
  assert.equal(messageBubbleParts({role:'assistant',text:'归档用摘要',presentation:{artifactOnly:true},attachments:[{id:'visual',kind:'text',name:'配置.orivii.json'}]})[0].kind,'artifact')
  assert.deepEqual(imageDisplaySize(40,32),{width:40,height:32});assert.deepEqual(imageDisplaySize(2000,1000),{width:320,height:160});assert.deepEqual(imageDisplaySize(800,1600),{width:150,height:300});assert.equal(imageDisplaySize(0,0),null)
})

test('markup previews strip executable and navigating elements and use an opaque sandbox with no network',async()=>{
  const source='<html><head><style>section{border-radius:18px}</style><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>parent.secret()</script><a href="https://bad.invalid" onclick="evil()">解释</a><iframe src="https://bad.invalid"></iframe><form action="https://bad.invalid"><input></form><svg viewBox="0 0 100 50"><foreignObject><script>evil()</script></foreignObject><circle cx="20" cy="20" r="10" onload="evil()"/><use href="https://bad.invalid/a.svg#id"/></svg><section>正文</section></body></html>'
  const html=sanitizeMarkup(source)
  assert.match(html,/正文/);assert.match(html,/border-radius:18px/);assert.match(html,/<circle/)
  assert.doesNotMatch(html,/<iframe|<form|<input|foreignObject|onclick|onload|parent.secret|https:\/\/bad/)
  const document=new JSDOM(html).window.document
  assert.equal(document.scripts.length,1);assert.equal(document.scripts[0].textContent,PREVIEW_SCRIPT)
  assert.equal(PREVIEW_SCRIPT.includes('\r'),false,'the CSP input must use browser-normalized line endings on every platform')
  assert.equal(createHash('sha256').update(PREVIEW_SCRIPT).digest('base64'),PREVIEW_SCRIPT_HASH)
  assert.ok(html.includes("script-src 'sha256-"+PREVIEW_SCRIPT_HASH+"'"));assert.match(html,/connect-src 'none'/);assert.match(html,/img-src 'none'/)
  const Preview=createArtifactPreview(React,{rpc:async()=>({kind:'html',html}),markdown:text=>text});let renderer
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Preview,{format:'html',source}));await Promise.resolve()})
  try{const frame=renderer.root.findByType('iframe');assert.equal(frame.props.sandbox,'allow-scripts');assert.equal(frame.props.referrerPolicy,'no-referrer');assert.equal(frame.props.src,undefined);assert.ok(frame.props.srcDoc.includes("script-src 'sha256-"+PREVIEW_SCRIPT_HASH+"'"))}finally{await act(async()=>renderer.unmount());document.defaultView.close()}
})

test('complete visual content keeps legacy metadata compatible and accepts bounded content heights',async()=>{
  assert.ok(validCanvasMessage({type:'orivii:canvas',id:'a',height:1680,width:600,part:0,count:1},'a'))
  for(const data of [{id:'b',height:500},{id:'a',height:0},{id:'a',height:-1},{id:'a',height:Infinity},{id:'a',height:1.5},{id:'a',height:1000001},{id:'a',pages:[{start:0,end:400}]}])assert.equal(validCanvasMessage({type:'orivii:canvas',width:600,part:0,count:1,...data},'a'),false)
  const legacy=validateVisualSpec(spec()),next=validateVisualSpec({...spec(),template:'compare',ratio:'4:3',blocks:[{type:'cards',items:[{title:'甲',text:'内容',icon:'book-open'},{title:'乙',text:'内容',icon:'sparkles'}]}]})
  assert.equal(legacy.version,1);assert.equal(next.template,'compare');assert.throws(()=>validateVisualSpec({...spec(),template:'script'}));assert.throws(()=>validateVisualSpec({...next,ratio:'1000:1'}))
  const Visual=createVisualRenderer(React,{markdown:text=>React.createElement('p',null,text),markup:()=>null});let renderer
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Visual,{spec:next}))})
  try{
    assert.equal(renderer.root.findAllByProps({className:'dot-visual-content'}).length,1)
    assert.equal(renderer.root.findAllByType('section').length,2)
    assert.equal(renderer.root.findAll(node=>node.props['aria-hidden']===true&&node.props.inert!==undefined).length,0)
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()),/dot-canvas-fragment|dot-canvas-measure|data-ratio/)
  }finally{await act(async()=>renderer.unmount())}
})
test('complete blocks continue in new bubbles and keep headings with their content',()=>{
  const blocks=[{height:30,keepWithNext:true},{height:170},{height:160},{height:50},{height:700},{height:40,breakBefore:true}]
  const groups=groupBubbleBlocks(blocks,240)
  assert.deepEqual(groups,[[0,1],[2,3],[4],[5]])
  assert.deepEqual(groups.flat(),blocks.map((_,i)=>i))
  assert.ok(bubbleContentLimit(844)<=480);assert.ok(bubbleContentLimit(390)>=220)
  assert.equal(groupBubbleBlocks(Array.from({length:180},()=>({height:1,breakBefore:true})),480).flat().length,180)
  const html=sanitizeMarkup('<header>PAGE_HEADER</header><h1>PAGE_TITLE</h1><p class="page-subtitle">PAGE_LEAD</p><section class="card"><h2>内容</h2><p>BLOCK_CONTENT</p></section><footer>PAGE_FOOTER</footer>')
  const dom=new JSDOM(html)
  assert.match(dom.window.document.body.textContent,/BLOCK_CONTENT/)
  assert.doesNotMatch(dom.window.document.body.textContent,/PAGE_HEADER|PAGE_TITLE|PAGE_LEAD|PAGE_FOOTER/)
  assert.equal(dom.window.document.querySelectorAll('header,footer,h1').length,0)
  dom.window.close()
})

test('parallel HTML groups validate frame channels and create sibling chat bubbles',async()=>{
  const dom=new JSDOM('<div class="dot-page" style="color:rgb(20,20,20)"><div id="root" class="dot-message-stack"></div></div>',{url:'http://127.0.0.1:3080/',pretendToBeVisual:true}),saved={}
  // JSDOM has no pseudo-element styles; actual bubble colors are checked in Chromium.
  const computed=dom.window.getComputedStyle.bind(dom.window)
  dom.window.getComputedStyle=node=>computed(node)
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})}
  const {createRoot}=await import('react-dom/client'),root=createRoot(dom.window.document.getElementById('root')),Preview=createArtifactPreview(React,{rpc:async()=>({kind:'html',html:sanitizeMarkup('<p>段落</p>')}),markdown:text=>text})
  try{
    await act(async()=>{root.render(React.createElement(React.Fragment,null,React.createElement(Preview,{bubble:true,source:'<p>A</p>',format:'html'}),React.createElement(Preview,{bubble:true,source:'<p>B</p>',format:'html'})));await Promise.resolve()})
    const initial=dom.window.document.querySelectorAll('iframe'),oldA=initial[0],b=initial[1],name=JSON.parse(oldA.name)
    const frames=()=>[...dom.window.document.querySelectorAll('iframe')].filter(frame=>JSON.parse(frame.name).id===name.id)
    const send=(source,id,part,count,height,origin='null')=>act(async()=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{origin,source,data:{type:'orivii:canvas',id,part,count,height,width:600}})))
    await send(b.contentWindow,name.id,0,2,240)
    assert.equal(oldA.style.height,'1px')
    await send(oldA.contentWindow,name.id,0,2,240)
    let current=frames()
    assert.equal(current.length,2);assert.equal(current[0].style.height,'240px');assert.equal(b.style.height,'1px')
    await send(current[1].contentWindow,name.id,1,2,280)
    assert.equal(current[1].style.height,'280px')
    assert.equal(current[0],oldA)
    await send(current[0].contentWindow,name.id,0,2,900,'http://127.0.0.1:3080')
    await send(current[0].contentWindow,name.id,0,2,Infinity)
    await send(current[0].contentWindow,'stale-channel',0,2,900)
    assert.equal(current[0].style.height,'240px')
    assert.equal(dom.window.document.querySelectorAll('#root>.dot-artifact-bubble').length,3)
    assert.equal(dom.window.document.querySelectorAll('.dot-artifact-bubble .dot-artifact-bubble').length,0)
    assert.equal(dom.window.document.querySelectorAll('[aria-label="画布比例"],.dot-artifact-toolbar').length,0)
    for(const frame of dom.window.document.querySelectorAll('iframe')){assert.equal(frame.sandbox?.value||frame.getAttribute('sandbox'),'allow-scripts');assert.ok(!frame.getAttribute('sandbox').includes('same-origin'))}
  }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})


test('preview ink stays readable on actual bubble surfaces and keeps semantic color samples',()=>{
  const colors=previewColorPolicy()
  assert.equal(colors.contrast('#fff','#000'),21)
  assert.ok(colors.contrast('#777','#fff')<4.5)
  for(const [ink,bg,fallback]of [['#0F1115','#222','#eee'],['#fff','#f1f1f1','#171717'],['rgba(255,255,255,.05)','#222','#eee'],['color(srgb 1 1 1 / .1)','#222','#eee'],['transparent','#fff','#171717']]){
    const fixed=colors.choose(ink,bg,fallback)
    assert.ok(fixed);assert.ok(colors.contrast(fixed,bg)>=4.5)
  }
  assert.equal(colors.choose('#0F1115','#7AA2FF','#eee'),null)
  assert.equal(colors.choose('#4ADE80','#222','#eee'),null)
  assert.deepEqual(colors.theme('#eee','rgba(0,0,0,0)','#222'),{ink:'rgb(238, 238, 238)',surface:'rgb(34, 34, 34)'})
  assert.equal(colors.theme('#171717','color(srgb 1 1 1 / .5)','#141414').surface,'rgb(138, 138, 138)')
  const source='<div class="card">Normal layout</div><div class="swatch" style="background:#7AA2FF;color:#0F1115">#7AA2FF 主色</div><div style="background:#4ADE80">#4ADE80 通过</div><div data-color="#FBBF24" style="background:#FBBF24"></div>'
  const dom=new JSDOM(sanitizeMarkup(source))
  const samples=dom.window.document.querySelectorAll('[data-orivii-color-sample]')
  assert.equal(samples.length,3);assert.ok(!dom.window.document.querySelector('.card').hasAttribute('data-orivii-color-sample'))
  assert.equal(samples[0].style.backgroundColor,'rgb(122, 162, 255)')
  assert.equal(source.includes('data-orivii-color-sample'),false)
  dom.window.close()
})

test('the real host stores a visual attachment encrypted and previews it through the owner gateway contract',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-visual-'));let turn=0
  const host=new DotHost({extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(options){
    let block
    if(options.purpose)block={type:'text',text:'{}'}
    else if(turn++===0){assert.ok(options.tools.some(tool=>tool.name==='present_visual'));assert.ok(options.tools.some(tool=>tool.name==='send_chat_image'));assert.match(options.system,/图文/);block={type:'tool-call',id:'visual',name:'present_visual',arguments:JSON.stringify({spec:spec()})}}
    else block={type:'tool-call',id:'done',name:'finish_reply',arguments:JSON.stringify({text:'拖动滑块就能看到变化。',expression:'happy'})}
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }}}}},{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:root,password:'synthetic-visual-password',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}}),token=open.value.token
  const call=async(action,args={})=>{const reply=await host.command({action,token,...args});assert.ok(reply.ok,JSON.stringify(reply));return reply.value}
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,text:'做一个配置可视化',requestId:randomUUID()});await host.engine.jobs.get(job.id)?.promise
  const snapshot=await call('snapshot',{chatId:chat.id}),bubble=snapshot.messages.find(message=>message.attachments?.some(file=>file.name.endsWith('.orivii.json')))
  assert.ok(bubble);assert.equal(bubble.presentation.artifactOnly,true)
  assert.doesNotMatch(JSON.stringify(snapshot),/"op"|"calculations"|present_visual|synthetic-visual-password/)
  const file=bubble.attachments[0],encoded=await fs.readFile(path.join(root,'.dot-memory','files',file.id+host.vault.ext()),'utf8');assert.ok(!encoded.includes('参数与结果'))
  const preview=await call('filePreview',{id:file.id});assert.equal(preview.kind,'visual');assert.equal(preview.spec.title,'参数与结果')
  const codec=createDotRemote(z).descriptors[0].parameters[0].codec.create();assert.ok(codec.safeParse({action:'filePreview',token,id:file.id}).success);assert.ok(codec.safeParse({action:'markupPreview',token,format:'html',source:'<p>内容</p>'}).success)
  await call('lock');assert.equal((await host.command({action:'filePreview',token,id:file.id})).ok,false)
})
