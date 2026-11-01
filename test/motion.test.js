import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {JSDOM} from 'jsdom'
import {createDotMotion} from '../src/motion.js'

test('closing surfaces become inert, rapid reopen cancels removal, privacy and reduced motion remove immediately',async()=>{
  const dom=new JSDOM('<!doctype html><div id="app"></div>'),saved={}
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  }
  let reduced=false,changed
  dom.window.matchMedia=()=>({get matches(){return reduced},addEventListener(_name,fn){changed=fn},removeEventListener(){}})
  const {Motion}=createDotMotion(React),root=createRoot(document.getElementById('app'))
  const render=async(show,immediate=false)=>act(async()=>root.render(React.createElement(Motion,{show,immediate},React.createElement('aside',null,React.createElement('button',null,'私密设置')))))
  const wait=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,210)))
  try{
    await render(true);await render(false)
    assert.equal(document.querySelector('aside').getAttribute('aria-hidden'),'true')
    assert.ok(document.querySelector('aside').hasAttribute('inert'))
    await render(true);await wait()
    assert.ok(document.querySelector('aside'),'old exit timer cannot remove a reopened surface')
    assert.equal(document.querySelector('aside').hasAttribute('inert'),false)
    await render(false);await wait();assert.ok(!document.querySelector('aside'))
    await render(true);await render(false,true)
    assert.equal(document.body.textContent.includes('私密设置'),false,'locking does not keep private DOM during an exit')
    await render(true);await act(async()=>{reduced=true;changed()});await render(false)
    assert.ok(!document.querySelector('aside'),'reduced motion has no delayed closing')
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
  }
})

test('disclosure animation can reverse mid-close and preserves its original overflow',()=>{
  const dom=new JSDOM('<!doctype html><section><details><summary>高级选项</summary><p>设置内容</p></details></section>')
  const section=dom.window.document.querySelector('section'),details=section.firstChild,summary=details.firstChild,animations=[]
  details.style.overflow='visible'
  details.getBoundingClientRect=()=>({height:details.open?160:30})
  details.animate=(frames,options)=>{const animation={frames,options,cancel(){this.oncancel?.()}};animations.push(animation);return animation}
  const {animateDisclosure}=createDotMotion(React),click=()=>animateDisclosure({target:summary,currentTarget:section,preventDefault(){}})
  click();assert.equal(details.open,true);animations.at(-1).onfinish()
  click();assert.equal(details.open,true,'content stays visible while its height closes')
  click();animations.at(-1).onfinish()
  assert.equal(details.open,true,'second click reverses a close')
  assert.equal(details.style.overflow,'visible')
  click();animations.at(-1).onfinish();assert.equal(details.open,false)
  assert.equal(details.style.overflow,'visible')
  dom.window.close()
})
