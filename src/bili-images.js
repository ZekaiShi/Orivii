import fs from 'node:fs/promises'
import path from 'node:path'
import {DotError} from './vault.js'

export async function cachedBiliImages(files,args,signal){
  signal?.throwIfAborted()
  const {files:rows}=await files.list({query:args.bv,kind:'image',limit:30}),groups=new Map(),page=args.p??1,mode=args.mode||(args.step!==undefined||args.indices?'frames':'preview')
  for(const file of rows){
    const source=file.source
    if(source?.kind!=='bilibili-frame'||source.bv!==args.bv||source.p!==page)continue
    if(mode==='frames'&&(!source.variant?.startsWith(args.bv+'-p'+page+'-')||source.variant.endsWith('-shots')||source.timeAccuracy==='preview-estimate'))continue
    if(args.step!==undefined&&source.variant!==args.bv+'-p'+page+'-'+args.step+'s')continue
    if(!groups.has(source.variant))groups.set(source.variant,[])
    groups.get(source.variant).push(file)
  }
  for(const group of groups.values()){
    group.sort((a,b)=>a.source.index-b.source.index)
    const wanted=args.indices||Array.from({length:Math.min(4,group.length)},(_,i)=>group.length<=4?group[i].source.index:group[Math.round(i*(group.length-1)/3)].source.index)
    if(!wanted.every(index=>group.some(file=>file.source.index===index)))continue
    const images=[...new Set(wanted)].map(index=>{const file=group.find(file=>file.source.index===index),source=file.source;return {...file,index,sourceUrl:'https://www.bilibili.com/video/'+args.bv+'/?p='+page,...(source.time!==undefined?{time:source.time,timeAccuracy:source.timeAccuracy}:{})}})
    signal?.throwIfAborted();return {images,frameCount:group.length,frameCountScope:'saved-selection',cached:true,source:'local-library'}
  }
  return null
}

const frameName=(bv,name)=>new RegExp('^'+bv+'-\\d+\\.jpg$').test(name)||/^f_\d+m\d+s\.jpg$/.test(name)
export async function importBiliImages(files,result,args,signal,{indices}={}){
  const bv=String(args.bv||args.bvid||'').match(/BV[\da-zA-Z]{10}/)?.[0],page=args.p??1,images=[]
  if(!bv||!Number.isInteger(page)||page<1)return {images,frameCount:0}
  for(const block of (result.content||[]).slice(0,8)){
    if(block.type!=='image'||typeof block.data!=='string'||block.data.length>2800000||!['image/jpeg','image/png','image/webp'].includes(block.mimeType||block.mediaType))continue
    signal?.throwIfAborted();const mediaType=block.mimeType||block.mediaType,extension=mediaType.split('/')[1],{file}=await files.cacheImage(bv+'-frame-'+(images.length+1)+'.'+extension,Buffer.from(block.data,'base64'),mediaType,{kind:'bilibili-frame',bv,p:page,index:images.length+1,variant:'tool-image'})
    images.push({...file,sourceUrl:'https://www.bilibili.com/video/'+bv+'/?p='+page,index:images.length+1})
    if(images.length===4)return {images,frameCount:images.length}
  }
  const text=result.value?.text||result.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n')||''
  let data;try{data=JSON.parse(text)}catch{data={}}
  if(images.length)return {images,frameCount:images.length}
  const directory=data.dir||data.frames?.dir||text.match(/^(?:抽帧)?目录:\s*(.+?)(?:（复用）)?$/m)?.[1]?.trim()||text.match(/^5 帧（[^\r\n]*）:\s*(.+)$/m)?.[1]?.trim()
  if(!directory)return {images,frameCount:images.length}
  const dir=await fs.realpath(directory),frames=path.dirname(dir),cache=path.dirname(frames)
  if(path.basename(frames)!=='frames'||!path.basename(dir).startsWith(bv+'-p'+page+'-'))throw new DotError('抽帧目录与当前视频不匹配。','bili_images')
  const marker=path.join(cache,'.bili-watch-root'),manifestPath=path.join(dir,'manifest.json')
  const markerStat=await fs.lstat(marker),manifestStat=await fs.lstat(manifestPath)
  if(markerStat.isSymbolicLink()||!markerStat.isFile()||!manifestStat.isFile()||manifestStat.size>300000||await fs.realpath(manifestPath)!==manifestPath)throw new DotError('抽帧缓存缺少有效归属信息。','bili_images')
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'))
  if(manifest.bv!==bv||Number(manifest.p??1)!==page)throw new DotError('抽帧来源校验未通过。','bili_images')
  const names=(Array.isArray(manifest.files)?manifest.files:await fs.readdir(dir)).filter(name=>typeof name==='string'&&path.basename(name)===name&&frameName(bv,name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).slice(0,500)
  const wanted=indices||Array.from({length:Math.min(4,names.length)},(_,i)=>names.length<=4?i+1:Math.round(i*(names.length-1)/3)+1)
  if(!Array.isArray(wanted)||wanted.length>4||wanted.some(index=>!Number.isInteger(index)||index<1||index>names.length))throw new DotError('请选择现有的抽帧序号，每次最多四张。','bili_images')
  for(const index of new Set(wanted)){
    signal?.throwIfAborted();const filename=names[index-1],candidate=await fs.realpath(path.join(dir,filename))
    if(path.dirname(candidate)!==dir)throw new DotError('抽帧文件超出了对应视频目录。','bili_images')
    const stat=await fs.stat(candidate);if(!stat.isFile()||stat.size>2*1024*1024)continue
    const namedTime=filename.match(/^f_(\d+)m(\d+)s\.jpg$/),time=namedTime?Number(namedTime[1])*60+Number(namedTime[2]):Array.isArray(manifest.times)&&Number.isFinite(manifest.times[index-1])?manifest.times[index-1]:null
    const source={kind:'bilibili-frame',bv,p:page,index,variant:path.basename(dir),...(time!==null?{time,timeAccuracy:manifest.source==='videoshot'?'preview-estimate':'requested-frame'}:{})}
    const {file}=await files.cacheImage(bv+'-frame-'+index+'.jpg',await fs.readFile(candidate),'image/jpeg',source)
    images.push({...file,sourceUrl:'https://www.bilibili.com/video/'+bv+'/?p='+page,index,...(time!==null?{time,timeAccuracy:manifest.source==='videoshot'?'preview-estimate':'requested-frame'}:{})})
  }
  return {images,frameCount:names.length}
}
