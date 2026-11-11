import {randomUUID} from 'node:crypto'
import {DotError} from './vault.js'
import {registeredTools} from './capabilities.js'
const READ_NAMES=new Set(['bili_search','bili_subtitle','bili_video_info','bili_recommend','bili_comments','bili_danmaku','bili_whoami'])
const WATCH_COMMANDS=new Set(['search','hot','peek','view','sub','comments','danmaku','asr','frames','sheet','substrip','ocr','text'])
const has=(services,name)=>Boolean(services.tools?.get?.(name,services.toolScope))
export const biliAvailable=services=>has(services,'bili_watch')||registeredTools(services).tools.some(t=>READ_NAMES.has(t.name))||has(services,'bili_subtitle')
export function availableBiliTools(services,{companionActive=false}={}){
  if(companionActive)return []
  const registered=registeredTools(services).tools
  const watch=registered.find(t=>t.name==='bili_watch')
  let watchTools=[]
  if(watch?.parameters?.type==='object'){
    const parameters=structuredClone(watch.parameters);parameters.properties??={};delete parameters.properties.out
    parameters.properties.command={...parameters.properties.command,type:'string',enum:[...WATCH_COMMANDS]}
    parameters.additionalProperties=false;parameters.required=[...new Set([...(parameters.required||[]),'command'])].filter(k=>k!=='out')
    watchTools=[{...watch,parameters}]
  }
  return [...(has(services,'bili_watch')||has(services,'bili_subtitle')?biliTools:[]),...(has(services,'bili_watch')?[biliImageTool]:[]),...watchTools,...registered.filter(t=>READ_NAMES.has(t.name))]
}
const biliImageTool={name:'read_bilibili_images',description:'取得 B站视频画面并存入本地库，最多四张。先复用本地图片；默认快速预览，mode=frames 或指定 step/indices 时使用原视频抽帧。preview 使用插件的五帧预览通道，位置可能是估计值；核对细字时选择 frames。返回可查看和发送的图片 id。',parameters:{type:'object',properties:{bv:{type:'string'},p:{type:'integer',minimum:1},mode:{type:'string',enum:['preview','frames']},step:{type:'number',minimum:1},indices:{type:'array',items:{type:'integer',minimum:1},maxItems:4,minItems:1}},required:['bv'],additionalProperties:false}}
export const biliCaptureTool={...biliImageTool,name:'capture_bilibili_frame',description:'快速截取并交付 B站画面：先复用本地图片；无缓存时默认走插件预览，mode=frames 或指定 step/indices 时抽取原视频。普通截图取到就自动发送，省去看图和确认发送的模型请求。用户需要解读画面时设置 analyze=true，由你看图后回答。返回 accepted 后自然回应并结束本次前台短回复。',parameters:{...biliImageTool.parameters,properties:{...biliImageTool.parameters.properties,analyze:{type:'boolean'}}}}
export function biliFrameRequest(args){
  if(!args||Object.keys(args).some(key=>!['bv','p','mode','step','indices','analyze'].includes(key))||!/^BV[0-9A-Za-z]{10}$/.test(args.bv)||args.p!==undefined&&(!Number.isSafeInteger(args.p)||args.p<1||args.p>10000)||args.mode!==undefined&&!['preview','frames'].includes(args.mode)||args.mode==='preview'&&args.step!==undefined||args.analyze!==undefined&&typeof args.analyze!=='boolean'||args.step!==undefined&&(!Number.isFinite(args.step)||args.step<1)||args.indices&&(!Array.isArray(args.indices)||!args.indices.length||args.indices.length>4||args.indices.some(i=>!Number.isSafeInteger(i)||i<1)))throw new DotError('视频抽帧参数无效。')
  return {bv:args.bv,...(args.p!==undefined?{p:args.p}:{}),...(args.mode?{mode:args.mode}:{}),...(args.analyze!==undefined?{analyze:args.analyze}:{}),...(args.step!==undefined?{step:args.step}:{}),...(args.indices?{indices:[...new Set(args.indices)]}:{})}
}
export function biliConnection(services){
  const names=availableBiliTools(services).map(t=>t.name)
  const scroll=has(services,'bili_login_start')&&has(services,'bili_login_poll')
  return {available:biliAvailable(services),tools:names,watch:has(services,'bili_watch'),loginProvider:has(services,'bili_watch')?'watch':scroll?'scroll':null,providers:[...(has(services,'bili_watch')?['dsh-bili-watch']:[]),...(scroll?['dsh-bili-scroll']:names.some(n=>READ_NAMES.has(n))?['B站已注册工具']:[])]}
}
export const biliConnectionTools=[{name:'check_bilibili_connection',description:'检查当前宿主的 B站插件与登录状态。已登录时复用原插件；需要登录或缺少插件时自动向用户显示连接卡片。二维码由本地界面生成，不需要在回复中输出图片路径或登录密钥。普通网页遇到验证码不能用于判断插件登录。',parameters:{type:'object',properties:{},additionalProperties:false}}]

