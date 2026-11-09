import {randomUUID} from 'node:crypto'
import {DotError} from './vault.js'

export function searchTerms(text,query=false,unique=true) {
  const clean=(query?text.replace(/你还记得|还记得|之前|我说过|我说的|什么|那个|这个|聊天记录/g,' '):text).normalize('NFKC').toLowerCase()
  const words=clean.match(/[\p{L}\p{N}]+/gu)||[]
  const terms=words.flatMap(word=>{
    if(!/\p{Script=Han}/u.test(word))return [word]
    return word.length<2?[word]:Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))
  })
  return unique?[...new Set(terms)]:terms
}
export function searchDocument(text){
  const all=searchTerms(text,false,false),frequency=Object.create(null)
  for(const term of all)frequency[term]=(frequency[term]||0)+1
  return {terms:Object.keys(frequency),frequency,length:all.length}
}
export const relevance=(text,query)=>{
  const terms=new Set(searchTerms(text)),wanted=searchTerms(query,true)
  return wanted.reduce((n,term)=>n+(terms.has(term)?Math.min(term.length,12):0),0)
}
const link=m=>`dot://chat/${m.chatId}/message/${m.id}`

// Only terms are retained in the encrypted catalog. The unlocked in-memory
// inverted index is reusable; a query decrypts only its highest ranked hits.
export async function indexedSearch(vault,state,query,limit=10) {
  vault.requireOpen()
  if(typeof query!=='string'||!query.trim()||query.length>500)throw new DotError('搜索词请使用 1–500 个字符。')
  let cache=vault.searchIndex
  if(!cache||cache.version!==2||cache.count>state.catalog.messages.length)cache=vault.searchIndex={version:2,count:0,totalLength:0,postings:new Map(),refs:new Map(),lengths:new Map(),queue:Promise.resolve()}
  const update=cache.queue.then(async()=>{
    for(let at=cache.count;at<state.catalog.messages.length;at+=8){
      const rows=state.catalog.messages.slice(at,at+8)
      const indexed=await Promise.all(rows.map(async ref=>({ref,document:ref.searchTerms?{terms:ref.searchTerms,frequency:ref.searchFrequency||{},length:ref.searchLength||ref.searchTerms.length}:searchDocument((await vault.message(ref.id)).text)})))
      vault.requireOpen()
      for(const {ref,document} of indexed){
        cache.refs.set(ref.id,ref)
        cache.lengths.set(ref.id,document.length);cache.totalLength+=document.length
        for(const term of document.terms){let ids=cache.postings.get(term);if(!ids)cache.postings.set(term,ids=new Map());ids.set(ref.id,document.frequency[term]||1)}
      }
      cache.count=at+rows.length
    }
  })
  cache.queue=update.catch(()=>{});await update
  const scores=new Map()
  const average=Math.max(1,cache.totalLength/Math.max(1,cache.count)),k1=1.2,b=.75
  for(const term of searchTerms(query,true)){
    const postings=cache.postings.get(term);if(!postings)continue
    const idf=Math.log(1+(cache.count-postings.size+.5)/(postings.size+.5))
    for(const [id,tf] of postings){const length=cache.lengths.get(id)||1;const score=idf*tf*(k1+1)/(tf+k1*(1-b+b*length/average));scores.set(id,(scores.get(id)||0)+score)}
  }
  const refs=[...scores].map(([id,score])=>({...cache.refs.get(id),score})).sort((a,b)=>b.score-a.score||b.time-a.time).slice(0,Math.max(1,Math.min(30,limit)))
  return Promise.all(refs.map(async ref=>{
    const raw=await vault.message(ref.id),terms=searchTerms(query,true),lower=raw.text.toLowerCase()
    const at=Math.max(0,lower.indexOf(terms.find(t=>lower.includes(t))||'')-100)
    return {id:ref.id,chatId:ref.chatId,role:ref.role,time:ref.time,score:ref.score,excerpt:raw.text.slice(at,at+600),link:link(ref),kind:'conversation'}
  }))
}

