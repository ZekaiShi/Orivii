import {createHash,randomUUID} from 'node:crypto'
import {companionOf} from './assistant-state.js'
import {deliveryAllowed,deliveryDay} from './reminders.js'
import {appendBubble} from './memory.js'
import {searchWeb,readWeb} from './web.js'

const MINUTE=60000,IDLE=15*MINUTE,DELAY=2*60*MINUTE,RETRY=6*60*MINUTE,TTL=72*60*MINUTE,LEASE=3*MINUTE
const active=new Set(['pending','checking'])
// Pick a stable minute in the 2–3 hour window once per candidate. Polling and
// restarts must not continually move its deadline into the future.
const initialDelay=id=>DELAY+parseInt(createHash('sha256').update(id).digest('hex').slice(0,8),16)%61*MINUTE
export const FOLLOWUP_ANALYSIS_PROMPT='另外输出 followups:{candidates:[{sourceId,quote,query,confidence}],updates:[{id,sourceId,quote,status:"resolved|cancelled"}]}。只选择本轮用户明确提出、对话结束仍未解决、以后查公开资料可能找到有用新线索的事实或技术疑问。已回答的问题、普通闲聊、情感倾诉、定时安排无需补查。quote 是本轮用户连续原话，confidence 至少0.9。query 是脱离私人语境的通用公开问题，最多160字，只含产品名和公共问题词；个人姓名、邮箱、账号、论文编号、凭据、文件路径和私有链接留在本地。宁可不选也不猜测。用户已经解决、不需要继续或不欢迎追问时，用其本轮原话更新已有候选；没有候选或更新就返回空数组。'
export function followupsOf(state){
  const f=state.catalog.followups??={version:2,items:[],budget:{day:'',attempts:0}}
  if(f.version===1){
    for(const item of f.items)if(item.status==='pending'&&item.attempts===0)item.dueAt=Math.max(item.dueAt,item.createdAt+initialDelay(item.id))
    f.version=2
  }
  return f
}
export function publicQuery(value,state){
  if(typeof value!=='string'||value.trim().length<4||value.length>160)return null
  const query=value.trim()
  // Queries are deliberately smaller than a chat excerpt. These checks are a
  // second boundary after the analysis protocol's public-topic requirement.
  if(/[@\r\n\x00-\x1f]|https?:|www\.|[\\/]|\b\d{7,}\b|\b[A-Za-z0-9_-]{24,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:api.?key|password|token)\s*[:=]|(?:我的|主人|用户的)(?:姓名|邮箱|密码|账号|地址)/i.test(query))return null
  if(/#\s*\d|(?:投稿|论文|账号|账户|用户)(?:\s*(?:编号|号码?|ID))?\s*[:：#=]?\s*[A-Za-z_-]*\d|\b(?:submission|account|user)\s*(?:id|number|no\.?)?\s*[:#=]?\s*[A-Za-z_-]*\d/i.test(query))return null
  const fields=state?.permanent.profile?.fields||{},privateNames=[fields.preferredName?.value]
  for(const match of (fields.identity?.value||'').matchAll(/(?:我叫|姓名[：:]?|名字是)\s*([\p{Script=Han}]{2,4}|[A-Za-z][A-Za-z ]{1,50})/gu))privateNames.push(match[1])
  if(privateNames.some(name=>typeof name==='string'&&name.trim().length>=2&&query.toLowerCase().includes(name.trim().toLowerCase())))return null
  return query
}
const keyOf=query=>createHash('sha256').update(query.toLowerCase().replace(/[\s\p{P}]/gu,'')).digest('hex')
const latestUser=state=>state.catalog.messages.findLast(m=>m.role==='user')
const available=state=>{const p=companionOf(state).policy;return p.enabled&&p.analysisEnabled&&state.catalog.settings.webSearch!==false}
export function rememberFollowups(state,data,sources,revision){
  if(state.catalog.continuity?.revision!==revision||!available(state)||!data||typeof data!=='object')return
  const list=followupsOf(state).items
  const sourceOf=e=>sources.find(m=>m.id===e?.sourceId&&m.role==='user'&&Number.isFinite(m.time)&&state.catalog.messages.some(ref=>ref.id===m.id&&ref.chatId===m.chatId&&ref.role==='user')&&typeof e.quote==='string'&&e.quote.trim().length>=4&&e.quote.length<=600&&m.text.includes(e.quote))
  for(const e of Array.isArray(data.updates)?data.updates.slice(0,16):[]){
    if(!e||typeof e!=='object')continue
    const source=sourceOf(e),item=list.find(x=>x.id===e.id)
    if(source&&item&&source.time>=item.createdAt&&active.has(item.status)&&['resolved','cancelled'].includes(e.status))Object.assign(item,{status:e.status,resolvedBy:source.id,updatedAt:source.time})
  }
  for(const e of Array.isArray(data.candidates)?data.candidates.slice(0,2):[]){
    if(!e||typeof e!=='object')continue
    const source=sourceOf(e),query=publicQuery(e.query,state)
    if(!source||!query||!Number.isFinite(e.confidence)||e.confidence<.9||e.confidence>1||!state.catalog.chats.some(c=>c.id===source.chatId&&!c.archived))continue
    const key=keyOf(query)
    if(list.some(x=>x.key===key||x.sourceId===source.id)||list.filter(x=>active.has(x.status)).length>=32)continue
    const id=randomUUID()
    list.push({id,key,sourceId:source.id,chatId:source.chatId,quote:e.quote,query,status:'pending',createdAt:source.time,updatedAt:source.time,dueAt:source.time+initialDelay(id),expiresAt:source.time+TTL,attempts:0})
  }
  followupsOf(state).items=[...list.filter(x=>active.has(x.status)),...list.filter(x=>!active.has(x.status)).slice(-32)]
}
export function followupAllowed(state,now,busy=false){
  const last=latestUser(state)
  return !busy&&available(state)&&Boolean(last)&&now-last.time>=IDLE&&deliveryAllowed(state,{mode:'inferred'},now)&&
    !state.catalog.jobs.some(j=>['queued','running','memory'].includes(j.status))&&
    !(state.catalog.backgroundResearch||[]).some(j=>['queued','running','ready','delivering'].includes(j.status))
}
export function verifiedFollowup(reply,pages){
  if(reply?.send!==true||typeof reply.text!=='string'||!reply.text.trim()||reply.text.length>1400||!Array.isArray(reply.evidence)||!reply.evidence.length)return null
  const evidence=reply.evidence.slice(0,3)
  if(evidence.some(e=>!e||typeof e.quote!=='string'||e.quote.trim().length<8||e.quote.length>1000||!pages.some(p=>p.url===e.url&&p.content.includes(e.quote))))return null
  // All links in a proactive answer must have actually been read, not guessed.
  const links=reply.text.match(/https?:\/\/[^\s<>\])]+/g)||[]
  if(links.some(url=>!pages.some(p=>p.url===url)))return null
  const citations=[...new Set(evidence.map(e=>e.url))]
  return {text:reply.text.trim()+(links.length?'':'\n\n'+citations.map((url,i)=>`[${i?'补充来源':'来源'}](${url})`).join(' ')),expression:reply.expression,evidence}
}
export class Followups {
  constructor({vault,engine,services,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
    Object.assign(this,{vault,engine,services,now,setTimer,clearTimer});this.runtimeId=randomUUID();this.stopped=true;this.running=null;this.controller=null;this.epoch=0
  }
  start(){if(!this.stopped)return;this.stopped=false;this.schedule()}
  schedule(){if(this.stopped)return;this.timer=this.setTimer(()=>{this.timer=null;this.tick().catch(()=>{}).finally(()=>this.schedule())},10*MINUTE);this.timer.unref?.()}
  activity(){this.epoch++;this.controller?.abort()}
  busy(){return this.stopped||this.engine.stopped||this.engine.isForegroundBusy()||this.engine.accepting||this.engine.delivering||Boolean(this.engine.voice?.status()||this.engine.media?.active)}
  tick(){
    if(this.running||this.stopped||!this.services.web)return this.running
    this.running=this.run().finally(()=>{this.running=null;this.controller=null});return this.running
  }
  async run(){
    const epoch=this.epoch,now=this.now(),state=await this.vault.read()
    if(!followupAllowed(state,now,this.busy()))return
    if(!followupsOf(state).items.some(x=>active.has(x.status)&&x.dueAt<=now))return
    const claimed=await this.vault.transaction(s=>{
      if(epoch!==this.epoch||!followupAllowed(s,now,this.busy()))return null
      const f=followupsOf(s),day=deliveryDay(companionOf(s).policy,now)
      for(const item of f.items){
        if(active.has(item.status)&&item.expiresAt<=now)item.status='expired'
        if(item.status==='checking'&&item.leaseUntil<=now)item.status='pending'
      }
      if(f.budget.day===day&&f.budget.attempts>=2)return null
      // One lease per identity across concurrent host instances.
      if(f.items.some(x=>x.status==='checking'))return null
      const item=f.items.find(x=>x.status==='pending'&&x.dueAt<=now&&x.attempts<2&&s.catalog.chats.some(c=>c.id===x.chatId&&!c.archived)&&s.catalog.messages.some(m=>m.id===x.sourceId&&m.role==='user'))
      if(!item)return null
      f.budget={day,attempts:(f.budget.day===day?f.budget.attempts:0)+1}
      Object.assign(item,{status:'checking',runtimeId:this.runtimeId,leaseUntil:now+LEASE,attempts:item.attempts+1,latestUserId:latestUser(s).id})
      return structuredClone(item)
    })
    if(!claimed)return
    this.controller=new AbortController()
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(90000)])
    const current=s=>{
      const item=followupsOf(s).items.find(x=>x.id===claimed.id)
      return !signal.aborted&&epoch===this.epoch&&item?.status==='checking'&&item.runtimeId===this.runtimeId&&item.leaseUntil>this.now()&&item.expiresAt>this.now()&&latestUser(s)?.id===claimed.latestUserId&&followupAllowed(s,this.now(),this.busy())&&s.catalog.chats.some(c=>c.id===claimed.chatId&&!c.archived)
    }
    try{
      if(!current(await this.vault.read()))return
      // Only the generic, validated question leaves for search. Chat excerpts,
      // persona and pending work remain within the existing model context.
      const query=publicQuery(claimed.query,await this.vault.read());if(!query)return
      const found=await searchWeb(this.services.web,query,signal),pages=[]
      for(const source of found.sources.filter(x=>/^https:\/\//.test(x.url)).slice(0,2)){
        if(!current(await this.vault.read()))return
        try{
          const page=await readWeb(this.services.web,source.url,signal)
          if(page.statusCode>=200&&page.statusCode<300&&page.content.trim().length>=40)pages.push({url:page.url,title:source.title,content:page.content.slice(0,7000)})
        }catch{if(signal.aborted)return}
      }
      if(!pages.length||!current(await this.vault.read()))return
      const proposal=verifiedFollowup(await this.engine.composeFollowup(claimed,pages,signal),pages)
      if(!proposal||!current(await this.vault.read()))return
      const revised=await this.engine.prepareVisibleReply(proposal.text,signal,{chatId:claimed.chatId,userId:claimed.sourceId,kind:'followup'})
      const final=verifiedFollowup({...proposal,send:true,text:revised},pages)
      if(!final)return
      const text=final.text
      const bubble=await this.vault.transaction(async s=>{
        if(!current(s)||!text.trim())return null
        const item=followupsOf(s).items.find(x=>x.id===claimed.id)
        const bubble=await appendBubble(this.vault,s,item.chatId,'assistant',text,{origin:'followup',followupId:item.id,sourceIds:[item.sourceId],presentation:{expression:proposal.expression},webSources:proposal.evidence.map(({url})=>({url})),time:this.now()})
        signal.throwIfAborted()
        const c=companionOf(s),day=deliveryDay(c.policy,this.now())
        c.deliveries=(c.deliveryDay===day?c.deliveries||0:0)+1;c.deliveryDay=day;c.lastDelivery=this.now()
        Object.assign(item,{status:'sent',messageId:bubble.id,updatedAt:this.now()});delete item.runtimeId;delete item.leaseUntil
        return bubble
      })
      if(bubble){this.engine.deliveryRevision++;this.engine.present({id:claimed.id,chatId:claimed.chatId},bubble.id,bubble.presentation.expression);this.engine.notifyVisible(bubble)}
    }catch{
      // A failed lookup is silent. The original question and conversation stay
      // intact; the bounded retry is separate from durable memory retention.
    }finally{
      await this.vault.transaction(s=>{
        const item=followupsOf(s).items.find(x=>x.id===claimed.id&&x.runtimeId===this.runtimeId)
        if(!item)return
        if(item.status==='checking')Object.assign(item,{status:item.attempts>=2?'exhausted':'pending',dueAt:this.now()+RETRY,updatedAt:this.now()})
        delete item.runtimeId;delete item.leaseUntil
      }).catch(()=>{})
    }
  }
  async stop(){this.stopped=true;this.clearTimer(this.timer);this.timer=null;this.activity();await this.running?.catch(()=>{})}
}
