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
