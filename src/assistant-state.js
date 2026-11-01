import {randomUUID} from 'node:crypto'

const defaults=()=>({enabled:true,analysisEnabled:true,intervalMinutes:10,quietStart:'23:00',quietEnd:'08:00',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',dailyLimit:4,cooldownMinutes:60,naturalReminders:true,allowTasks:true})

// Share existing reminder/task records without reading or exporting persona internals.
export function companionOf(state){
  const c=state.permanent.companion??={version:1}
  c.reminders??=[];c.tasks??=[]
  c.policy={...defaults(),...c.policy}
  return c
}
export function rememberCare(state,data,sources){
  const c=companionOf(state)
  if(!c.policy.enabled||c.policy.analysisEnabled===false)return
  for(const item of Array.isArray(data?.care)?data.care.slice(0,2):[]){
    const source=sources.find(s=>s.id===item?.sourceId&&s.role==='user')
    if(!source||typeof item.quote!=='string'||!item.quote.trim()||item.quote.length>1200||!source.text.includes(item.quote)||item.subject!=='user'||item.temporalScope!=='current'||!Number.isFinite(item.confidence)||item.confidence<.9||item.confidence>1)continue
    if(/别问|不用关心|不要再|别再|假如|假设|如果|don't ask|do not ask|hypothetical/i.test(source.text))continue
    if(c.reminders.some(r=>r.sourceId===source.id&&r.kind==='care'))continue
    c.reminders.push({id:randomUUID(),kind:'care',sourceId:source.id,chatId:source.chatId,title:'之前聊到的事，现在怎么样了？',quote:item.quote,dueAt:source.time+6*3600000,createdAt:source.time,confidence:item.confidence,status:'pending',attempts:0})
  }
}
export const ASSISTANT_ANALYSIS=`另外输出 extension 对象（没有证据时数组为空）：
reminders:[{sourceId,quote,title,dueAt,confidence}]：用户明确的未来安排，不一定是正式提醒命令。quote 必须逐字连续引用本轮用户原话；dueAt 是带时区的 ISO 日期，依据消息时间解释相对时间。时间不明确、否定、假设、故事或助手自己的安排不生成。
reminderUpdates:[{id,sourceId,quote,status:"cancelled|done"}]：仅用户本次明确取消或完成的既有事项。
care:[{sourceId,quote,subject:"user",temporalScope:"current",confidence}]：用户本人此刻重要的开心、难过、困难或值得后续询问的近况，可以在几小时后自然问候一次。仅高置信度、有原话的当前事件，最多两条。往事、故事人物、玩笑、普通闲聊和不希望被追问的内容不生成。不下心理诊断，不编造共同经历。
不要输出推理、评分解释或内部步骤。`
