import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {DeepSeekAdapter,resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek'
import {attachFrameInput} from '../src/frame-input.js'
import {CompanionMedia} from '../src/media.js'
import {initialState} from '../src/vault.js'
import {MEMORY_DEFAULTS} from '../src/memory.js'
import {DotHost} from '../src/host.js'
import {randomUUID} from 'node:crypto'
import {LIVE_DEFAULTS} from '../src/live-settings.js'

const sharp=createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const jpeg=color=>sharp({create:{width:120,height:80,channels:3,background:color}}).jpeg().toBuffer()
async function fixture(t){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-frame-')),ctx=new Context()
  await ctx.plugin(LocalAttachments,{dshHome:root})
  const attachments=ctx.attachments
  let bridge
  await ctx.inject(['attachments'],child=>{bridge=attachFrameInput(child.attachments);return()=>bridge.dispose()})
  t.after(async()=>{bridge.dispose();await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true})})
  return {root,ctx,attachments,bridge}
}

test('actual DSH prepared call and DeepSeek serializer receive frame bytes through the temporary bridge',async t=>{
  const {ctx,attachments,bridge}=await fixture(t),captured=[]
  const options=resolveAdapterOptions({baseURL:'https://synthetic.invalid',models:[{id:'deepseek-flash',inputModalities:['text','image'],contextWindow:128000}]})
  const adapter=new DeepSeekAdapter({options:()=>options,resolveAuth:async()=>({headers:{Authorization:'Bearer synthetic-only'}}),resolveUserId:()=> 'synthetic-user',resolveAttachments:()=>attachments,prepareExtensions:async()=>({fields:{},accept:async()=>{}})})
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url).includes('/files'))return new Response('{"error":{"message":"unsupported"}}',{status:404,headers:{'Content-Type':'application/json'}})
    captured.push(JSON.parse(init.body))
    return new Response('{"error":{"message":"synthetic endpoint reached"}}',{status:400,headers:{'Content-Type':'application/json'}})
  })
  await ctx.plugin(LlmRuntime)
  const unregister=ctx.llm.registerAdapter(['configured-provider'],adapter);t.after(unregister)
  const call=await ctx.llm.prepareCall({provider:'configured-provider',model:'deepseek-flash',maxTokens:500})
  assert.ok(call.inputModalities.includes('image'))
  await bridge.run(await jpeg('gold'),undefined,async image=>{
    for await(const _ of call.stream({...call.config,messages:[{role:'user',content:[{type:'text',text:'Describe this synthetic frame'},image]}]})){}
  })
  assert.equal(captured.length,1)
  assert.equal(captured[0].model,'deepseek-flash')
  const image=captured[0].messages.flatMap(m=>m.content).find(b=>b.type==='image')
  assert.equal(image.source.type,'base64');assert.ok(image.source.data.length>100)
  assert.equal((await sharp(Buffer.from(image.source.data,'base64')).metadata()).format,'jpeg')
})

test('request frames use actual DSH attachment reads without creating objects; normal attachments still work',async t=>{
  const {attachments,bridge}=await fixture(t),bytes=await jpeg('red')
  const stored=await attachments.saveImage({data:await jpeg('blue'),mediaType:'image/jpeg'})
  const normal=await attachments.readImage(stored),objectFiles=await fs.readdir(path.join(attachments.root,'objects'),{recursive:true})
  let ref
  await bridge.run(bytes,undefined,async image=>{
    ref=image.attachment
    assert.equal(attachments.imageHostPath(ref),undefined)
    assert.equal((await attachments.readImage(ref)).ref.attachmentId,ref.attachmentId)
    const version=await attachments.readImageRequest(structuredClone(ref),{width:30,height:20,maxBytes:10000})
    assert.equal(version.width,30);assert.equal(version.height,20)
    assert.equal((await sharp(version.data).metadata()).width,30)
    assert.deepEqual((await attachments.readImage(stored)).data,normal.data)
  })
  await assert.rejects(()=>attachments.readImage(ref))
  assert.deepEqual(await fs.readdir(path.join(attachments.root,'objects'),{recursive:true}),objectFiles)
  assert.deepEqual((await attachments.readImage(stored)).data,normal.data)
})

