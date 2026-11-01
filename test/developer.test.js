import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import Renderer,{act} from 'react-test-renderer'
import {createDeveloperPanel,developerDiff} from '../src/developer.js'

test('diagnostic comparison separates manual axes, learned preferences and interests',()=>{
  const before={profile:{fields:{}},companion:{axes:{humor:.5},axisLabels:{humor:'幽默'},interests:[]},knowledgeCount:0,memeCount:0}
  const after=structuredClone(before);after.profile.fields.preferences={value:'随意一些'};after.companion.interests.push({topic:'音乐'})
  assert.deepEqual(developerDiff(before,after).map(r=>r.kind),['用户印象','兴趣'])
  after.companion.axes.humor=.8;assert.equal(developerDiff(before,after)[0].kind,'人格参数')
})
test('developer panel starts off, reads only after opt-in, exposes sources and revokes on leaving',async()=>{
  const calls=[],sources=[],errors=[],state={profile:{fields:{preferences:{value:'简短些',sourceIds:['source']}}},companion:{axes:{humor:.5},axisLabels:{humor:'幽默'},emotions:{joy:.2},events:[],interests:[]}}
  const Panel=createDeveloperPanel(React,{rpc:async(action,args)=>{calls.push({action,args});if(action==='developerSnapshot')return {current:state,presentations:[],phase:'searching'};return {enabled:args.enabled}}})
  let ui;const props={chatId:'chat',active:true,onError:e=>errors.push(e),onSource:id=>sources.push(id)}
  await act(async()=>{ui=Renderer.create(React.createElement(Panel,props))})
  assert.equal(calls.length,0);assert.doesNotMatch(JSON.stringify(ui.toJSON()),/简短些|人格参数/)
  await act(async()=>ui.root.findByType('input').props.onChange({target:{checked:true}}))
  assert.equal(calls[0].action,'developerMode');assert.ok(calls.some(c=>c.action==='developerSnapshot'))
  assert.match(JSON.stringify(ui.toJSON()),/简短些|联网查资料/)
  await act(async()=>ui.root.findAllByType('button').find(b=>b.children.join('')==='查看原话').props.onClick())
  assert.deepEqual(sources,['source'])
  await act(async()=>ui.update(React.createElement(Panel,{...props,active:false})))
  assert.doesNotMatch(JSON.stringify(ui.toJSON()),/简短些/);assert.deepEqual(calls.at(-1),{action:'developerMode',args:{enabled:false}})
  await act(async()=>ui.unmount());assert.deepEqual(errors,[])
})
test('late enable response after unmount is revoked and cannot expose diagnostic data',async()=>{
  let resolve;const gate=new Promise(r=>{resolve=r}),calls=[]
  const Panel=createDeveloperPanel(React,{rpc:async(action,args)=>{calls.push({action,args});if(args.enabled)return gate;return {enabled:false}}})
  let ui,pending;await act(async()=>{ui=Renderer.create(React.createElement(Panel,{chatId:'chat',onError(){},onSource(){}}))})
  await act(async()=>{pending=ui.root.findByType('input').props.onChange({target:{checked:true}})})
  await act(async()=>ui.unmount());await act(async()=>{resolve({enabled:true});await pending})
  assert.equal(calls.filter(c=>c.action==='developerSnapshot').length,0);assert.equal(calls.at(-1).args.enabled,false)
})
