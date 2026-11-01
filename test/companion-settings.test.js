import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import Renderer,{act} from 'react-test-renderer'
import {createCompanionSettings} from '../src/companion-settings.js'

const axes={warmth:'温暖',assertiveness:'主见',humor:'幽默',playfulness:'俏皮',verbosity:'详略',formality:'正式',initiative:'主动',curiosity:'好奇'}
const card={version:1,template:'blank',label:'白纸',description:'保留我的描述',axes:Object.fromEntries(Object.keys(axes).map(k=>[k,.5])),interests:['音乐'],examples:['嗨']}
const views={persona:{axes,card,templates:[{id:'blank',label:'白纸',axes:card.axes},{id:'playful',label:'活泼',axes:{...card.axes,humor:.8}}]},care:{policy:{enabled:true,quietStart:'23:00',quietEnd:'08:00',timeZone:'Asia/Shanghai'}},privacy:{encrypted:true,policy:{analysisEnabled:true,allowTasks:true}},tasks:{tasks:[]}}
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
async function fixture(t,section,handler){
  const calls=[],errors=[],downloads=[]
  const Component=createCompanionSettings(React,{rpc:async(action,{request})=>{
    calls.push({action,request})
    if(handler){const result=handler(request);if(result!==undefined)return result}
    if(request.operation==='view')return structuredClone(views[request.section])
    if(request.operation==='saveCard')return request.card
    if(request.operation==='exportCard')return {encryptedCard:'ENCRYPTED_CARD'}
    return {}
  },markdown:text=>React.createElement('p',null,text),download:text=>downloads.push(text)})
  let ui;const props={section,onError:e=>errors.push(e),onSource:()=>{},onMemories:()=>{}}
  await act(async()=>{ui=Renderer.create(React.createElement(Component,props))})
  t.after(async()=>{await act(async()=>ui.unmount())})
  const button=label=>ui.root.findAllByType('button').find(b=>b.children.join('')===label)
  const click=label=>act(async()=>{await button(label).props.onClick()})
  return {ui,Component,props,calls,errors,downloads,button,click}
}
test('community privacy settings retain permission controls without unavailable private card actions',async t=>{
  const {ui,button,calls}=await fixture(t,'privacy',request=>request.operation==='view'?{...views.privacy,personaAvailable:false}:undefined)
  assert.equal(button('导出加密备份'),undefined);assert.equal(button('导入这份偏好'),undefined)
  assert.equal(button('修正对近况的理解'),undefined)
  assert.ok(button('查看聊过的重要内容'));assert.equal(ui.root.findAllByProps({type:'checkbox'}).length,2)
  await act(async()=>ui.root.findAllByProps({type:'checkbox'})[1].props.onChange({target:{checked:false}}))
  assert.deepEqual(calls.at(-1).request,{operation:'savePolicy',policy:{allowTasks:false}})
})

test('persona preset preserves personal instructions and saves only the edited card',async t=>{
  const {ui,calls,click,button,errors}=await fixture(t,'persona')
  assert.deepEqual(calls[0],{action:'extension',request:{operation:'view',section:'persona'}})
  assert.equal(button('保存相处方式').props.disabled,true)
  assert.equal(ui.root.findAllByProps({type:'range'}).length,8)
  assert.equal(ui.root.findByProps({className:'dot-advanced'}).props.open,undefined)
  await act(async()=>ui.root.findByType('select').props.onChange({target:{value:'playful'}}))
  await click('保存相处方式')
  assert.deepEqual(calls.at(-1).request.card,{...card,template:'playful',label:'活泼',axes:{...card.axes,humor:.8}})
  assert.equal(button('保存相处方式').props.disabled,true);assert.deepEqual(errors,[])
})
test('care sends field patches, preserves unsaved time drafts, and does not show scheduling internals',async t=>{
  const {ui,calls,click}=await fixture(t,'care')
  await act(async()=>ui.root.findAllByProps({type:'time'})[0].props.onChange({target:{value:'22:30'}}))
  await act(async()=>ui.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:false}}))
  assert.deepEqual(calls.at(-1).request,{operation:'savePolicy',policy:{enabled:false}})
  assert.equal(ui.root.findAllByProps({type:'time'})[0].props.value,'22:30')
  await click('保存时间偏好')
  assert.deepEqual(calls.at(-1).request,{operation:'savePolicy',policy:{quietStart:'22:30'}})
  assert.doesNotMatch(JSON.stringify(ui.toJSON()),/心跳|intervalMinutes|cooldown|dailyLimit|reminders|评分|后台评估/)
  assert.equal(ui.root.findAllByProps({type:'number'}).length,0)
})
test('privacy exports a file without rendering ciphertext, clears passwords, and imports selected data',async t=>{
  const {ui,calls,click,downloads,errors}=await fixture(t,'privacy')
  await act(async()=>ui.root.findAllByProps({type:'checkbox'})[1].props.onChange({target:{checked:false}}))
  assert.deepEqual(calls.at(-1).request,{operation:'savePolicy',policy:{allowTasks:false}})
  await act(async()=>ui.root.findByProps({type:'password'}).props.onChange({target:{value:'test-only-password'}}))
  await click('导出加密备份')
  assert.equal(ui.root.findByProps({type:'password'}).props.value,'')
  assert.deepEqual(downloads,['ENCRYPTED_CARD']);assert.doesNotMatch(JSON.stringify(ui.toJSON()),/ENCRYPTED_CARD/)
  const payload=JSON.stringify({format:'dot-persona-card'}),target={files:[{name:'example.dotcard',size:payload.length,text:async()=>payload}],value:'file'}
  await act(async()=>ui.root.findByProps({type:'file'}).props.onChange({target}))
  await act(async()=>ui.root.findByProps({type:'password'}).props.onChange({target:{value:'test-only-password'}}))
  await click('导入这份偏好')
  assert.equal(calls.at(-1).request.operation,'importCard');assert.equal(calls.at(-1).request.encryptedCard,payload)
  assert.equal(ui.root.findByProps({type:'password'}).props.value,'');assert.equal(target.value,'');assert.deepEqual(errors,[])
})
test('late private response after leaving a panel cannot trigger a download',async t=>{
  const gate=deferred(),{ui,button,downloads}=await fixture(t,'privacy',request=>request.operation==='exportCard'?gate.promise:undefined)
  await act(async()=>ui.root.findByProps({type:'password'}).props.onChange({target:{value:'test-only-password'}}))
  let pending;await act(async()=>{pending=button('导出加密备份').props.onClick()});await act(async()=>ui.unmount())
  await act(async()=>{gate.resolve({encryptedCard:'PRIVATE_LATE_RESPONSE'});await pending});assert.deepEqual(downloads,[])
})
test('work records load separately from settings and request only that section',async t=>{
  const {ui,calls}=await fixture(t,'tasks')
  assert.deepEqual(calls[0].request,{operation:'view',section:'tasks'})
  assert.doesNotMatch(JSON.stringify(ui.toJSON()),/心跳|人格|主动提醒|allowTasks/)
  assert.equal(ui.root.findAllByType('input').length,0)
})
