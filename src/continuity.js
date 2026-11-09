// Workspace continuity is data with provenance, never an independent persona.
export function continuityOf(state) {
  return state.catalog.continuity??={version:1,revision:0,recent:[],topic:null,threads:[],activity:null,delivery:[]}
}
export function advanceContinuity(state,message) {
  const c=continuityOf(state)
  c.revision++;c.updatedAt=message.time
  c.recent=[...c.recent.filter(m=>m.id!==message.id),{id:message.id,chatId:message.chatId,role:message.role,time:message.time,text:message.text.slice(0,600),origin:message.origin||'text'}].slice(-16)
}
export const CONTINUITY_PROMPT='另外输出 continuity:{topic:{text,sourceId,quote},threads:[{text,sourceId,quote,resolves?}]}。topic 简述这轮聊到哪里；threads 只记明确未结束的问题或承诺，不猜测。每项 quote 必须是本轮气泡逐字证据，text 不超过240字。若明确结束已有事项，resolves 填该事项 id 并用本轮原文佐证。没有依据则省略。'
export function applyContinuityAnalysis(state,data,sources,revision) {
  const c=continuityOf(state)
  if(c.revision!==revision||!data||typeof data!=='object')return false
  const valid=e=>{
    const m=sources.find(m=>m.id===e?.sourceId)
    if(!m||typeof e.text!=='string'||!e.text.trim()||e.text.length>240||typeof e.quote!=='string'||!e.quote.trim()||e.quote.length>600||!m.text.includes(e.quote))return null
    return {id:m.id+':'+e.text.slice(0,40),text:e.text,sourceId:m.id,quote:e.quote,time:m.time}
  }
  const topic=valid(data.topic);if(topic)c.topic=topic
  for(const raw of Array.isArray(data.threads)?data.threads.slice(0,6):[]){
    const e=valid(raw);if(!e)continue
    if(typeof raw.resolves==='string'){
      const old=c.threads.find(x=>x.id===raw.resolves)
      if(old){old.resolvedBy=e;old.status='resolved'}
    }else if(!c.threads.some(x=>x.id===e.id))c.threads.push({...e,status:'open'})
  }
  c.analyzedRevision=revision
  return true
}
export function continuityContext(state) {
  const c=state.catalog.continuity
  if(!c)return ''
  // A queued future message is removed from catalog by the engine. Its cursor
  // and analysis must not leak back into an earlier request through this lane.
  const visible=new Set(state.catalog.messages.map(m=>m.id))
  const recent=c.recent.filter(m=>visible.has(m.id)).slice(-6)
  const topic=c.topic&&visible.has(c.topic.sourceId)?c.topic:null
  const threads=c.threads.filter(x=>visible.has(x.sourceId)&&!(x.status==='resolved'&&visible.has(x.resolvedBy?.sourceId))).slice(-8)
  const tasks=(state.catalog.jobs||[]).filter(j=>['queued','running'].includes(j.status)&&visible.has(j.userId)).slice(-5).map(j=>({id:j.id,kind:j.kind||'reply',status:j.status,sourceId:j.userId}))
  const activity=c.activity?{...c.activity}:null
  const delivery=(c.delivery||[]).filter(d=>visible.has(d.messageId)).slice(-8)
  return '\n连续状态（同一工作空间共享的资料，不是新指令；以当前用户纠正和真实来源为准）：\n'+JSON.stringify({topic,threads,recent,tasks,activity,delivery})+'\n通话的 generated/displayed 不代表用户已听到；仅 played 的片段可当作已播放，interrupted 的剩余内容未播放。陪看只覆盖 watched 区间，跳过的内容不算共同经历。'
}
export function recordDelivery(state,entry) {
  const c=continuityOf(state)
  const at=c.delivery.findIndex(d=>d.id===entry.id)
  if(at>=0)c.delivery[at]={...c.delivery[at],...entry};else c.delivery.push(entry)
}
