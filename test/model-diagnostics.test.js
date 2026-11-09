import test from 'node:test'
import assert from 'node:assert/strict'
import {modelFailure} from '../src/model-diagnostics.js'
import {DotEngine} from '../src/engine.js'

test('fixed model probe exercises real chat schemas without sending a conversation or executing tools',async()=>{
  const calls=[],state={catalog:{settings:{},chats:[],jobs:[]},short:{messages:[]}}
  const services={extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,async *stream(options){calls.push(options);yield {type:'finish',reason:options.tools.length?{kind:'error',failure:{code:'INVALID_REQUEST',message:'Bad tool schema',status:400}}:{kind:'stop'}}}}}}}
  const engine=new DotEngine({read:async()=>state},services),result=await engine.probeModel(new AbortController().signal)
  assert.equal(result.results[0].ok,true);assert.equal(result.results[1].failure.message,'Bad tool schema')
  assert.equal(calls.length,5);assert.equal(calls[3].messages[0].role,'assistant');assert.equal(calls[4].messages.at(-1).role,'assistant')
  assert.ok(calls[1].tools.some(t=>t.name==='create_chat_file'));assert.deepEqual(result.invalidSchemas,[])
  assert.deepEqual(state.catalog.jobs,[])
  const syntheticKey='sk-'+'synthetic'.repeat(4)
  assert.doesNotMatch(JSON.stringify(modelFailure({code:'AUTH',message:`Bearer private-secret ${syntheticKey} https://secret.invalid/?token=value cookie=session-secret`})),/private-secret|sk-synthetic|secret.invalid|session-secret/)
})