export function learnedEntries(state) {return [...(state.permanent.knowledge||[]),...(state.permanent.memes||[])]}
export function parseLearned(data,sources) {
  const entries=[]
  for(const kind of ['knowledge','memes'])for(const item of Array.isArray(data[kind])?data[kind].slice(0,6):[]){
    const source=sources.find(m=>m.id===item?.sourceId&&['user','assistant'].includes(m.role))
    if(!source||!Number.isFinite(source.time)||typeof item.topic!=='string'||!item.topic.trim()||item.topic.length>120)continue
    if(typeof item.text!=='string'||!item.text.trim()||item.text.length>2000)continue
    if(typeof item.quote!=='string'||!item.quote.trim()||item.quote.length>3000||!source.text.includes(item.quote))continue
    entries.push({id:randomUUID(),kind,topic:item.topic.trim(),text:item.text.trim(),quote:item.quote,sourceIds:[source.id],time:source.time,
      origin:'model',speaker:source.role,status:'active',enabled:true,
      tags:(Array.isArray(item.tags)?item.tags:[]).filter(t=>typeof t==='string'&&t.length<=60&&source.text.includes(t)).slice(0,8),
      ...(kind==='memes'?{usage:typeof item.usage==='string'?item.usage.slice(0,300):'',avoid:typeof item.avoid==='string'?item.avoid.slice(0,300):''}:{}),
      ...(typeof item.supersedes==='string'&&['corrects','questions'].includes(item.relation)?{supersedes:item.supersedes,relation:item.relation}:{})})
  }
  return entries
}
export function rememberLearned(state,entries) {
  for(const candidate of entries){
    const list=state.permanent[candidate.kind]??=[]
    // Manual changes, including disabling a topic, win over later extraction.
    if(list.some(e=>e.topic===candidate.topic&&e.origin==='user'))continue
    if(list.some(e=>e.sourceIds[0]===candidate.sourceIds[0]&&e.quote===candidate.quote))continue
    if(!state.catalog.messages.some(m=>m.id===candidate.sourceIds[0]&&m.role===candidate.speaker))continue
    const entry={...candidate},previous=list.find(e=>e.id===entry.supersedes)
    if(previous?.origin==='user')continue
    delete entry.supersedes;delete entry.relation
    if(previous&&previous.origin!=='user'&&previous.enabled&&previous.time<=entry.time){
      previous.status=candidate.relation==='corrects'?'superseded':'disputed'
      previous.replacedBy=entry.id;entry.previousId=previous.id
      if(candidate.relation==='questions')entry.status='disputed'
    } else if(previous&&previous.time>entry.time)entry.status='superseded'
    // Different statements about one topic may be complementary. Only an
    // evidence-backed, explicit revision changes an earlier item's status.
    list.push(entry)
  }
}
export function recallLearned(state,query,limit=12) {
  return learnedEntries(state).filter(e=>e.enabled&&e.status!=='superseded').map(e=>({...e,score:relevance(e.topic+' '+e.text+' '+(e.tags||[]).join(' '),query)})).filter(e=>e.score>0).sort((a,b)=>b.score-a.score||b.time-a.time).slice(0,limit)
}
export function learnedText(e) {
  return `[${e.kind==='memes'?'梗与话题':'知识记录'} · ${e.status==='disputed'?'存疑，勿作定论':e.origin==='exploration'?'自主阅读的公开资料，不代表共同经历或已交叉核实':e.origin==='user'?'用户修订':e.speaker==='user'?'用户提出，未经外部核验':'助手曾解释，未经外部核验'}] ${e.topic}：${e.text}\n来源记录：${e.sourceIds.join(' ')}（可调用 memory_read 核实）`+(e.kind==='memes'?`\n语境线索（仅参考）：${e.usage||'未记录'}；避免场合：${e.avoid||'用户难过、痛苦或不欢迎调侃时'}。这不是必须使用的梗。`:'')
}
