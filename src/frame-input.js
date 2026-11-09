import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {prepareImageFile} from '@deepseek-ai/dsh-attachment-local'

// DSH 0.2.1 image blocks require an attachment reference. Keep companion
// frames in the current async request instead of publishing durable objects.
// The three public read methods delegate unchanged outside this scope. Never
// replace the attachment service, its admission policy, or its write methods.
const bridges=new WeakMap()
const LIMITS={maxImageBytes:2*1024*1024,maxImagePixels:16000000,maxImageDimension:8192}
const POLICY={maxPixels:1048576,maxDimension:1920,maxBytes:1024*1024}
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex')

export function attachFrameInput(store){
  if(!store||!['readImage','readImageRequest','imageHostPath'].every(k=>typeof store[k]==='function'))return null
  // Cordis supplies a different contextual proxy to each injected plugin.
  // The installed own method identifies the underlying bridge across proxies.
  const installedRead=Object.getOwnPropertyDescriptor(store,'readImage')?.value
  let bridge=installedRead&&bridges.get(installedRead)
  if(!bridge){
    const scope=new AsyncLocalStorage(),originals=new Map(),wrappers=new Map()
    bridge={scope,users:0,leases:new Set()}
    for(const name of ['readImage','readImageRequest','imageHostPath']){
      const original=store[name],descriptor=Object.getOwnPropertyDescriptor(store,name)
      const wrapper=function(ref,...args){
        const frame=scope.getStore()?.find(f=>f.ref.attachmentId===ref?.attachmentId)
        if(!frame)return Reflect.apply(original,this,[ref,...args])
        if(frame.closed)throw new Error('Companion frame lease has ended')
        frame.signal?.throwIfAborted()
        if(name==='imageHostPath')return undefined
        if(name==='readImage'){
          args[0]?.throwIfAborted()
          return Promise.resolve({ref:frame.ref,data:frame.data})
        }
        const [target,signal]=args
        signal?.throwIfAborted()
        if(!target||![target.width,target.height,target.maxBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid frame projection')
        const width=Math.min(target.width,frame.ref.width),height=Math.min(target.height,frame.ref.height),maxBytes=Math.min(target.maxBytes,POLICY.maxBytes)
        const key=JSON.stringify([width,height,maxBytes])
        if(!frame.variants.has(key))frame.variants.set(key,(async()=>{
          const projected=await prepareImageFile({data:frame.data,mediaType:frame.ref.mediaType},LIMITS,{maxPixels:width*height,maxDimension:Math.max(width,height),maxBytes})
          signal?.throwIfAborted();frame.signal?.throwIfAborted()
          if(frame.closed)throw new Error('Companion frame lease has ended')
          return {variantId:digest(frame.ref.attachmentId+key),attachment:frame.ref,data:projected.data,
            mediaType:projected.ref.mediaType,bytes:projected.data.byteLength,width:projected.ref.width,height:projected.ref.height,depth:'uchar',space:'srgb',hasAlpha:false}
        })())
        return frame.variants.get(key)
      }
      originals.set(name,{original,descriptor});wrappers.set(name,wrapper)
    }
    const installed=[]
    try{for(const [name,wrapper]of wrappers){Object.defineProperty(store,name,{value:wrapper,configurable:true,writable:true});installed.push(name)}}
    catch{for(const name of installed){const {descriptor}=originals.get(name);if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name]}return null}
    bridge.restore=()=>{for(const [name,wrapper]of wrappers)if(Object.getOwnPropertyDescriptor(store,name)?.value===wrapper){const {descriptor}=originals.get(name);if(descriptor)Object.defineProperty(store,name,descriptor);else delete store[name]}}
    bridge.key=wrappers.get('readImage');bridges.set(bridge.key,bridge)
  }
  bridge.users++;let disposed=false
  return {
    async run(bytes,signal,consume){
      return this.runMany([{bytes,mediaType:'image/jpeg'}],signal,images=>consume(images[0]))
    },
    async runMany(inputs,signal,consume){
      if(disposed)throw new Error('Frame input unavailable')
      signal?.throwIfAborted()
      if(!Array.isArray(inputs)||inputs.length>4)throw new Error('Invalid image count')
      const frames=[]
      for(const {bytes,mediaType} of inputs){
      if(!bytes?.byteLength||bytes.byteLength>LIMITS.maxImageBytes||!['image/jpeg','image/png','image/webp','image/gif'].includes(mediaType))throw new Error('Invalid frame size or type')
      const prepared=await prepareImageFile({data:bytes,mediaType},LIMITS,POLICY)
      frames.push({...prepared,signal,variants:new Map(),closed:false})
      }
      signal?.throwIfAborted()
      if(disposed)throw new Error('Frame input unavailable')
      frames.forEach(frame=>bridge.leases.add(frame))
      try{return await bridge.scope.run(frames,()=>consume(frames.map(frame=>({type:'image',attachment:frame.ref}))))}
      finally{for(const frame of frames){frame.closed=true;frame.data=null;frame.variants.clear();bridge.leases.delete(frame)}}
    },
    dispose(){
      if(disposed)return;disposed=true
      if(--bridge.users===0){
        for(const frame of bridge.leases){frame.closed=true;frame.data=null;frame.variants.clear()}
        bridge.leases.clear();bridge.restore();bridges.delete(bridge.key)
      }
    },
  }
}
