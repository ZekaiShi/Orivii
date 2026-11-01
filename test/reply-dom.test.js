import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {JSDOM} from 'jsdom'
import {createPacedReply,nextReplyText} from '../src/reply.js'

test('reply pacing ticks every 100ms, survives final delivery, skips history and cleans up hidden/removed messages',async()=>{
  const dom=new JSDOM('<div id="app"></div>',{pretendToBeVisual:true}),saved={}
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  }
  let now=0,serial=0,hidden=false,reduced=false,mediaChange
  const timers=new Map(),win=dom.window
  win.setTimeout=(fn,delay)=>{timers.set(++serial,{fn,at:now+delay});return serial}
  win.clearTimeout=id=>timers.delete(id)
  Object.defineProperty(win.document,'hidden',{get:()=>hidden})
  win.matchMedia=()=>({get matches(){return reduced},addEventListener(_event,fn){mediaChange=fn},removeEventListener(){}})
  const advance=async ms=>{const end=now+ms;while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;timers.delete(next[0]);await act(async()=>next[1].fn())}now=end}
  const Pacer=createPacedReply(React),root=createRoot(document.getElementById('app'))
  let props={message:{id:'one',text:'一二三四五六七八九十甲乙',live:true},pace:true,render:m=>React.createElement('div',{'data-live':Boolean(m.live)},m.text)}
  const render=async patch=>{props={...props,...patch};await act(async()=>root.render(React.createElement(Pacer,props)))}
  const output=()=>document.getElementById('app').firstElementChild
  try{
    await render({});const node=output()
    assert.equal(node.textContent,'一二三四')
    await advance(99);assert.equal(node.textContent,'一二三四')
    await advance(1);assert.equal(node.textContent,'一二三四五六七八')
    await render({message:{...props.message,live:false,text:props.message.text+'丙丁'}})
    assert.equal(node.textContent,'一二三四五六七八','final delivery cannot bypass the display buffer')
    await advance(100);assert.equal(node.textContent,'一二三四五六七八九十甲乙')
    await advance(100);assert.equal(node.textContent,props.message.text);assert.equal(output(),node);assert.equal(node.dataset.live,'false');assert.equal(timers.size,0)
    await render({message:{...props.message,text:props.message.text+'长一点的新内容'}})
    assert.equal(timers.size,1)
    await act(async()=>{hidden=true;document.dispatchEvent(new win.Event('visibilitychange'))})
    assert.equal(timers.size,0);assert.equal(node.textContent,props.message.text)
    await act(async()=>{hidden=false;document.dispatchEvent(new win.Event('visibilitychange'))})
    assert.equal(timers.size,0,'returning does not replay buffered text')
    await render({pace:false,message:{id:'history',text:'完整历史消息，不逐字补播。'}})
    assert.equal(node.textContent,props.message.text);assert.equal(timers.size,0)
    await render({pace:true,message:{id:'history',text:props.message.text+'新增段落也需要完整显示。'}})
    await act(async()=>{reduced=true;mediaChange()})
    assert.equal(node.textContent,props.message.text);assert.equal(timers.size,0)
    await act(async()=>{reduced=false;mediaChange()})
    await render({message:{...props.message,text:props.message.text+'最后一批文字'}})
    assert.equal(timers.size,1)
    await act(async()=>root.unmount());assert.equal(timers.size,0,'lock/unmount removes scheduled work')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
  }
})

test('pacing preserves emoji graphemes and does not make long replies take minutes',()=>{
  assert.equal(nextReplyText('','你👩‍👩‍👧‍👦好❤️再见'),'你👩‍👩‍👧‍👦好❤️')
  const target='字'.repeat(12000);let shown='',beats=0
  while(shown!==target&&beats<100){shown=nextReplyText(shown,target);beats++}
  assert.equal(shown,target);assert.ok(beats<=80)
})
