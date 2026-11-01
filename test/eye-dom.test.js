import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {JSDOM} from 'jsdom'
import {createDotEye} from '../src/eye.js'

test('real SVG receives a new bubble reaction once, stops off-panel/hidden, and clears on unmount',async()=>{
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{pretendToBeVisual:true}),saved={}
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  }
  let hidden=false,reduced=false,mediaChange
  Object.defineProperty(dom.window.document,'hidden',{get:()=>hidden})
  dom.window.matchMedia=()=>({get matches(){return reduced},addEventListener(_event,fn){mediaChange=fn},removeEventListener(){}})
  const Eye=createDotEye(React),root=createRoot(document.getElementById('app')),controllerRef={current:null},start=Date.now()
  const message=(id,time,expression)=>({id,time,role:'assistant',presentation:{expression}})
  let props={name:'小圆',phase:null,input:false,enabled:true,active:true,chatId:'a',historyReady:true,messages:[message('old',start-1000,'agree')],controllerRef}
  const render=async patch=>{props={...props,...patch};await act(async()=>root.render(React.createElement(Eye,props)))}
  try{
    await render({});assert.equal(controllerRef.current.mode,'idle','history is not replayed')
    const outerCircle=document.querySelector('.dot-eye-outline'),outerShape=['cx','cy','r','stroke-width'].map(key=>outerCircle.getAttribute(key))
    assert.equal(document.querySelector('.dot-eye-lid-masks').getAttribute('stroke'),'none','closed masking edges cannot appear as cylinder walls')
    for(const edge of document.querySelectorAll('.dot-eye-upper-edge,.dot-eye-lower-edge'))assert.equal(edge.getAttribute('d').match(/[A-Z]/g).join(''),'MQ','only the lid arc is stroked')
    const original=document.querySelector('.dot-eye-pupil').getAttribute('d')
    await render({messages:[...props.messages,message('new',start+1000,'agree')]})
    assert.equal(controllerRef.current.mode,'agree')
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,80))})
    assert.notEqual(document.querySelector('.dot-eye-pupil').getAttribute('d'),original)
    const until=controllerRef.current.reaction.until
    await render({messages:[...props.messages]});assert.equal(controllerRef.current.reaction.until,until)
    await render({active:false});assert.equal(controllerRef.current.frame,null);assert.equal(controllerRef.current.timer,null)
    assert.equal(document.querySelector('.dot-eye').dataset.eyeAnimated,'false')
    await render({active:true});assert.equal(controllerRef.current.mode,'idle')
    await act(async()=>{hidden=true;document.dispatchEvent(new dom.window.Event('visibilitychange'))})
    assert.equal(controllerRef.current.timer,null)
    await render({messages:[...props.messages,message('hidden',start+2000,'blocked')]})
    await act(async()=>{hidden=false;document.dispatchEvent(new dom.window.Event('visibilitychange'))})
    assert.equal(controllerRef.current.mode,'idle')
    await render({phase:'searching'});assert.equal(controllerRef.current.mode,'searching')
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550))})
    assert.equal(document.querySelector('.dot-eye-flow').getAttribute('opacity'),'1')
    assert.equal(document.querySelector('.dot-eye-pupil').getAttribute('opacity'),'0')
    assert.equal(document.querySelectorAll('.dot-eye-flow-track rect').length,2)
    assert.equal(document.querySelector('.dot-eye').dataset.eyeState,'searching')
    await act(async()=>{hidden=true;document.dispatchEvent(new dom.window.Event('visibilitychange'))})
    assert.equal(document.querySelector('.dot-eye').dataset.eyeAnimated,'false')
    await act(async()=>{hidden=false;document.dispatchEvent(new dom.window.Event('visibilitychange'))})
    await act(async()=>{reduced=true;mediaChange()})
    assert.equal(controllerRef.current.timer,null);assert.equal(controllerRef.current.frame,null)
    assert.equal(document.querySelector('.dot-eye').dataset.eyeAnimated,'false')
    assert.match(document.querySelector('.dot-eye').getAttribute('aria-label'),/小圆.*查资料/)
    await render({phase:null,chatId:'b',messages:[message('other-history',start+3000,'happy')]})
    assert.equal(controllerRef.current.mode,'idle')
    assert.equal(document.querySelector('.dot-eye-flow').getAttribute('opacity'),'0')
    assert.equal(document.querySelector('.dot-eye-pupil').getAttribute('opacity'),'1')
    await render({messages:[...props.messages,message('new-punctuation',start+4000,'confused')]})
    assert.equal(controllerRef.current.mode,'confused')
    assert.equal(document.querySelector('.dot-eye-symbol-side').getAttribute('opacity'),'1')
    for(const path of document.querySelectorAll('.dot-eye-symbol-side path'))assert.equal(path.getAttribute('fill'),'none','question strokes cannot inherit a black fill in light previews')
    assert.equal(document.querySelectorAll('.dot-eye-symbol-dot[opacity="1"]').length,3)
    assert.doesNotMatch(document.getElementById('app').textContent,/confused/)
    await render({phase:'responding',livePresentation:{id:'live-heart',expression:'heart'}})
    assert.equal(controllerRef.current.mode,'heart','declared state can accompany a running response')
    assert.equal(document.querySelector('.dot-eye-affection').getAttribute('opacity'),'1')
    assert.equal(document.querySelectorAll('.dot-eye-heart-spark').length,6)
    assert.match(document.querySelector('.dot-eye-symbol').getAttribute('transform'),/scale\(0\.78\)/)
    const liveUntil=controllerRef.current.reaction.until
    await render({livePresentation:{id:'live-heart',expression:'heart'}})
    assert.equal(controllerRef.current.reaction.until,liveUntil,'polling does not replay state')
    await render({phase:null,livePresentation:null,messages:[...props.messages,message('live-heart',start+5000,'heart')]})
    assert.equal(controllerRef.current.reaction.until,liveUntil,'completion retains the stream reaction deadline')
    await render({phase:'searching'})
    assert.equal(controllerRef.current.mode,'searching','real tool state takes priority')
    await render({phase:null,messages:[...props.messages,message('smile',start+6000,'happy')]})
    assert.equal(document.querySelector('.dot-eye-outline'),outerCircle,'every expression keeps the same circle node')
    assert.deepEqual(['cx','cy','r','stroke-width'].map(key=>outerCircle.getAttribute(key)),outerShape,'smiling does not resize the body')
    assert.equal(outerCircle.getAttribute('opacity')??'1','1','the original circle remains complete')
    assert.equal(outerCircle.getAttribute('mask'),null)
    assert.equal(document.querySelector('.dot-eye-face').getAttribute('opacity'),'0','no extra inner lid remains')
    assert.equal(document.querySelector('.dot-eye-smile').getAttribute('opacity'),'1')
    assert.equal(document.querySelector('.dot-eye-smile').getAttribute('fill'),'currentColor')
    assert.equal(document.querySelector('.dot-eye-smile').getAttribute('stroke'),'currentColor')
    assert.equal(document.querySelector('.dot-eye-smile').getAttribute('fill-opacity'),'0')
    const smileEyes=document.querySelectorAll('.dot-eye-smile-eye')
    assert.equal(smileEyes.length,2);assert.notEqual(smileEyes[0].getAttribute('d'),smileEyes[1].getAttribute('d'))
    assert.equal(document.querySelector('.dot-eye-smile-pupil'),null,'the reference drawing is not copied into a new character')
    for(const [i,expression] of ['angry','sad','relieved','skeptical','shy','excited'].entries()){
      await render({messages:[...props.messages,message('micro-'+i,start+7000+i,expression)]})
      assert.equal(controllerRef.current.mode,expression)
      assert.deepEqual(['cx','cy','r','stroke-width'].map(key=>outerCircle.getAttribute(key)),outerShape)
      if(['angry','sad','relieved','skeptical','shy'].includes(expression)){
        assert.equal(document.querySelector('.dot-eye-face').getAttribute('opacity'),'0')
        assert.equal(document.querySelector('.dot-eye-smile').getAttribute('opacity'),'0')
        assert.equal(document.querySelector('.dot-eye-micro').getAttribute('opacity'),'1')
        assert.equal(document.querySelectorAll('.dot-eye-micro-lid').length,2)
        for(const lid of document.querySelectorAll('.dot-eye-micro-lid'))assert.equal(lid.getAttribute('stroke-linecap'),'round')
        for(const pupil of document.querySelectorAll('.dot-eye-micro-pupil'))assert.equal(pupil.getAttribute('opacity'),expression==='relieved'?'0':'1')
      }
      if(expression==='shy')assert.equal(document.querySelector('.dot-eye-blush').getAttribute('opacity'),'0.6')
    }
    await render({phase:'responding',messages:[...props.messages,message('committed-first',start+9000,'angry')]})
    assert.equal(controllerRef.current.mode,'angry','a committed bubble is not discarded while the running flag catches up')
    const committedUntil=controllerRef.current.reaction.until
    await render({messages:[...props.messages]});assert.equal(controllerRef.current.reaction.until,committedUntil)
    await render({phase:null});assert.equal(controllerRef.current.mode,'angry')
    await render({phase:'searching',presentationEvents:[]})
    const events=[{id:1,jobId:'journal-job',messageId:'stage1',expression:'agree',time:Date.now()}]
    await render({presentationEvents:events});assert.equal(controllerRef.current.mode,'agree','stage acknowledgement can briefly precede ongoing search')
    await render({presentationEvents:[...events]});assert.equal(controllerRef.current.reaction.expression,'agree')
    await render({input:true});assert.equal(controllerRef.current.mode,'input')
    await render({input:false,phase:'searching',presentationEvents:[...events,{id:2,jobId:'journal-job',messageId:'stage2',expression:'skeptical',time:Date.now()}]})
    assert.equal(controllerRef.current.mode,'skeptical')
    hidden=true;await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')))
    await render({presentationEvents:[...events,{id:3,jobId:'journal-job',messageId:'stage3',expression:'happy',time:Date.now()}]})
    hidden=false;await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')))
    await render({presentationEvents:[...props.presentationEvents]});assert.equal(controllerRef.current.mode,'searching','hidden stage is not replayed')
    await act(async()=>root.unmount());assert.equal(controllerRef.current,null)
  }finally{
    if(controllerRef.current)await act(async()=>root.unmount())
    dom.window.close()
    for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}
  }
})
