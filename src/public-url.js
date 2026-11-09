import {lookup} from 'node:dns/promises'
import {isIP} from 'node:net'
import {DotError} from './vault.js'
export function mediaUrl(value){
  let u;try{u=new URL(value)}catch{throw new DotError('请输入完整网页地址。')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.href.length>2048||u.port&&!['80','443'].includes(u.port))throw new DotError('陪伴窗口只接受公开网页。')
  const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase()
  if(isIP(h)||h==='localhost'||!h.includes('.')||/\.(local|internal|localhost|lan)$/.test(h))throw new DotError('此地址不属于公开网页。')
  u.hash='';return u
}
export function publicAddress(ip){
  if(ip.includes(':'))return !/^(::|fc|fd|fe[89ab]|ff)/i.test(ip)&&!ip.includes('.')
  const [a,b]=ip.split('.').map(Number)
  return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127)&&a!==198
}
export async function validatePublicPage(value,resolver=lookup){const u=mediaUrl(value),ips=await resolver(u.hostname,{all:true});if(!ips.length||ips.some(x=>!publicAddress(x.address)))throw new DotError('此页面解析到了本机或内网，已停止。');return u}
