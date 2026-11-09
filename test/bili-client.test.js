import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {JSDOM} from 'jsdom'
import {createBiliConnection} from '../src/bili-client.js'

test('new connection cards display a QR only for missing login, cancel on hiding and never replay historical QR',async()=>{
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{pretendToBeVisual:true}),saved={}
  for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  }
  let state='connected',hidden=false,calls=0
  Object.defineProperty(document,'hidden',{get:()=>hidden})
  const Connection=createBiliConnection(React,{rpc:async()=>({available:true,state,loginProvider:'scroll'}),fetcher:async(url)=>{
    calls++;assert.equal(url,'/api/bili-duty/login/start')
    return new Response(JSON.stringify({ok:true,key:'synthetic-key',qr:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='}))
  }}),root=createRoot(document.getElementById('app'))
  const render=async props=>{await act(async()=>{root.render(React.createElement(Connection,props));await new Promise(resolve=>setImmediate(resolve))})}
  try{
    await render({key:'connected',autoLogin:true,messageId:'connected'})
    assert.equal(calls,0);assert.match(document.body.textContent,/沿用原插件/)
    state='needs_login';await render({key:'new',autoLogin:true,messageId:'new'})
    assert.equal(calls,1);assert.match(document.querySelector('img').src,/^data:image\/png/)
    assert.doesNotMatch(document.body.textContent,/synthetic-key|bili_login_start/)
    hidden=true;await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')))
    assert.equal(document.querySelector('img'),null)
    hidden=false;await render({key:'remount',autoLogin:true,messageId:'new'});assert.equal(calls,1)
    await render({key:'history',autoLogin:false,messageId:'history'});assert.equal(calls,1)
  }finally{
    await act(async()=>root.unmount());dom.window.close()
    for(const [key,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]
  }
})
