import {DotError} from './vault.js'

export const PROFILE_FIELDS=Object.freeze({preferredName:80,identity:1200,preferences:2000})
export function profileOf(state) {
  const fields=state.permanent.profile?.fields||{}
  return {fields:Object.fromEntries(Object.keys(PROFILE_FIELDS).filter(key=>fields[key]).map(key=>[key,{...fields[key]}]))}
}
export function editProfile(state,input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DotError('用户印象格式不正确。')
  const fields={...profileOf(state).fields}
  for(const [key,value] of Object.entries(input)) {
    if(!Object.hasOwn(PROFILE_FIELDS,key)||typeof value!=='string'||value.length>PROFILE_FIELDS[key])throw new DotError('用户印象字段无效或内容过长。')
    // An empty manual value is an explicit correction, not an invitation to
    // restore an older automatic observation on the next analysis.
    fields[key]={value:value.trim(),origin:'user',updatedAt:Date.now(),sourceIds:[],quote:''}
  }
  state.permanent.profile={fields}
  return profileOf(state)
}
export function parseProfile(items,sources) {
  const observations=[]
  for(const item of Array.isArray(items)?items.slice(0,6):[]) {
    const limit=PROFILE_FIELDS[item?.field],source=sources.find(m=>m.id===item?.sourceId&&m.role==='user')
    if(!limit||!source||!Number.isFinite(source.time)||typeof item.value!=='string'||!item.value.trim()||item.value.length>limit)continue
    if(typeof item.quote!=='string'||!item.quote.trim()||item.quote.length>3000||!source.text.includes(item.quote)||!item.quote.includes(item.value))continue
    observations.push({field:item.field,value:item.value.trim(),quote:item.quote,sourceIds:[source.id],updatedAt:source.time,origin:'model'})
  }
  return observations
}
export function rememberProfile(state,observations) {
  const fields={...profileOf(state).fields}
  for(const {field,...item} of observations) {
    const old=fields[field]
    if(old?.origin==='user'||(old?.updatedAt||0)>item.updatedAt)continue
    if(!state.catalog.messages.some(m=>m.id===item.sourceIds[0]&&m.role==='user'))continue
    fields[field]=item
  }
  state.permanent.profile={fields}
}
export function profileContext(state) {
  const labels={preferredName:'用户希望的称呼',identity:'用户明确说明的身份与背景',preferences:'喜好与相处方式'}
  const fields=profileOf(state).fields
  return Object.entries(labels).filter(([key])=>fields[key]?.value).map(([key,label])=>`${label}：${fields[key].value}（${fields[key].origin==='user'?'用户亲自设置':'来自用户原话'}）`).join('\n')||'尚未了解，随聊天自然认识对方，不臆测身份。'
}
