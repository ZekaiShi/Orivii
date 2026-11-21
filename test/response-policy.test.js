import test from 'node:test'
import assert from 'node:assert/strict'
import {responseText,responseBubble} from '../src/response-policy.js'

test('optional policies stay host-local and only project assistant bubbles',()=>{
  const vault={responsePolicy:{preview:()=>'',filter:t=>t.replaceAll('SYNTHETIC_SOURCE','SYNTHETIC_VISIBLE')}}
  const user={role:'user',text:'SYNTHETIC_SOURCE'},assistant={role:'assistant',text:'SYNTHETIC_SOURCE'}
  assert.equal(responseBubble(vault,user),user)
  assert.equal(responseBubble(vault,assistant).text,'SYNTHETIC_VISIBLE')
  assert.equal(assistant.text,'SYNTHETIC_SOURCE')
  assert.equal(responseText(vault,'SYNTHETIC_SOURCE',{partial:true}),'')
  assert.equal(responseText({},'unchanged'),'unchanged')
})

test('broken policy output fails closed without putting private errors in the UI',()=>{
  for(const result of [undefined,null,{},Promise.resolve('private'), '']){
    const vault={responsePolicy:{filter:()=>result,preview:()=>{throw new Error('PRIVATE_POLICY')}}}
    assert.throws(()=>responseText(vault,'source'),e=>e.code==='presentation'&&!e.message.includes('PRIVATE_POLICY'))
    assert.equal(responseText(vault,'source',{partial:true}),'')
  }
})

test('request context reaches a host policy without becoming part of the visible reply',()=>{
  const state={short:{messages:[]}},scope={chatId:'synthetic-chat',userId:'synthetic-user',jobId:'synthetic-job',kind:'reply'},seen=[]
  const vault={responsePolicy:{preview:(text,context)=>{seen.push(context);return text},filter:text=>text}}
  assert.equal(responseText(vault,'Visible text',{partial:true,state,scope}),'Visible text')
  assert.deepEqual(seen,[{state,scope}])
  assert.equal(responseText(vault,'Final text'),'Final text')
})

test('whole-reply suppression is an explicit host policy capability',()=>{
  const vault={responsePolicy:{allowEmpty:true,filter:()=>'',preview:()=>''}}
  assert.equal(responseText(vault,'Synthetic omitted text'),'')
  assert.equal(responseBubble(vault,{role:'assistant',text:'Synthetic omitted text'}).text,'')
  for(const allowEmpty of [undefined,false,'true'])assert.throws(()=>responseText({responsePolicy:{allowEmpty,filter:()=>''}},'source'),e=>e.code==='presentation')
})
