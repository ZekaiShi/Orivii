import {validateVisualSpec} from './visual.js'

// Review explanatory prose while preserving dataset values, labels, references
// and executable markup. No private response policy is bundled here.
export async function reviewVisualProse(input,review){
  const spec=validateVisualSpec(input),cache=new Map()
  const edit=async text=>{
    if(!text)return text
    if(!cache.has(text))cache.set(text,Promise.resolve(review(text)))
    return cache.get(text)
  }
  if(spec.description!==undefined)spec.description=await edit(spec.description)
  for(const block of spec.blocks){
    if(block.type==='text')block.text=await edit(block.text)
    if(['cards','flow'].includes(block.type))for(const item of block.items)item.text=await edit(item.text)
    if(block.type==='metrics')for(const item of block.items)if(item.hint!==undefined)item.hint=await edit(item.hint)
    if(block.type==='svg')block.caption=await edit(block.caption)
  }
  return validateVisualSpec(spec)
}
export function proseDocument(name,text,request=''){
  if(!/\.(?:md|markdown|txt)$/i.test(name))return false
  if(/原样|逐字|一字不改|原文|不要(?:修改|改写|润色)|保持(?:内容|文字)不变|\b(?:verbatim|unchanged|exact text|raw data)\b/i.test(request))return false
  const value=text.trim()
  try{if(value.startsWith('{')||value.startsWith('[')){JSON.parse(value);return false}}catch{}
  if(/^(?:<\?xml|<!doctype|<html\b|<svg\b)/i.test(value))return false
  if(value.split(/\r?\n/).filter(Boolean).every(line=>/^[\d\s.,;\t+eE%-]+$/.test(line)))return false
  return true
}
