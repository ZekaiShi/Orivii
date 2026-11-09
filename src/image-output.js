import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {lookup} from 'node:dns/promises'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {DotError} from './vault.js'
import {mediaUrl,publicAddress} from './public-url.js'

export const OUTPUT_IMAGE_LIMIT=2*1024*1024
const imageTypes=new Set(['image/jpeg','image/png','image/webp','image/gif'])
export function imageType(bytes){
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg'
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString()))return 'image/gif'
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp'
  throw new DotError('这个来源没有返回可显示的图片。')
}
export async function workspaceImage(workspace,relative){
  if(typeof relative!=='string'||!relative||relative.length>2048||/^([/\\~]|[A-Za-z]:)/.test(relative)||relative.split(/[/\\]/).some(p=>p==='..'||p==='.dot-memory'))throw new DotError('图片路径须位于当前工作空间内。')
  const root=await fs.realpath(workspace),file=await fs.realpath(path.resolve(root,relative.replace(/[/\\]/g,path.sep))).catch(()=>{throw new DotError('没有找到工作空间中的图片。')})
  const rel=path.relative(root,file)
  if(!rel||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new DotError('图片路径超出了当前工作空间。')
  const handle=await fs.open(file,'r')
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>OUTPUT_IMAGE_LIMIT)throw new DotError('图片须为 1 字节至 2 MB。')
    const buffer=Buffer.alloc(OUTPUT_IMAGE_LIMIT+1);let size=0
    while(size<buffer.length){const r=await handle.read(buffer,size,buffer.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead}
    if(size>OUTPUT_IMAGE_LIMIT)throw new DotError('图片请控制在 2 MB 内。')
    return {bytes:buffer.subarray(0,size),name:path.basename(file),mediaType:imageType(buffer.subarray(0,size))}
  }finally{await handle.close()}
}
export async function publicImage(value,signal,{resolver=lookup,requesters={http:httpRequest,https:httpsRequest}}={}){
  signal=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(20000)])
  let url=mediaUrl(value)
  for(let redirects=0;redirects<=3;redirects++){
    signal.throwIfAborted()
    const addresses=await resolver(url.hostname,{all:true})
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new DotError('图片地址解析到了本机或内网。')
    const result=await new Promise((resolve,reject)=>{
      const request=requesters[url.protocol==='https:'?'https':'http'](url,{method:'GET',signal,headers:{Accept:'image/png,image/jpeg,image/webp,image/gif','User-Agent':'Orivii/1.0',...(/(?:^|\.)hdslb\.com$/.test(url.hostname)?{Referer:'https://www.bilibili.com/'}:{})},lookup:(_host,options,callback)=>options?.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family)},response=>{
        if([301,302,303,307,308].includes(response.statusCode)){response.resume();resolve({location:response.headers.location});return}
        const type=String(response.headers['content-type']||'').split(';')[0].toLowerCase()
        if(response.statusCode!==200||!imageTypes.has(type)||Number(response.headers['content-length'])>OUTPUT_IMAGE_LIMIT){response.destroy();reject(new DotError('图片读取失败、格式不支持或超过 2 MB。'));return}
        const chunks=[];let size=0
        response.on('data',chunk=>{size+=chunk.length;if(size>OUTPUT_IMAGE_LIMIT){response.destroy();reject(new DotError('图片超过 2 MB。'))}else chunks.push(chunk)})
        response.on('end',()=>{const bytes=Buffer.concat(chunks);if(!bytes.length)return reject(new DotError('图片内容为空。'));resolve({bytes,mediaType:type})})
        response.on('error',()=>reject(new DotError('图片传输未完成。')))
      })
      request.on('error',()=>reject(new DotError(signal.aborted?'图片读取已取消或超时。':'图片连接失败。')));request.end()
    })
    if(result.bytes){if(imageType(result.bytes)!==result.mediaType)throw new DotError('图片格式与实际内容不一致。');return {...result,name:'image.'+result.mediaType.split('/')[1].replace('jpeg','jpg')}}
    if(!result.location||redirects===3)throw new DotError('图片跳转次数过多或地址无效。')
    const next=mediaUrl(new URL(result.location,url).href)
    if(url.protocol==='https:'&&next.protocol!=='https:')throw new DotError('图片跳转到了不安全的连接。')
    url=next
  }
}
