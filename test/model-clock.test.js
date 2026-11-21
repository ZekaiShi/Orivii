import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'

const sentAt=Date.parse('2026-11-20T17:24:00Z')
const answer='我来帮你挑一个。'
const textBlock=text=>({type:'text',text})

async function fixture(t,generate){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-model-clock-'))
  const requests=[]
  const services={
    defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},
    llm:{async prepareCall(config){
      return {config,context:{contextWindow:128000},async *stream(options){
        const block=options.purpose?textBlock('{}'):generate(options,requests.push(options))
        yield {type:'block-end',index:0,block}
        yield {type:'finish',reason:{kind:'stop'}}
      }}
    }},
  }
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const setup=await host.command({action:'setup',workspace:root,plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}})
  assert.equal(setup.ok,true,JSON.stringify(setup))
  const call=async(action,args={})=>{
    const result=await host.command({action,token:setup.value.token,...args})
    assert.equal(result.ok,true,JSON.stringify(result))
    return result.value
  }
  await call('extension',{request:{operation:'savePolicy',policy:{enabled:false,analysisEnabled:false,timeZone:'America/New_York'}}})
  const chat=await call('createChat')
  async function send({timeZone}={}){
    const job=await call('send',{chatId:chat.id,text:'我都行。',requestId:randomUUID(),...(timeZone===undefined?{}:{timeZone})})
    await host.engine.jobs.get(job.id)?.promise
    const snapshot=await call('snapshot',{chatId:chat.id})
    assert.equal(snapshot.jobs.find(row=>row.id===job.id).status,'done')
    assert.equal(snapshot.messages.at(-1).text,answer)
    return snapshot.messages.find(message=>message.id===job.userId)
  }
  return {requests,send}
}

test('browser time zone crosses UTC midnight and each tool round gets a fresh clock with a stable message time',async t=>{
  t.mock.timers.enable({apis:['Date'],now:sentAt})
  const {requests,send}=await fixture(t,(_options,round)=>{
    if(round>1)return textBlock(answer)
    t.mock.timers.setTime(sentAt+18000)
    return {type:'tool-call',id:'clock-search',name:'memory_search',arguments:JSON.stringify({query:'样例'})}
  })
  const message=await send({timeZone:'Asia/Shanghai'})
  assert.equal(message.time,sentAt)
  assert.equal(requests.length,2)
  const expectedTimes=['2026-11-21T01:24:00+08:00','2026-11-21T01:24:18+08:00']
  for(const [index,request] of requests.entries()){
    assert.ok(request.system.includes(`本次调用的当前时间：${expectedTimes[index]}（Asia/Shanghai）。`))
    assert.ok(request.system.includes('本会话最近一条用户消息的发送时间：2026-11-21T01:24:00+08:00。'))
    const user=request.messages.findLast(row=>row.role==='user')
    assert.match(user.content[0].text,/2026-11-21T01:24:00\+08:00 · 消息 /)
    assert.ok(user.content[0].text.endsWith('\n我都行。'))
  }
  assert.doesNotMatch(requests[1].system,/本次调用的当前时间：2026-11-21T01:24:00/)
})

test('older clients and invalid browser zones use the configured workspace zone',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-07-20T17:24:00Z')})
  const {requests,send}=await fixture(t,()=>textBlock(answer))
  await send()
  await send({timeZone:'Not/A-Time-Zone'})
  assert.equal(requests.length,2)
  for(const request of requests){
    assert.ok(request.system.includes('本次调用的当前时间：2026-07-20T13:24:00-04:00（America/New_York）。'))
    assert.ok(request.system.includes('本会话最近一条用户消息的发送时间：2026-07-20T13:24:00-04:00。'))
    assert.doesNotMatch(request.system,/Not\/A-Time-Zone/)
  }
})
