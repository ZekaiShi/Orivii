import test from 'node:test'
import assert from 'node:assert/strict'
import {visibleMessages} from '../src/core.js'

test('surface folding respects replacements and suppresses reasoning/tool content',()=>{
  const entry=(seq,type,data,surfaceOp='append')=>({type:'event',event:{seq,type,data,surfaceOp}})
  const records=[
    entry(1,'user/message',{role:'user',source:{kind:'user',rpcId:'request-1'},content:[{type:'text',text:'用户本次请求：\n你好'}]}),
    entry(2,'assistant/message',{message:{role:'assistant',source:{kind:'model'},content:[{type:'reasoning',text:'secret'},{type:'text',text:'old'}]}}),
    entry(3,'assistant/message',{message:{role:'assistant',source:{kind:'model'},content:[{type:'text',text:'new'}]}},{op:'replace',startSeq:2,endSeq:2}),
    entry(4,'tool/result',{message:{role:'tool',content:[{type:'text',text:'private'}]}}),
  ]
  assert.deepEqual(visibleMessages(records),[{seq:1,role:'user',text:'你好'},{seq:3,role:'assistant',text:'new'}])
})

test('runtime, skills, time, instructions, relays and unknown user-role sources never become chat bubbles',()=>{
  const kinds=['runtime-context','skill-catalog','time-context','agent-instructions','schedule','relay','future-private-context',undefined]
  const records=kinds.map((kind,i)=>({type:'event',event:{type:'user/message',seq:i+1,surfaceOp:'append',data:{role:'user',...(kind?{source:{kind}}:{}),content:[{type:'text',text:'internal-private-context-'+i}]}}}))
  assert.deepEqual(visibleMessages(records),[])
})

test('visibility depends on trusted source metadata rather than matching context text',()=>{
  const text='请解释 Current runtime context 和 <available_skills> 是什么意思'
  const records=[{type:'event',event:{type:'user/message',seq:1,time:123,surfaceOp:'append',data:{role:'user',source:{kind:'user',rpcId:'human-input'},content:[{type:'text',text}]}}}]
  assert.deepEqual(visibleMessages(records),[{seq:1,role:'user',text,time:123}])
})

test('event-type and role mismatches, unknown assistant producers and non-text blocks are withheld',()=>{
  const event=(seq,type,role,source)=>({type:'event',event:{seq,type,surfaceOp:'append',data:type==='user/message'?{role,source,content:[{type:'text',text:'private'}]}:{message:{role,source,content:[{type:'text',text:'private'}]}}}})
  assert.deepEqual(visibleMessages([
    event(1,'system/message','assistant',{kind:'model'}),
    event(2,'tool/result','assistant',{kind:'model'}),
    event(3,'user/message','assistant',{kind:'user'}),
    event(4,'assistant/message','assistant',{kind:'unknown'}),
    event(5,'assistant/message','assistant',undefined),
  ]),[])
  assert.deepEqual(visibleMessages([{type:'event',event:{seq:6,type:'assistant/message',surfaceOp:'append',data:{message:{role:'assistant',source:{kind:'model'},content:[{type:'reasoning',text:'private'},{type:'tool-call',arguments:{key:'private'}},{type:'text',text:{private:true}},null]}}}}]),[])
})
