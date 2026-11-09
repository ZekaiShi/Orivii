import {DotError} from './vault.js'
import {publicBubble} from './expression.js'

// Optional host-only presentation policy. Its implementation and configuration
// are supplied by the installed extension, never sent to the browser.
export function responseText(vault,text,{partial=false}={}){
  const policy=vault.responsePolicy,method=partial?'preview':'filter'
  if(!policy)return text
  try{
    const result=policy[method](text)
    if(typeof result!=='string'||result.length>200000||!partial&&text.trim()&&!result.trim())throw new Error('invalid policy result')
    return result
  }catch{
    if(partial)return ''
    throw new DotError('这条回复暂时无法显示，请重试。','presentation')
  }
}
export function responseBubble(vault,message){
  const bubble=publicBubble(message)
  if(bubble.role!=='assistant')return bubble
  return {...bubble,text:responseText(vault,bubble.text)}
}
