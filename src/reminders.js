import {randomUUID} from 'node:crypto'
import {companionOf} from './assistant-state.js'
export const requestedReminder=text=>/提醒|叫我|到点.{0,6}(?:喊|叫)|remind|ping me/i.test(text)
const invalidIntent=text=>/取消|不去了|不做了|不用提醒|不需要提醒|别提醒|假如|假设|如果|hypothetical|if I|cancel|do not remind|don't remind/i.test(text)
export class ReminderError extends Error{constructor(code,message){super(message);this.code=code}}
const reject=(code,message)=>{throw new ReminderError(code,message)}
export function reminderTime(value,now){
  const at=typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN
  if(!Number.isFinite(at)||at<=now||at>now+366*86400000)reject('invalid_time','提醒时间需要是带时区的未来日期，且在一年以内；时间不明确时请自然询问用户，不要猜。')
  return at
}
function evidence(source,quote){
  if(!source||source.role!=='user'||typeof quote!=='string'||!quote.trim()||quote.length>16000||!source.text.includes(quote))reject('missing_evidence','操作必须依据用户本次消息的连续原话。')
  return quote.trim()
}
const receipt=(r,c)=>({ok:true,id:r.id,title:r.title,dueAt:new Date(r.dueAt).toISOString(),timeZone:c.policy.timeZone,status:r.status,delivery:c.policy.enabled?'active':'paused',kind:r.mode==='requested'?'requested':'inferred'})
export function createReminder(state,args,source,now){
  const c=companionOf(state),quote=evidence(source,args.quote)
  if(invalidIntent(source.text)||invalidIntent(quote))reject('unclear_intent','这段话在否定、取消或假设安排，请先确认含义，不要创建新提醒。')
  if(!c.policy.enabled)reject('reminders_disabled','主动提醒已关闭。不能承诺到时提醒，也不能替用户偷偷打开设置。')
  if(typeof args.title!=='string'||!args.title.trim()||args.title.length>180)reject('invalid_title','请使用简短明确的提醒事项。')
  const dueAt=reminderTime(args.dueAt,now)
  const old=c.reminders.find(r=>r.sourceId===source.id&&r.quote===quote&&r.kind!=='care')
  if(old)return receipt(old,c)
  const r={id:randomUUID(),sourceId:source.id,chatId:source.chatId,quote,title:args.title.trim(),dueAt,createdAt:source.time,confidence:1,status:'pending',attempts:0,origin:'tool',mode:requestedReminder(source.text)?'requested':'inferred'}
  c.reminders.push(r);c.handledReminderSources=[...new Set([...(c.handledReminderSources||[]),source.id])].slice(-1024)
  return receipt(r,c)
}
export function listReminders(state,args={}){
  const c=companionOf(state)
  if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))reject('invalid_query','查询词过长或格式错误。')
  if(args.includeFinished!==undefined&&typeof args.includeFinished!=='boolean')reject('invalid_query','includeFinished 必须是布尔值。')
  const query=args.query?.trim().toLowerCase()||''
  const rows=c.reminders.filter(r=>r.kind!=='care'&&(args.includeFinished||['pending','claimed'].includes(r.status))&&(!query||r.title.toLowerCase().includes(query)))
  return {ok:true,enabled:c.policy.enabled,timeZone:c.policy.timeZone,total:rows.length,items:rows.sort((a,b)=>a.dueAt-b.dueAt).slice(0,30).map(r=>receipt(r,c)),truncated:rows.length>30}
}
export function updateReminder(state,args,source,now){
  const c=companionOf(state),quote=evidence(source,args.quote),r=c.reminders.find(r=>r.id===args.id&&r.kind!=='care')
  if(!r)reject('not_found','未找到这条提醒，请先查询已有安排，不要猜编号。')
  if(!['cancel','complete','reschedule'].includes(args.operation))reject('invalid_operation','只支持取消、完成或修改提醒时间。')
  const guard={cancel:/取消|不用|不需要|不去了|不做了|别提醒|cancel|don't remind/i,complete:/完成|做完|结束|办好|交了|交完|done|finished/i,reschedule:/改|推迟|提前|延后|换|挪|改期|reschedule|move|instead/i}
  const negated={cancel:/(?:不要|不用|别|没有|没说|不想).{0,4}取消|(?:don't|do not)\s+cancel/i,complete:/(?:没|未|还没|尚未|没有).{0,4}(?:完成|做完|结束|办好|交了|交完)|not\s+(?:done|finished)/i,reschedule:/(?:不要|不用|别|没有|没说|不想).{0,4}(?:改|推迟|提前|延后|换|挪)|(?:don't|do not)\s+(?:reschedule|move)/i}
  if(/假如|假设|如果|hypothetical|if I/i.test(source.text)||negated[args.operation].test(source.text))reject('unclear_intent','用户的变更意思还不明确，请先确认，不要修改已有安排。')
  if(!guard[args.operation].test(source.text))reject('unclear_intent','用户这次没有明确要求这项变更，请先确认。')
  const dueAt=args.operation==='reschedule'?reminderTime(args.dueAt,now):r.dueAt
  const key=[source.id,r.id,args.operation,dueAt].join(':')
  if((r.operations||[]).includes(key))return receipt(r,c)
  if(args.operation==='reschedule'&&!['pending','claimed'].includes(r.status))reject('already_finished','这条提醒已经结束；需要新的提醒时请依据用户的新要求创建。')
  r.status=args.operation==='cancel'?'cancelled':args.operation==='complete'?'done':'pending';r.dueAt=dueAt;r.updatedAt=now;r.updateSourceId=source.id;r.updateQuote=quote;delete r.lease
  if(args.operation==='reschedule'){r.attempts=0;r.mode='requested'}
  r.operations=[...(r.operations||[]),key].slice(-32)
  c.handledReminderSources=[...new Set([...(c.handledReminderSources||[]),source.id])].slice(-1024)
  return receipt(r,c)
}
export function quiet(policy,now){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:policy.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),time=parts.filter(p=>p.type==='hour'||p.type==='minute').map(p=>p.value).join(':')
  const {quietStart:a,quietEnd:b}=policy
  return a===b?false:a<b?time>=a&&time<b:time>=a||time<b
}
export function updatePolicy(old,input){
  const value={...old},fields=['enabled','analysisEnabled','intervalMinutes','quietStart','quietEnd','timeZone','dailyLimit','cooldownMinutes','naturalReminders','allowTasks']
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw new Error('主动关心设置无效。')
  for(const [k,v]of Object.entries(input)){
    if(['enabled','analysisEnabled','naturalReminders','allowTasks'].includes(k)&&typeof v!=='boolean')throw new Error('设置开关格式错误。')
    if(['intervalMinutes','dailyLimit','cooldownMinutes'].includes(k)&&(!Number.isInteger(v)||v<(k==='intervalMinutes'?1:0)||v>(k==='intervalMinutes'?60:k==='dailyLimit'?24:1440)))throw new Error('时间或次数超出范围。')
    if(['quietStart','quietEnd'].includes(k)&&!(typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v)))throw new Error('安静时段格式错误。')
    if(k==='timeZone'){if(typeof v!=='string'||v.length>80)throw new Error('时区无效。');new Intl.DateTimeFormat('en',{timeZone:v}).format()}
    value[k]=v
  }
  return value
}
export function rememberReminders(state,data,sources){
  const c=companionOf(state)
  for(const e of Array.isArray(data?.reminders)?data.reminders.slice(0,4):[]){
    const source=sources.find(s=>s.id===e?.sourceId&&s.role==='user'),dueAt=typeof e.dueAt==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(e.dueAt)?Date.parse(e.dueAt):NaN
    if(!source||typeof e.quote!=='string'||!e.quote.trim()||e.quote.length>1200||!source.text.includes(e.quote)||typeof e.title!=='string'||!e.title.trim()||e.title.length>180||!Number.isFinite(e.confidence)||e.confidence<.85||e.confidence>1||!Number.isFinite(dueAt)||dueAt<=source.time||dueAt>source.time+366*86400000)continue
    if((c.handledReminderSources||[]).includes(source.id)||invalidIntent(e.quote))continue
    if(c.reminders.some(r=>r.sourceId===source.id&&r.quote===e.quote))continue
    c.reminders.push({id:randomUUID(),sourceId:source.id,chatId:source.chatId,quote:e.quote,title:e.title.trim(),dueAt,createdAt:source.time,confidence:e.confidence,status:'pending',attempts:0,mode:requestedReminder(source.text)?'requested':'inferred'})
  }
  for(const u of Array.isArray(data?.reminderUpdates)?data.reminderUpdates.slice(0,6):[]){
    const source=sources.find(s=>s.id===u?.sourceId&&s.role==='user'),r=c.reminders.find(r=>r.id===u?.id)
    if(!r||!source||(c.handledReminderSources||[]).includes(source.id)||typeof u.quote!=='string'||!u.quote.trim()||!source.text.includes(u.quote)||!['cancelled','done'].includes(u.status)||source.time<r.createdAt)continue
    if(u.status==='cancelled'&&!/取消|不用提醒|不去了|不做了|别提醒|cancel|don't remind/i.test(u.quote))continue
    if(u.status==='done'&&!/完成|做完|结束|办好了|done|finished/i.test(u.quote))continue
    r.status=u.status;r.updatedAt=source.time;r.updateSourceId=source.id;delete r.lease
  }
}
export function dueReminders(state,now){
  const c=companionOf(state)
  return c.reminders.filter(r=>(r.status==='pending'||r.status==='claimed'&&r.lease?.until<=now)&&r.dueAt<=now&&now-r.dueAt<=86400000&&r.attempts<3&&deliveryAllowed(state,r,now)).sort((a,b)=>Number(b.mode==='requested')-Number(a.mode==='requested')||a.dueAt-b.dueAt).slice(0,1)
}
export function deliveryAllowed(state,r,now){
  const c=companionOf(state),p=c.policy
  if(!p.enabled)return false
  // A user-chosen appointment is not unsolicited small talk. Quiet hours and
  // frequency limits govern inferred care, not an explicitly agreed time.
  if(r.mode==='requested')return true
  if(quiet(p,now)||p.dailyLimit===0)return false
  if(c.deliveryDay===deliveryDay(p,now)&&(c.deliveries||0)>=p.dailyLimit)return false
  return !(c.lastDelivery&&now-c.lastDelivery<p.cooldownMinutes*60000)
}
export function nextReminderDelay(state,now,busy=false){
  const c=companionOf(state),interval=c.policy.intervalMinutes*60000
  if(dueReminders(state,now).length)return busy?Math.min(interval,5000):1000
  const soon=c.reminders.filter(r=>r.attempts<3&&['pending','claimed'].includes(r.status)).reduce((n,r)=>{
    const time=r.status==='claimed'?r.lease?.until:r.dueAt
    return Number.isFinite(time)&&time>now?Math.min(n,time-now):n
  },interval)
  return Math.max(1000,soon)
}
export function deliveryDay(policy,now){return new Intl.DateTimeFormat('en-CA',{timeZone:policy.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))}
