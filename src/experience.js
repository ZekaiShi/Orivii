import {searchDocument,searchTerms} from './recall.js'

export function experienceRef(record){
  const text=[record.title||record.topic||'',record.caption||'',record.text||''].join('\n')
  return {id:record.id,activityId:record.activityId,chatId:record.chatId,time:record.time,origin:record.origin,
    title:record.title||record.topic,url:record.url,position:record.position,perception:record.perception,
    summary:(record.caption||record.summary||record.text||'').slice(0,500),archived:true,searchTerms:searchDocument(text).terms}
}
export function experienceOf(state,id){return [...state.catalog.experiences||[],...state.catalog.exploration||[]].find(e=>e.id===id)}
export async function readExperience(vault,record){return record.archived?vault.message(record.id):record}
export function searchExperiences(state,query,limit=5){
  const wanted=searchTerms(query,true)
  return [...state.catalog.experiences||[],...state.catalog.exploration||[]].map(e=>({e,score:wanted.filter(t=>(e.searchTerms||searchDocument(e.caption||e.text||e.summary||'').terms).includes(t)).length}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.e.time-a.e.time).slice(0,limit)
    .map(({e,score})=>({id:e.id,kind:e.origin==='exploration'?'independent-reading':'shared-observation',text:e.summary||e.caption||e.text||'',url:e.url,position:e.position,perception:e.perception,sourceIds:[e.id],score}))
}
