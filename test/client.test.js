import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import React from 'react'
import {z} from 'zod'
import {renderToStaticMarkup} from 'react-dom/server'

test('package exposes the browser bundle required by the real DSH registry',async()=>{
  const root=new URL('../',import.meta.url)
  const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'))
  assert.equal(manifest.exports['./client'],'./dsh/client.js')
  assert.match(await readFile(new URL(manifest.exports['./client'],root),'utf8'),/window\.__ModuleLoader__\.load/)
  assert.ok(manifest.files.includes('dsh'))
})

async function register(saved={}){
  let plugin
  const registrations=[],disposed=[]
  const context={location:{host:'test'},localStorage:{getItem:()=>JSON.stringify(saved),setItem(){}},
    window:{__ModuleLoader__:{load({factory}){plugin=factory(name=>{if(name==='zod')return {z};assert.equal(name,'react');return React})}}},
    AbortController,Intl,Date,Map,Set,Object,Array,Number,JSON,Promise,crypto,setInterval,clearInterval,
  }
  vm.runInNewContext(await readFile(new URL('../dsh/client.js',import.meta.url),'utf8'),context)
  const ctx={remote:{$host:{home:'test'},session:{},async $mount(contribution){assert.equal(contribution.package,'dsh-companion');return async()=>{}}},slots:{
    inject(name,fn){fn()},register(options,component){registrations.push({options,component});return ()=>disposed.push(options.name)},
  },inject(dependencies,fn){assert.ok(dependencies.some(key=>['remote.dotCompanion','remote.session','remote.directoryPicker'].includes(key)));return Promise.resolve(fn(ctx))}}
  await plugin.apply(ctx)
  return {plugin,registrations,disposed}
}

test('native sidebar entry and central panel share one key alongside DSH automation, without document overlays',async()=>{
  const {plugin,registrations}=await register()
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('remote'))
  assert.ok(!plugin.inject.includes('remote.session'))
  const sidebar=registrations.find(r=>r.options.name==='sidebar.panellist')
  const panel=registrations.find(r=>r.options.name==='main')
  assert.equal(sidebar.options.label,'Orivii')
  assert.equal(sidebar.options.order,11)
  assert.equal(sidebar.options.id,panel.options.key)
  const icon=renderToStaticMarkup(React.createElement(sidebar.component,{size:16}))
  assert.match(icon,/<circle/)
  assert.match(icon,/fill="none"/)
  // There is no document object in this runtime: body append/overlays would fail registration.
})

test('locked panel exposes workspace and password form before rendering any private conversation',async()=>{
  const {registrations}=await register()
  const panel=registrations.find(r=>r.options.name==='main')
  const html=renderToStaticMarkup(React.createElement(panel.component))
  assert.match(html,/给 Orivii 一个自己的空间/)
  assert.match(html,/aria-label="Orivii 工作空间"/)
  assert.match(html,/type="password"/)
  assert.match(html,/<form/)
  assert.match(html,/创建工作空间/)
  assert.match(html,/浏览…/)
  assert.doesNotMatch(html,/class="(?:orb|launcher|creature|fish)"/)
  assert.doesNotMatch(html,/这是交互预览中的模拟回复/)
})

test('legacy plaintext preferences cannot unlock or expose the new private inbox',async()=>{
  const {registrations}=await register({name:'小鱼',sessions:[{id:'session-one',kind:'chat',title:'周三的讨论',createdAt:Date.now()}]})
  const panel=registrations.find(r=>r.options.name==='main')
  const html=renderToStaticMarkup(React.createElement(panel.component))
  assert.doesNotMatch(html,/周三的讨论/)
  assert.doesNotMatch(html,/class="dot-thread is-active"/)
  const source=await readFile(new URL('../src/client.js',import.meta.url),'utf8')
  assert.doesNotMatch(source,/session\.(create|prompt)\(/)
  assert.doesNotMatch(source,/(localStorage|sessionStorage)\.setItem/)
})