function loginRecord(result){
  if(result?.isError)return null
  let value=result?.value??result
  for(let i=0;i<5;i++){
    if(typeof value==='string'){try{value=JSON.parse(value)}catch{return null};continue}
    if(!value||typeof value!=='object')return null
    if(typeof value.logged_in==='boolean'||typeof value.loggedIn==='boolean')return value
    if(value.raw!==undefined){value=value.raw;continue}
    const text=value.content?.filter(c=>c?.type==='text').map(c=>c.text).join('\n')
    if(text){value=text;continue}
    return null
  }
  return null
}
export async function checkBiliConnection(services,{signal,verify=true}={}){
  const info=biliConnection(services),registry=registeredTools(services)
  if(!info.available)return {...info,state:registry.ready?'plugin_missing':'unavailable',credentialPresent:null}
  // These plugins keep separate credential stores. Scroll's login does not
  // verify watch; the owner UI reads watch's own same-origin status endpoint.
  if(info.watch)return {...info,state:'unknown',credentialPresent:null}
  if(!verify)return {...info,state:'unknown',credentialPresent:null}
  const execute=async name=>loginRecord(await services.tools.execute({callId:randomUUID(),name,arguments:{},...(services.toolScope?{agent:services.toolScope}:{}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(20000)])}))
  let present=null
  try{
    if(has(services,'bili_status')){
      const status=await execute('bili_status');present=typeof status?.loggedIn==='boolean'?status.loggedIn:null
      if(present===false)return {...info,state:'needs_login',credentialPresent:false}
    }
    if(has(services,'bili_whoami')){
      const auth=await execute('bili_whoami'),logged=auth?.logged_in??auth?.loggedIn
      if(logged===true)return {...info,state:'connected',credentialPresent:true,verification:'plugin_reported'}
      // Plugin failures can also mean timeout, missing Python or anti-bot checks.
      if(logged===false&&present===false)return {...info,state:'needs_login',credentialPresent:false}
    }
  }catch{signal?.throwIfAborted()}
  return {...info,state:'unknown',credentialPresent:present}
}
export const biliTools=[{name:'read_bilibili_video',description:'复用 DSH 已注册的 B站字幕接口（bili_watch 或 bili_subtitle），读取用户提供的视频字幕或正文。原插件复用自己的登录和缓存，无需重新配置。仅用于普通视频调查；陪看期间禁用全文读取以免剧透。',parameters:{type:'object',properties:{bv:{type:'string',maxLength:160},p:{type:'integer',minimum:1,maximum:10000}},required:['bv'],additionalProperties:false}}]
export async function readBili(services,args,signal,{companionActive=false}={}){
  if(companionActive)throw new DotError('正在陪看，只能观察当前已播放内容，不能读取全文。')
  if(!biliAvailable(services))throw new DotError('当前 DSH 环境尚未注册 B站读取工具，请在此环境安装并启用 B站插件。')
  const bv=String(args.bv||'').match(/(?:^|\/)(BV[0-9A-Za-z]{10})(?:$|[/?#])/)?.[1],p=args.p??1
  if(!bv||!Number.isSafeInteger(p)||p<1||p>10000)throw new DotError('请提供有效 BV 号与分 P 编号。')
  const name=has(services,'bili_watch')?'bili_watch':has(services,'bili_subtitle')?'bili_subtitle':null
  if(!name)throw new DotError('当前已注册 B站工具，但未提供字幕读取接口；可先查询搜索或视频信息。')
  if(name==='bili_subtitle'&&p!==1)throw new DotError('当前字幕接口没有分 P 参数，请使用支持分 P 的读取插件。')
  // Watch replaces long JSON with a cache-path notice. Markdown gives the
  // actual bounded transcript inline, which this text-only adapter can use.
  const result=await services.tools.execute({callId:randomUUID(),name,arguments:name==='bili_watch'?{command:'text',bv,p,format:'md',head:6000}:{bvid:bv},...(services.toolScope?{agent:services.toolScope}:{}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(name==='bili_watch'?900000:90000)])})
  if(result?.isError||result?.value?.ok===false)throw new DotError('B 站内容暂时读取失败，请检查原插件的字幕、转写依赖和登录状态。','bili_read')
  const text=result?.value?.text??result?.text??result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??''
  if(!text)throw new DotError('B 站插件没有返回可读内容。')
  if(/^（全文 \d+ 字，超限，JSON 已整体落盘/.test(text))throw new DotError('插件这次仅返回缓存路径，尚未拿到视频正文。','bili_read')
  return {url:`https://www.bilibili.com/video/${bv}/?p=${p}`,content:String(text).slice(0,12000),truncated:String(text).length>12000||/只回了前 \d+ 字/.test(text),untrusted:true}
}

export async function executeBiliTool(services,name,args,signal,{companionActive=false,captureImages,cacheImages}={}){
  if(companionActive)throw new DotError('正在陪看，请使用当前画面观察接口。')
  if(name==='read_bilibili_images'){
    if(!captureImages||!has(services,'bili_watch'))throw new DotError('当前视频图片交付通道未就绪。','bili_images')
    args=biliFrameRequest(args)
    const start=Date.now(),cached=cacheImages?await cacheImages(args,signal):null,cacheLookupMs=Date.now()-start,url='https://www.bilibili.com/video/'+args.bv+'/?p='+(args.p??1)
    if(cached?.images?.length)return {...cached,tool:name,url,content:JSON.stringify(cached),untrusted:true,retrievedAt:Date.now(),timings:{cacheLookupMs,pluginMs:0,imageImportMs:0}}
    const mode=args.mode||(args.step!==undefined||args.indices?'frames':'preview')
    const result=await executeBiliTool(services,'bili_watch',{command:mode==='preview'?'peek':'frames',bv:args.bv,...(args.p?{p:args.p}:{}),...(args.step?{step:args.step}:{})},signal,{companionActive,captureImages:(result,request)=>captureImages(result,request,{indices:args.indices})})
    return {...result,timings:{cacheLookupMs,...result.timings}}
  }
  if(!(READ_NAMES.has(name)||name==='bili_watch')||!(name==='bili_watch'?has(services,name):availableBiliTools(services).some(t=>t.name===name)))throw new DotError('该 B站读取接口当前不可用，请重新检测。')
  if(name==='bili_watch'&&(!WATCH_COMMANDS.has(args?.command)||args.out!==undefined))throw new DotError('只允许使用 B站内容读取操作。')
  if(name==='bili_watch')args=args.command==='text'?{...args,format:'md',head:6000,full:false}:{...args,full:true}
  const slow=name==='bili_watch'&&['asr','text','ocr','frames','sheet','substrip','peek'].includes(args.command)
  const started=Date.now(),result=await services.tools.execute({callId:randomUUID(),name,arguments:args,...(services.toolScope?{agent:services.toolScope}:{}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(slow?900000:90000)])}),pluginMs=Date.now()-started
  if(result?.isError||result?.value?.ok===false)throw new DotError('B站接口读取失败，请检查原插件的登录、依赖和网络状态。','bili_read')
  let content=result?.value?.text||(result?.content||[]).filter(b=>b?.type==='text').map(b=>b.text).join('\n')||JSON.stringify(result?.value??{}),captured,imageImportMs=0
  if(captureImages&&name==='bili_watch'&&['frames','peek'].includes(args.command)){
    const importStarted=Date.now();captured=await captureImages(result,args);imageImportMs=Date.now()-importStarted
    content=JSON.stringify({frameCount:captured.frameCount,images:captured.images,note:captured.images.length?'真实画面已保存为图片附件，可由主代理查看并用 send_chat_image 发送。':'本次尚未取得可发送的画面附件。'})
  }
  if(/^（全文 \d+ 字，超限，JSON 已整体落盘/.test(content))throw new DotError('插件这次仅返回缓存路径，尚未拿到材料正文。','bili_read')
  return {...(captured?{images:captured.images,frameCount:captured.frameCount}:{}),tool:name,content:content.slice(0,12000),truncated:content.length>12000||/只回了前 \d+ 字/.test(content),untrusted:true,...(/^BV[\dA-Za-z]{10}$/.test(args?.bvid||args?.bv||'')?{url:`https://www.bilibili.com/video/${args.bvid||args.bv}/`}:{}),retrievedAt:Date.now(),timings:{pluginMs,imageImportMs}}
}
