import {DotError} from './vault.js'
export const LIVE_DEFAULTS=Object.freeze({mediaEnabled:false,commentary:false,exploration:false,exploreTopics:[]})
export function liveSettings(state){return Object.fromEntries(Object.entries(LIVE_DEFAULTS).map(([key,value])=>[key,state.catalog.liveSettings?.[key]??value]))}
export function updateLiveSettings(state,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(LIVE_DEFAULTS,k)))throw new DotError('陪伴设置无效。')
  const next=liveSettings(state)
  for(const [key,value]of Object.entries(input)){
    if(typeof LIVE_DEFAULTS[key]==='boolean'&&typeof value!=='boolean')throw new DotError('开关格式无效。')
    if(key==='exploreTopics'&&(!Array.isArray(value)||value.length>8||value.some(x=>typeof x!=='string'||!x.trim()||x.length>80)))throw new DotError('探索主题最多8项，每项80字以内。')
    next[key]=value
  }
  state.catalog.liveSettings={...state.catalog.liveSettings,...next};return next
}
