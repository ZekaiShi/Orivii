import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek'
import {DotHost} from '../src/host.js'

function response(blocks,reason='end_turn'){
  const events=[{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}}]
  blocks.forEach((content_block,index)=>events.push({type:'content_block_start',index,content_block},{type:'content_block_stop',index}))
  events.push({type:'message_delta',delta:{stop_reason:reason},usage:{output_tokens:2}},{type:'message_stop'})
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}})
}
const signedCall=(name,input,id='fixture-call')=>response([{type:'thinking',thinking:'INTERNAL_REASONING_ONLY',signature:'INTERNAL_SIGNATURE_ONLY'},{type:'tool_use',id,name,input}],'tool_use')

for(const background of [false,true])test('real DeepSeek serializer retains native thinking replay through '+(background?'hidden research':'foreground tools')+' without archiving it',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-replay-')),ctx=new Context();let host,checked=false
  await ctx.plugin(LlmRuntime)
  const adapter=new DeepSeekAdapter({options:()=>resolveAdapterOptions({baseURL:'https://synthetic.invalid',models:[{id:'deepseek-flash',contextWindow:128000}]}),resolveAuth:async()=>({headers:{Authorization:'Bearer fixture'}}),resolveUserId:()=> 'fixture',prepareExtensions:async()=>({fields:{},accept:async()=>{}})})
  const unregister=ctx.llm.registerAdapter(['fixture'],adapter)
  t.after(async()=>{await host?.dispose();unregister();await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true})})
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    const body=JSON.parse(init.body),system=JSON.stringify(body.system),research=system.includes('[ORIVII_RESEARCH]'),delivery=system.includes('[BACKGROUND_RESULT_DELIVERY]'),assistant=body.messages.findLast(m=>m.role==='assistant')
    if(delivery)return response([{type:'text',text:'资料核对完成。'}])
    if(!assistant)return background&&!research?signedCall('background_research',{objective:'public fixture',domain:'web'}):signedCall(background?'web_search':'discover_dsh_tools',background?{query:'public fixture'}:{})
    assert.equal(assistant.content[0].type,'thinking');assert.equal(assistant.content[0].thinking,'INTERNAL_REASONING_ONLY');assert.equal(assistant.content[0].signature,'INTERNAL_SIGNATURE_ONLY')
    const result=body.messages.at(-1).content.find(b=>b.type==='tool_result');assert.equal(result.tool_use_id,'fixture-call');checked=true
    return response([{type:'text',text:'资料核对完成。'}])
  })
  host=new DotHost({llm:ctx.llm,defaultModel:{currentSelection:()=>({provider:'fixture',model:'deepseek-flash'})},web:{search:async()=>({sources:[{url:'https://example.org/fact',title:'fixture',snippet:'verified fact'}]})},...(!background?{extension:{createExtension:()=>null}}:{})},{pointer:path.join(root,'pointer.json')})
  const opened=await host.command({action:'setup',workspace:root,plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  const token=opened.value.token,call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,text:'检查公开资料',requestId:randomUUID()})
  await host.engine.jobs.get(job.id)?.promise
  if(background){const end=Date.now()+6000;while(Date.now()<end){if((await host.vault.read()).catalog.backgroundResearch?.[0]?.status==='delivered')break;await new Promise(r=>setTimeout(r,20))}}
  assert.equal(checked,true)
  const snapshot=await call('snapshot',{chatId:chat.id});assert.equal(snapshot.messages.at(-1).text,'资料核对完成。')
  assert.doesNotMatch(JSON.stringify(await host.vault.read())+JSON.stringify(snapshot),/INTERNAL_REASONING_ONLY|INTERNAL_SIGNATURE_ONLY/)
})
