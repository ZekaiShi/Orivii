// Only these declarative values may cross the model/UI boundary.
export const DOT_EXPRESSIONS=Object.freeze(['neutral','agree','disagree','happy','concerned','uncertain','blocked','curious','surprised','confused','astonished','heart','angry','sad','excited','relieved','skeptical','shy'])
export const DOT_EXPRESSION_MEANINGS=Object.freeze({neutral:'平静说明事实',agree:'明确认同或确认',disagree:'温和否定或不同意',happy:'轻松开心或开玩笑',concerned:'认真关切、安慰',uncertain:'拿不准答案或缺少依据',blocked:'明确不能执行',curious:'对新话题好奇、想了解',surprised:'意外惊讶',confused:'没听懂、摸不着头脑',astonished:'强烈意外、大吃一惊',heart:'喜爱、感谢或暖心',angry:'对不公或糟心事情表达不满',sad:'遗憾、失落或难过',excited:'庆祝、期待或兴奋',relieved:'担心解除、松一口气',skeptical:'对说法存疑、将信将疑',shy:'面对夸奖或亲昵时腼腆'})
export const expressionChoices=DOT_EXPRESSIONS.map(key=>`${key}：${DOT_EXPRESSION_MEANINGS[key]}`).join('；')
export const dotExpression=value=>DOT_EXPRESSIONS.includes(value)?value:'neutral'

// Reserved transport metadata is never visible prose, including when a model
// repeats it inside a tool's text argument or a legacy saved bubble.
export function cleanReply(text,expression){
  let tagged
  const clean=String(text??'').replace(/`?\[\s*dot-reply\s*:\s*([^\]\r\n]*)(?:\]|(?=\r?\n|$))`?/gi,(_,value)=>{tagged??=value.trim();return ''})
    .replace(/\[(?:d|do|dot|dot-|dot-r|dot-re|dot-rep|dot-repl|dot-reply)\s*$/i,'')
  return {text:clean,expression:dotExpression(expression===undefined?tagged:expression)}
}
export function publicBubble(message){
  if(message.role!=='assistant')return message
  const visible=cleanReply(message.text,message.presentation?.expression)
  return {...message,text:visible.text,presentation:{...message.presentation,expression:visible.expression}}
}
export const expressionParameter={type:'string',enum:[...DOT_EXPRESSIONS],description:'选择本条回复的实际语气，不是判断用户内心。'+expressionChoices+'。不要一律选择 neutral，也不要随机轮换；没有明显情绪时用 neutral。'}

// Short-lived delivery events survive polling, but never replay history or a
// hidden tab's backlog. A brief pose leaves room for the real tool state.
export function createPresentationPlayer({play,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
  let chat,initialized=false,last=0,queue=[],timer=null,active=true,resumedAt=0,job
  const cancel=()=>{if(timer!==null)clearTimer(timer);timer=null;queue=[]}
  function drain(){
    timer=null
    while(queue.length){const event=queue.shift();if(now()-event.time>5000||event.time<resumedAt)continue;play(event);timer=setTimer(drain,850);break}
  }
  return {
    cancel,
    suspend(){active=false;cancel()},
    update(chatId,events,{visible=true,input=false,enabled=true}={}){
      const rows=Array.isArray(events)?events:[],newest=Math.max(0,...rows.map(e=>e.id||0))
      if(!initialized||chat!==chatId){cancel();chat=chatId;initialized=true;last=newest;active=visible;job=rows.at(-1)?.jobId;return}
      if(visible&&!active)resumedAt=now()
      active=visible
      const fresh=rows.filter(e=>e.id>last&&Number.isFinite(e.time)&&e.time>=resumedAt&&now()-e.time<=5000)
      last=Math.max(last,newest)
      if(!visible||input){cancel();return}
      if(!enabled){cancel();if(fresh.length)play(fresh.at(-1));return}
      if(!fresh.length)return
      const nextJob=fresh.at(-1).jobId
      if(job!==nextJob){cancel();job=nextJob}
      queue.push(...fresh.filter(e=>e.jobId===job));queue=queue.slice(-4)
      if(timer===null)drain()
    },
  }
}

// Baseline on entry. New history pages and polling never replay old reactions.
export function createExpressionTracker() {
  let chat,initialized=false,seen=new Set(),watermark=-Infinity,cutoff=-Infinity
  return {
    reset(){chat=undefined;initialized=false;seen.clear();watermark=-Infinity;cutoff=-Infinity},
    resume(time){cutoff=time},
    observe(chatId,messages,{replay=true}={}) {
      if(chatId!==chat){chat=chatId;initialized=false;seen.clear();watermark=-Infinity}
      const baseline=!initialized;initialized=true
      const fresh=[]
      for(const message of messages){
        if(!baseline&&replay&&!seen.has(message.id)&&message.time>=watermark&&message.time>cutoff&&message.role==='assistant')fresh.push(message)
      }
      for(const message of messages){seen.add(message.id);watermark=Math.max(watermark,message.time||0)}
      // Only the newest event is relevant if several arrived in one snapshot.
      if(seen.size>2000)seen=new Set(messages.map(message=>message.id))
      return fresh.at(-1)||null
    },
  }
}
