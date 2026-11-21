import {DotError} from './vault.js'
import {publicBubble} from './expression.js'

// Optional host-only presentation policy. Its implementation and configuration
// are supplied by the installed extension, never sent to the browser.
export function responseText(vault,text,{partial=false,...context}={}){
  const policy=vault.responsePolicy,method=partial?'preview':'filter'
  if(!policy)return text
  try{
    const result=policy[method](text,context)
    if(typeof result!=='string'||result.length>200000||!partial&&text.trim()&&!result.trim()&&policy.allowEmpty!==true)throw new Error('invalid policy result')
    return result
  }catch{
    if(partial)return ''
    throw new DotError('这条回复暂时无法显示，请重试。','presentation')
  }
}
export function responseBubble(vault,message,context){
  const bubble=publicBubble(message)
  if(bubble.role!=='assistant')return bubble
  return {...bubble,text:responseText(vault,bubble.text,context)}
}

// Project only the history sent to the model. Keep archived messages and their
// searchable text intact, including literal answers to earlier user questions.
export function projectResponseHistory(vault,state){
  const jobs=new Map((state.catalog.jobs||[]).map(job=>[job.id,job.userId]))
  const users=new Map(),lastUser=new Map(),projected=new Map(),messages=[]

  for(const message of state.short.messages){
    if(message.role==='user'){
      users.set(message.id,message)
      lastUser.set(message.chatId,message)
      messages.push(message)
      continue
    }
    const background=message.origin||message.taskId||message.reminderId||message.followupId||message.activity||message.connection||message.attachments?.length||message.presentation?.artifactOnly
    let source
    if(!background){
      source=message.jobId?users.get(jobs.get(message.jobId)):lastUser.get(message.chatId)
    }
    const context=source&&source.chatId===message.chatId?{
      state:{short:{messages:[source]}},
      scope:{chatId:message.chatId,userId:source.id,kind:'history'},
    }:undefined
    const bubble=responseBubble(vault,message,context)
    projected.set(bubble.id,bubble.text)
    if(bubble.text.trim()||bubble.attachments?.length||bubble.connection)messages.push(bubble)
  }

  const continuity=state.catalog.continuity
  const recent=continuity?.recent?.flatMap(message=>{
    if(!projected.has(message.id))return [message]
    const text=projected.get(message.id).slice(0,600)
    return text.trim()?[{...message,text}]:[]
  })
  return {...state,short:{...state.short,messages},catalog:recent?{...state.catalog,continuity:{...continuity,recent}}:state.catalog}
}