test('several user images share a request scope and disappear together when the request completes',async t=>{
  const {bridge,attachments}=await fixture(t),one=await jpeg('red'),two=await sharp({create:{width:120,height:80,channels:4,background:'#00ff00'}}).png().toBuffer()
  let refs
  await bridge.runMany([{bytes:one,mediaType:'image/jpeg'},{bytes:two,mediaType:'image/png'}],undefined,async images=>{
    assert.equal(images.length,2);refs=images.map(x=>x.attachment)
    for(const ref of refs){assert.ok((await attachments.readImage(ref)).data.length);assert.equal(attachments.imageHostPath(ref),undefined)}
    assert.notEqual(refs[0].attachmentId,refs[1].attachmentId)
  })
  for(const ref of refs)await assert.rejects(()=>attachments.readImage(ref))
})

test('an uploaded chat image reaches the current model through DSH and is released after the reply',async t=>{
  const {root,attachments,bridge}=await fixture(t);let ref,seen=false
  const services={extension:{createExtension:()=>null},frameInput:bridge,defaultModel:{currentSelection:()=>({provider:'fixture',model:'vision'})},llm:{async prepareCall(config){return {config,inputModalities:['text','image'],context:{contextWindow:128000},async *stream(options){
    const image=options.messages.flatMap(m=>m.content).find(b=>b.type==='image');assert.ok(image);ref=image.attachment
    assert.ok((await attachments.readImage(ref)).data.length);seen=true
    yield {type:'block-end',index:0,block:{type:'text',text:'这是一张合成测试图。'}};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')});t.after(()=>host.dispose())
  const opened=await host.command({action:'setup',workspace:path.join(root,'chat'),password:'synthetic-image-test',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}});assert.equal(opened.ok,true)
  const token=opened.value.token,call=async(action,data={})=>{const r=await host.command({action,token,...data});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  const file=await host.engine.files.save('sample.jpg',await jpeg('blue'),'image/jpeg'),chat=await call('createChat'),job=await call('send',{chatId:chat.id,text:'看看附件',requestId:randomUUID(),attachments:[file.id]})
  await host.engine.jobs.get(job.id)?.promise
  assert.equal(seen,true);await assert.rejects(()=>attachments.readImage(ref))
  const snapshot=await call('snapshot',{chatId:chat.id});assert.equal(snapshot.jobs.at(-1).status,'done');assert.doesNotMatch(JSON.stringify(snapshot),/attachmentId|base64/)
})

test('concurrent request scopes cannot borrow each other frames; abort and disposal release access',async t=>{
  const {attachments,bridge}=await fixture(t),first=await jpeg('red'),second=await jpeg('green')
  let a,b,readyA,readyB,release
  const gate=new Promise(r=>{release=r}),aReady=new Promise(r=>{readyA=r}),bReady=new Promise(r=>{readyB=r})
  const one=bridge.run(first,undefined,async image=>{a=image.attachment;readyA();await bReady;await assert.rejects(()=>attachments.readImage(b));await gate;assert.equal((await attachments.readImage(a)).ref.attachmentId,a.attachmentId)})
  const two=bridge.run(second,undefined,async image=>{b=image.attachment;readyB();await aReady;await assert.rejects(()=>attachments.readImage(a));release()})
  await Promise.all([one,two])
  const controller=new AbortController()
  await bridge.run(first,controller.signal,async image=>{controller.abort();assert.throws(()=>attachments.readImage(image.attachment),/abort/i)})
  let finish,late
  await bridge.run(first,undefined,async image=>{late=new Promise(r=>{finish=r}).then(()=>attachments.readImage(image.attachment))})
  finish();await assert.rejects(late,/lease has ended/)
  bridge.dispose();await assert.rejects(()=>bridge.run(first,undefined,()=>{}),/unavailable/)
  assert.equal(Object.hasOwn(attachments,'readImage'),false,'disposing the bridge restores the original service method')
})

test('media routes frames through the current multimodal chat model with no speech key or durable frame',async t=>{
  const {root,attachments,bridge}=await fixture(t),bytes=await jpeg('orange'),stored=[]
  const state=initialState({...MEMORY_DEFAULTS}),url='https://example.org/video'
  const player={url,title:'Synthetic video',source:'movie',time:12,rate:1,paused:true}
  let screenshot,requests=0,selected='deepseek-flash',fail=false,release
  const vault={read:async()=>state,transaction:async fn=>fn(state)}
  const engine={async prepare(){return {config:{provider:'configured-dsh-provider',model:selected,maxTokens:1024},inputModalities:['text','image'],async *stream(options){
    requests++;assert.equal(options.provider,'configured-dsh-provider');assert.equal(options.model,selected)
    assert.match(options.system,/不推测后续剧情/)
    assert.equal(options.messages.length,1)
    const image=options.messages[0].content.find(b=>b.type==='image')
    assert.ok(image);assert.equal(attachments.imageHostPath(image.attachment),undefined)
    assert.ok((await attachments.readImageRequest(image.attachment,{width:120,height:80,maxBytes:100000})).data.length)
    if(fail)throw Error('synthetic provider failure')
    if(release)await release
    yield {type:'text-delta',index:0,text:'{"caption":"橙色画面","importance":0.4,"emotions":{"curiosity":0.2}}'}
    yield {type:'finish',reason:{kind:'stop'}}
  }}},isForegroundBusy:()=>false}
  const browser={screenshot:async({filename})=>{screenshot=path.join(root,filename);await fs.writeFile(screenshot,bytes);return {path:screenshot}},evaluate:async()=>({url,resultJson:JSON.stringify(player)}),pageStamp:()=>({url,generation:1})}
  const media=new CompanionMedia({vault,services:{browser,frameInput:bridge},engine,key:()=>'',fetcher:()=>{throw Error('Bailian must not be used')}})
  const a={id:'activity',origin:new URL(url).origin,session:'synthetic',mode:'video',last:player,watched:[[10,12]],controller:new AbortController()}
  media.active=a;media.storeObservation=async(_a,o)=>stored.push(o)
  const o={id:'source',position:12,text:'已观看字幕'}
  await media.describeFrame(a,player,o,LIVE_DEFAULTS)
  assert.equal(requests,1);assert.equal(a.visionAvailable,true);assert.equal(stored[0].perception,'frame')
  assert.equal(stored[0].caption,'橙色画面');assert.doesNotMatch(JSON.stringify(stored),/attachmentId|base64/)
  await assert.rejects(()=>fs.access(screenshot))
  // An unsuccessful frame is retryable; changing the dialog model is honored.
  a.lastFrameHash=null;fail=true
  await media.describeFrame(a,player,o,LIVE_DEFAULTS)
  assert.equal(a.visionAvailable,false);assert.equal(a.lastFrameHash,null)
  fail=false;selected='another-vision-model'
  await media.describeFrame(a,player,o,LIVE_DEFAULTS)
  assert.equal(requests,3);assert.equal(a.visionAvailable,true)
  // A model response arriving after activity cancellation cannot become memory.
  a.lastFrameHash=null;let done;release=new Promise(r=>{done=r})
  const pending=media.describeFrame(a,player,o,LIVE_DEFAULTS)
  while(requests<4)await new Promise(r=>setTimeout(r,5))
  const before=stored.length;a.controller.abort();media.active=null;done();await pending
  assert.equal(stored.length,before);await assert.rejects(()=>fs.access(screenshot))
})

test('text-only models stay on subtitles without an external fallback in this release',async()=>{
  const state=initialState({...MEMORY_DEFAULTS}),engine={prepare:async()=>({config:{model:'text-only'},inputModalities:['text']})}
  const media=new CompanionMedia({vault:{read:async()=>state},services:{},engine,key:()=>''})
  assert.equal((await media.visionStatus(LIVE_DEFAULTS)).mode,'subtitles')
  assert.equal((await media.visionStatus({...LIVE_DEFAULTS,visionModel:'qwen-vl'})).mode,'subtitles')
  media.key=()=> 'synthetic-key'
  assert.equal((await media.visionStatus({...LIVE_DEFAULTS,visionModel:'qwen-vl'})).mode,'subtitles')
  engine.prepare=async()=>({config:{model:'vision-model'},inputModalities:['text','image']});media.services.frameInput={}
  assert.equal((await media.visionStatus({...LIVE_DEFAULTS,visionModel:'qwen-vl'})).mode,'chat')
})
