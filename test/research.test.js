import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import {attachFrameInput} from '../src/frame-input.js'
import {importBiliImages,cachedBiliImages} from '../src/bili-images.js'
import {executeBiliTool} from '../src/bili.js'
const sharp=createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')

const tool=(name,args,id=randomUUID())=>({type:'tool-call',name,id,arguments:JSON.stringify(args)})
const say=text=>[{type:'text',text}]
async function until(fn,message='condition',limit=8000){const end=Date.now()+limit;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+message)}
async function fixture(t,handler,{vision=false}={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-research-'))
  const requests=[],errors=[],services={defaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{async prepareCall(config){return {config,inputModalities:vision?['text','image']:['text'],context:{contextWindow:128000},stream:async function*(options){requests.push(options);let blocks;try{blocks=await handler(options)}catch(error){errors.push(error);throw error}for(let i=0;i<blocks.length;i++)yield {type:'block-end',index:i,block:blocks[i]};yield {type:'finish',reason:{kind:'stop'}}}}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:path.join(root,'workspace'),password:'test-password-only',settings:{autoPermanent:false,autoProfile:false,autoLearn:false,persona:'PRIVATE_PERSONA_MARKER，使用温柔语气。'}})
  assert.equal(open.ok,true,JSON.stringify(open));const token=open.value.token
  const call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  await call('extension',{request:{operation:'savePolicy',policy:{analysisEnabled:false}}})
  const chat=await call('createChat')
  const send=async text=>{await call('send',{chatId:chat.id,text,requestId:randomUUID()});await until(async()=>!(await host.vault.read()).catalog.jobs.some(j=>j.kind!=='continuation'&&j.status==='running'),'foreground finished')}
  return {host,services,requests,errors,call,chat,send,token,root}
}

test('hidden lookup releases foreground, preserves current persona, and delivers through main agent exactly once',async t=>{
  let turns=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      assert.doesNotMatch(o.system+JSON.stringify(o.messages),/PRIVATE_PERSONA_MARKER|PRIVATE_REASONING/)
      return o.messages.some(m=>m.role==='tool')?say('WORKER_FINDING_ONLY'): [tool('web_search',{query:'public test'})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      assert.match(o.system,/PRIVATE_PERSONA_MARKER/);assert.match(JSON.stringify(o.messages),/我现在更关心温柔的交流/)
      return [tool('finish_reply',{text:'好，我把刚才那件事核对好了。',expression:'happy'})]
    }
    if(++turns===1)return [{type:'reasoning',text:'PRIVATE_REASONING'},tool('background_research',{objective:'public test',domain:'web',reply:'好，我看看。',expression:'agree'})]
    return say('嗯，我在听。')
  })
  f.services.web={search:async(q,options)=>{started=true;await new Promise(resolve=>{release=resolve});return {sources:[{url:'https://example.org/test',title:'测试资料',snippet:'EVIDENCE_ONLY'}]}}}
  await f.send('帮我核对公开资料');await until(()=>started)
  let snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.backgroundPhase,'searching');assert.equal(snapshot.jobs.at(-1).status,'done')
  await f.send('我现在更关心温柔的交流')
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.at(-1).text,'嗯，我在听。')
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_REASONING|backgroundResearch|objective|WORKER_FINDING_ONLY|EVIDENCE_ONLY/)
  release()
  await until(async()=> (await f.call('snapshot',{chatId:f.chat.id})).messages.some(m=>m.text==='好，我把刚才那件事核对好了。'),'result delivery')
  await f.host.engine.research.pump();await f.host.engine.research.pump()
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.filter(m=>m.text==='好，我把刚才那件事核对好了。').length,1)
  assert.equal(snapshot.presentationEvents.at(-1).expression,'happy')
  assert.equal((await f.host.command({action:'extension',token:f.token,request:{action:'monitorSnapshot'}})).ok,false)
  assert.equal((await f.host.command({action:'extension',token:'a'.repeat(64),request:{action:'monitorMode',enabled:true}})).ok,false)
})

test('installed bili tool can run hidden research without a general web service and preserves foreground conversation',async t=>{
  let turns=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      assert.deepEqual(o.tools.map(t=>t.name),['read_bilibili_video','read_bilibili_images','discover_dsh_tools'])
      return o.messages.some(m=>m.role==='tool')?say('BILI_PRIVATE_FINDING'):[tool('read_bilibili_video',{bv:'BV1xx411c7mD'})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]'))return say('这个视频的内容已核对。')
    if(++turns===1)return [tool('background_research',{objective:'读取 BV1xx411c7mD',domain:'web',reply:'我看看这个视频。'})]
    return say('嗯，先聊你现在说的。')
  })
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{assert.equal(request.name,'bili_watch');started=true;await new Promise(r=>{release=r});return {content:[{type:'text',text:'BILI_PRIVATE_EVIDENCE'}]}}}
  await f.send('看看 BV1xx411c7mD');await until(()=>started)
  await f.send('我想先聊别的')
  let snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(snapshot.messages.at(-1).text,'嗯，先聊你现在说的。');assert.doesNotMatch(JSON.stringify(snapshot),/BILI_PRIVATE/)
  release();await until(async()=>(await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  const state=await f.host.vault.read();assert.match(state.catalog.backgroundResearch[0].result.sources[0].url,/bilibili.com\/video\/BV1xx411c7mD/)
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.at(-1).text,'这个视频的内容已核对。');assert.doesNotMatch(JSON.stringify(snapshot),/BILI_PRIVATE/)
})

test('updated task discards old results; cancelling prevents late delivery and cross-chat control',async t=>{
  let taskId,turn=0,release,started=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return [tool('web_search',{query:'old query'})]
    if(++turn===1)return [tool('background_research',{objective:'old objective',domain:'web'})]
    return say('好。')
  })
  f.services.web={search:async()=>{started=true;await new Promise(r=>{release=r});return {sources:[{url:'https://example.org/old',title:'OLD',snippet:'OLD'}]}}}
  await f.send('请查公开资料');await until(()=>started)
  taskId=(await f.host.vault.read()).catalog.backgroundResearch[0].id
  const job={id:randomUUID(),userId:randomUUID(),chatId:f.chat.id}
  await assert.rejects(f.host.engine.research.tool('cancel_research',{taskId},{...job,chatId:randomUUID()},'x'))
  await f.host.engine.research.tool('update_research',{taskId,objective:'new objective'},job,'update')
  await f.host.engine.research.tool('cancel_research',{taskId},job,'cancel')
  release();await Promise.allSettled([...f.host.engine.research.runs.values()].map(r=>r.promise))
  await f.host.engine.research.pump()
  const state=await f.host.vault.read(),task=state.catalog.backgroundResearch[0]
  assert.equal(task.status,'cancelled');assert.equal(task.objective,'new objective');assert.equal(task.result,null)
  assert.equal((await f.call('snapshot',{chatId:f.chat.id})).messages.length,2)
})

test('tool budget exhaustion keeps evidence; failed worker finalization never blocks foreground or executes non-read tools',async t=>{
  let rounds=0,searches=0,deliveredEvidence=false
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      rounds++
      if(!o.tools.length)return [tool('delegate_workspace_task',{quote:'must not execute'})]
      return [tool('web_search',{query:'query '+rounds})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){deliveredEvidence=JSON.stringify(o.messages).includes('EVIDENCE_RETAINED');return say('[dot-reply:uncertain]\n已经找到一部分依据，其他部分还不能确认。')}
    return [tool('background_research',{objective:'核对公开信息',domain:'web'})]
  })
  f.services.web={search:async()=>{searches++;return {sources:[{url:'https://example.org/evidence',title:'EVIDENCE_RETAINED'}]}}}
  await f.send('查询资料')
  await until(async()=> (await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  assert.equal(searches,6);assert.equal(rounds,7);assert.equal(deliveredEvidence,true)
  const s=await f.call('snapshot',{chatId:f.chat.id});assert.equal(s.messages.at(-1).presentation.expression,'uncertain');assert.doesNotMatch(JSON.stringify(s),/must not execute|internalSteps|这次没能整理/)
})

test('persisted ready result resumes once, stays in originating chat, and locking stops the coordinator',async t=>{
  const f=await fixture(t,o=>o.system.includes('[BACKGROUND_RESULT_DELIVERY]')?say('这是原聊天的查询结果。'):say('好。'))
  const other=await f.call('createChat'),id=randomUUID()
  await f.host.vault.transaction(s=>s.catalog.backgroundResearch=[{id,chatId:f.chat.id,userId:randomUUID(),objective:'公开合成资料',domain:'web',status:'ready',revision:1,createdAt:Date.now(),pid:-1,runtimeId:'old',result:{status:'partial',findings:'合成证据',sources:[],evidence:[]}}])
  await f.host.engine.research.stop();await f.host.engine.research.start()
  await until(async()=> (await f.host.vault.read()).catalog.backgroundResearch[0].status==='delivered')
  assert.equal((await f.call('snapshot',{chatId:other.id})).messages.length,0)
  await f.host.engine.research.stop();await f.host.engine.research.start();await f.host.engine.research.pump()
  assert.equal((await f.call('snapshot',{chatId:f.chat.id})).messages.length,1)
  assert.equal((await f.host.command({action:'extension',token:f.token,request:{action:'monitorSnapshot'}})).ok,false)
  await f.call('lock');assert.equal(f.host.engine,null)
})

test('new user input preempts result synthesis and resumes with the updated conversation',async t=>{
  let delivering=false,syntheses=0,turns=0
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return say('资料已核对。')
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      if(++syntheses===1){delivering=true;await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));return say('STALE_RESULT')}
      assert.match(JSON.stringify(o.messages),/只要一句话/);return say('一句话的结果。')
    }
    if(++turns===1)return [tool('background_research',{objective:'测试',domain:'memory'})]
    return say('好，简短说。')
  })
  await f.send('查一下以前的事情');await until(()=>delivering)
  await f.send('只要一句话')
  await until(async()=> (await f.call('snapshot',{chatId:f.chat.id})).messages.some(m=>m.text==='一句话的结果。'))
  const s=await f.call('snapshot',{chatId:f.chat.id});assert.doesNotMatch(JSON.stringify(s.messages),/STALE_RESULT/)
  assert.equal(s.messages.at(-2).text,'好，简短说。');assert.equal(s.messages.at(-1).text,'一句话的结果。')
})

test('bili frame files become encrypted attachments that the main model actually sees and sends after hidden research',async t=>{
  const bv='BV1xx411c7mD';let delivery=0,imageId,inspected=false,attachments,ref
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){
      assert.ok(!o.tools.some(t=>t.name==='send_chat_image'))
      return o.messages.some(m=>m.role==='tool')?say('已取得画面，具体内容由主代理查看。'):[tool('read_bilibili_images',{bv,indices:[2]})]
    }
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      for(const name of ['send_chat_image','present_visual'])assert.ok(o.tools.some(t=>t.name===name))
      assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
      assert.ok(o.messages.filter(m=>m.role==='assistant').every(m=>m.content.length>0),'empty model output must not create an invalid empty assistant turn')
      const evidence=JSON.parse(o.messages.flatMap(m=>m.content).find(b=>b.text?.startsWith('后台证据资料')).text.split('\n').slice(1).join('\n'))
      imageId=evidence.assets[0].id
      const image=o.messages.flatMap(m=>m.content).find(b=>b.type==='image');assert.ok(image);ref=image.attachment
      assert.ok((await attachments.readImage(ref)).data.length);inspected=true
      if(++delivery===1)return []
      if(delivery<=3)return [tool('send_chat_image',{id:imageId})]
      return [tool('finish_reply',{text:'第二张画面发给你了，来源没有给出精确时间。',expression:'happy'})]
    }
    return [tool('background_research',{objective:'把 '+bv+' 的第二张画面发给我',domain:'web',reply:'我去看一下画面。'})]
  },{vision:true})
  const ctx=new Context();await ctx.plugin(LocalAttachments,{dshHome:path.join(f.root,'attachments')});attachments=ctx.attachments
  let bridge;await ctx.inject(['attachments'],child=>{bridge=attachFrameInput(child.attachments);return()=>bridge.dispose()})
  f.services.frameInput=bridge;t.after(async()=>{bridge.dispose();await ctx.fiber.dispose()})
  const cache=path.join(f.root,'plugin-cache'),dir=path.join(cache,'frames',bv+'-p1-30s'),names=[1,2,3].map(i=>bv+'-0'+i+'.jpg')
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(cache,'.bili-watch-root'),'dsh-bili-watch')
  for(const name of names)await fs.writeFile(path.join(dir,name),await sharp({create:{width:120,height:80,channels:3,background:'#e4b477'}}).jpeg().toBuffer())
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({ok:true,bv,p:1,step:30,files:names,times:null}))
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{assert.equal(request.name,'bili_watch');assert.equal(request.arguments.command,'frames');assert.equal(request.arguments.indices,undefined);return {content:[{type:'text',text:'抽帧 '+bv+'\n目录: '+dir+'\n视频: hidden-source.mp4'}]}}}
  await f.send('请直接把视频的第二张图片发过来')
  await until(async()=>{if(f.errors.length)throw f.errors[0];return (await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered'},'image delivery')
  const state=await f.host.vault.read(),asset=state.catalog.backgroundResearch[0].result.assets[0],snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(inspected,true);assert.equal(asset.index,2);assert.equal(asset.time,undefined)
  const images=snapshot.messages.filter(m=>m.attachments?.some(file=>file.id===imageId));assert.equal(images.length,1,'repeat delivery calls must not duplicate the bubble')
  assert.equal(images[0].presentation.artifactOnly,true);assert.equal(snapshot.messages.at(-1).presentation.expression,'happy')
  assert.doesNotMatch(JSON.stringify(snapshot),/plugin-cache|hidden-source|read_bilibili_images|send_chat_image|BACKGROUND_RESULT_DELIVERY/)
  const raw=await fs.readFile(path.join(f.host.vault.root,'files',imageId+f.host.vault.ext()),'utf8');assert.ok(!raw.includes('/9j/'))
  await assert.rejects(()=>attachments.readImage(ref),'the model frame lease ends after the call')
})

test('a visible capture tool queues deterministic plugin extraction, keeps chat free, and delivers from the reusable local library',async t=>{
  let foreground=0,delivery=0,started=false,release,asset
  const bv='BV1xx411c7mD',f=await fixture(t,async o=>{
    assert.ok(!o.system.includes('[ORIVII_RESEARCH]'),'a typed capture request uses no hidden planning model call')
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      if(++delivery===1)return [tool('list_chat_files',{query:bv,kind:'image'})]
      const value=JSON.parse(o.messages.filter(m=>m.role==='tool').at(-1).content[0].text)
      if(delivery===2){asset=value.files[0];return [tool('send_chat_image',{id:asset.id})]}
      return [tool('finish_reply',{text:'这张真实画面给你啦。',expression:'happy'})]
    }
    assert.match(o.system,/present_visual/);assert.ok(!o.tools.some(t=>t.name==='create_chat_file'));assert.ok(o.tools.some(t=>t.name==='capture_bilibili_frame'))
    return ++foreground===1?[tool('capture_bilibili_frame',{bv,indices:[1],analyze:true})]:say('嗯，先聊你刚说的。')
  })
  const image=await sharp({create:{width:48,height:32,channels:3,background:'#c6b6df'}}).png().toBuffer()
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{assert.equal(request.arguments.command,'frames');started=true;await new Promise(resolve=>{release=resolve});return {content:[{type:'image',data:image.toString('base64'),mimeType:'image/png'}]}}}
  await f.send('截取这个 B站视频画面');await until(()=>started)
  let snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.jobs.at(-1).status,'done');assert.equal(snapshot.backgroundPhase,'searching')
  await f.send('先聊别的');assert.equal((await f.call('snapshot',{chatId:f.chat.id})).messages.at(-1).text,'嗯，先聊你刚说的。')
  release();await until(async()=>{if(f.errors.length)throw f.errors[0];return (await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered'})
  snapshot=await f.call('snapshot',{chatId:f.chat.id});assert.equal(snapshot.messages.at(-1).text,'这张真实画面给你啦。')
  assert.equal(asset.source.bv,bv);assert.equal(snapshot.messages.filter(m=>m.attachments?.some(file=>file.id===asset.id)).length,1)
  const count=(await f.host.engine.files.list({kind:'image'})).total
  const imported=await importBiliImages(f.host.engine.files,{content:[{type:'image',data:image.toString('base64'),mimeType:'image/png'}]},{bv})
  assert.equal(imported.images[0].id,asset.id);assert.equal((await f.host.engine.files.list({kind:'image'})).total,count)
  const {ChatFiles}=await import('../src/chat-files.js'),reopened=new ChatFiles(f.host.vault)
  assert.equal((await reopened.list({query:bv,kind:'image'})).files[0].id,asset.id,'library survives a new file manager instance')
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/capture_bilibili_frame|list_chat_files|sourceKey|digest/)
})

test('plain captures deliver the image once without a second planning or vision model request',async t=>{
  let calls=0,pluginCalls=0
  const f=await fixture(t,o=>{calls++;assert.ok(!o.system.includes('[ORIVII_RESEARCH]')&&!o.system.includes('[BACKGROUND_RESULT_DELIVERY]'));return [tool('capture_bilibili_frame',{bv:'BV1xx411c7mD'})]})
  const image=await sharp({create:{width:32,height:32,channels:3,background:'gold'}}).png().toBuffer()
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{pluginCalls++;assert.equal(request.arguments.command,'peek');return {content:[{type:'image',data:image.toString('base64'),mimeType:'image/png'}]}}}
  await f.send('直接把截图发来')
  await until(async()=>{if(f.errors.length)throw f.errors[0];return (await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered'})
  await f.host.engine.research.pump();await f.host.engine.research.pump()
  const snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(calls,1);assert.equal(pluginCalls,1);assert.equal(snapshot.messages.filter(message=>message.attachments?.length).length,1)
  assert.equal(snapshot.messages.at(-1).presentation.artifactOnly,true);assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/ORIVII_RESEARCH|BACKGROUND_RESULT_DELIVERY|capture_bilibili_frame/)
})

test('warm image requests bypass plugin execution and respect page, interval, mode and selected indices',async t=>{
  const f=await fixture(t,()=>say('好。')),files=f.host.engine.files,bv='BV1xx411c7mD'
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'green'}}).png().toBuffer()
  const make=(index,variant)=>files.cacheImage(bv+'-'+index+'.png',bytes,'image/png',{kind:'bilibili-frame',bv,p:1,index,variant})
  const one=await make(1,bv+'-p1-30s'),seven=await make(7,bv+'-p1-30s')
  await make(2,bv+'-p1-shots')
  let pluginCalls=0,mode
  const services={tools:{get:name=>name==='bili_watch',execute:async request=>{pluginCalls++;mode=request.arguments.command;return {content:[]}}}}
  const options={cacheImages:(args,signal)=>cachedBiliImages(files,args,signal),captureImages:async()=>({images:[],frameCount:0})}
  const cached=await executeBiliTool(services,'read_bilibili_images',{bv,step:30,indices:[7]},undefined,options)
  assert.equal(pluginCalls,0);assert.equal(cached.cached,true);assert.equal(cached.images[0].id,seven.file.id);assert.equal(cached.timings.pluginMs,0);assert.equal(cached.frameCountScope,'saved-selection')
  await executeBiliTool(services,'read_bilibili_images',{bv,step:30,indices:[1]},undefined,options);assert.equal(pluginCalls,0)
  await executeBiliTool(services,'read_bilibili_images',{bv,step:15},undefined,options);assert.equal(pluginCalls,1);assert.equal(mode,'frames')
  await executeBiliTool(services,'read_bilibili_images',{bv,p:2},undefined,options);assert.equal(pluginCalls,2);assert.equal(mode,'peek')
  await executeBiliTool(services,'read_bilibili_images',{bv,step:30,indices:[2]},undefined,options);assert.equal(pluginCalls,3,'a preview with index 2 cannot replace an original-video frame from the 30s series')
  await make(12,'tool-image')
  await executeBiliTool(services,'read_bilibili_images',{bv,mode:'frames',indices:[12]},undefined,options);assert.equal(pluginCalls,4,'a native image block with unknown sampling quality cannot replace a requested original-video frame')
  assert.equal((await files.resolve([one.file.id]))[0].source.p,1)
  await assert.rejects(()=>executeBiliTool(services,'read_bilibili_images',{bv},undefined,{...options,companionActive:true}),/当前画面/)
})

test('owner frame diagnostics use the registered tool and local library without inserting messages',async t=>{
  const f=await fixture(t,()=>say('一张蓝色的测试画面。'))
  const image=await sharp({create:{width:48,height:32,channels:3,background:'blue'}}).png().toBuffer()
  f.services.tools={get:name=>name==='bili_watch',execute:async request=>{assert.equal(request.arguments.command,'frames');assert.equal(request.arguments.step,30);return {content:[{type:'image',data:image.toString('base64'),mimeType:'image/png'}]}}}
  const before=(await f.host.vault.read()).catalog.messages.length
  const result=await f.call('modelProbe',{videoId:'BV1xx411c7mD',videoImages:true})
  assert.equal(result.videoFramesCheck.ok,true);assert.equal(result.videoFramesCheck.librarySaved,true);assert.equal(result.chatWritten,false)
  assert.equal((await f.host.vault.read()).catalog.messages.length,before)
  assert.equal((await f.host.engine.files.list({kind:'image'})).files[0].id,result.videoFramesCheck.images[0].id)
})

test('frame imports verify video ownership, reject escaped files and avoid inventing precise times',async t=>{
  const f=await fixture(t,()=>say('好。')),files=f.host.engine.files,bv='BV1xx411c7mD',cache=path.join(f.root,'cache'),dir=path.join(cache,'frames',bv+'-p1-shots'),name=bv+'-01.jpg'
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(cache,'.bili-watch-root'),'owned')
  const jpg=await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).jpeg().toBuffer(),manifest=path.join(dir,'manifest.json')
  await fs.writeFile(path.join(dir,name),jpg);await fs.writeFile(manifest,JSON.stringify({bv,p:1,files:[name],times:[18],source:'videoshot'}))
  const result={content:[{type:'text',text:'5 帧（复用）: '+dir}]},args={bv,p:1}
  const first=await importBiliImages(files,result,args);assert.equal(first.images[0].time,18);assert.equal(first.images[0].timeAccuracy,'preview-estimate')
  await assert.rejects(()=>importBiliImages(files,result,args,undefined,{indices:[2]}),/现有/)
  await fs.writeFile(manifest,JSON.stringify({bv:'BV1yy411c7mD',p:1,files:[name]}))
  await assert.rejects(()=>importBiliImages(files,result,args),/来源校验/)
  await fs.writeFile(manifest,JSON.stringify({bv,p:1,files:[name]}))
  await fs.unlink(path.join(dir,name));const outside=path.join(f.root,'unrelated.jpg');await fs.writeFile(outside,jpg);await fs.symlink(outside,path.join(dir,name))
  await assert.rejects(()=>importBiliImages(files,result,args),/超出/)
  await fs.unlink(path.join(dir,name));await fs.writeFile(path.join(dir,name),jpg)
  const second=bv+'-02.jpg';await fs.writeFile(path.join(dir,second),'broken-image');await fs.writeFile(manifest,JSON.stringify({bv,p:1,files:[name,second]}))
  const count=(await f.host.vault.read()).catalog.files.length
  await assert.rejects(()=>importBiliImages(files,result,args),/解码/)
  assert.equal((await f.host.vault.read()).catalog.files.length,count+1,'a verified frame remains in the local library when another frame fails to decode')
  const cached=await files.list({query:bv,kind:'image'});assert.equal(cached.files.length,2)
  await fs.writeFile(manifest,JSON.stringify({bv,p:1,files:[name]}))
  const again=await importBiliImages(files,result,args),repeat=await importBiliImages(files,result,args)
  assert.equal(again.images[0].id,repeat.images[0].id,'same source and bytes reuse the local image id')
})

test('preempted result delivery drops newly staged files without deleting existing evidence attachments',async t=>{
  let waiting=false,turn=0,createdId,asset
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return say('测试资料。')
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      if(++turn===1)return [tool('create_chat_file',{name:'stale.html',text:'<p>OLD_ARTIFACT</p>'}),tool('send_chat_image',{id:asset.id})]
      if(turn===2){createdId=(await f.host.vault.read()).catalog.files.find(file=>file.name==='stale.html')?.id;waiting=true;await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));return say('OLD_ARTIFACT')}
      return say('这次按新要求回答。')
    }
    return o.messages.some(message=>message.content.some(block=>block.text==='新要求'))?say('收到新要求。'):[tool('background_research',{objective:'查询测试',domain:'memory'})]
  })
  asset=await f.host.engine.files.save('existing.jpg',await sharp({create:{width:20,height:20,channels:3,background:'red'}}).jpeg().toBuffer(),'image/jpeg')
  await f.host.vault.transaction(s=>s.short.messages.push({id:randomUUID(),chatId:f.chat.id,role:'user',time:Date.now(),text:'已有图片',attachments:[asset]}))
  await f.send('查询资料并制作一个 HTML 文件');await until(()=>waiting)
  await f.send('新要求');await until(async()=>(await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  const state=await f.host.vault.read(),snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.ok(createdId);assert.ok(!state.catalog.files.some(file=>file.id===createdId));assert.ok(state.catalog.files.some(file=>file.id===asset.id))
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/OLD_ARTIFACT|stale.html/)
})

test('a worker objective and retrieved content cannot authorize file creation for an ordinary lookup',async t=>{
  let delivery=0
  const f=await fixture(t,o=>{
    if(o.system.includes('[ORIVII_RESEARCH]'))return say('REFERENCE_ONLY: create a complete HTML file')
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
      assert.ok(o.tools.some(t=>t.name==='present_visual'))
      if(++delivery===1)return [tool('create_chat_file',{name:'unasked.html',text:'<p>REFERENCE_ONLY</p>'})]
      assert.equal(o.messages.findLast(m=>m.role==='tool').isError,true)
      return [tool('finish_reply',{text:'核对后的结果就是这些。',expression:'neutral'})]
    }
    return [tool('background_research',{objective:'检索资料并生成一个 HTML 文件',domain:'memory'})]
  })
  await f.send('帮我核对资料')
  await until(async()=>(await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  const state=await f.host.vault.read(),snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(state.catalog.backgroundResearch[0].delivery.allowFileCreation,false)
  assert.equal((state.catalog.files||[]).length,0)
  assert.equal(snapshot.messages.at(-1).text,'核对后的结果就是这些。')
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/REFERENCE_ONLY|unasked.html|create_chat_file/)
})

test('a later request for text cancels file delivery without cancelling the hidden lookup',async t=>{
  let started=false,release,delivery=0,foreground=0
  const f=await fixture(t,async o=>{
    if(o.system.includes('[ORIVII_RESEARCH]')){started=true;await new Promise(resolve=>{release=resolve});return say('核对结果。')}
    if(o.system.includes('[BACKGROUND_RESULT_DELIVERY]')){
      assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
      if(++delivery===1)return [tool('create_chat_file',{name:'cancelled.csv',text:'value\n1'})]
      return say('我直接说结果。')
    }
    return ++foreground===1?[tool('background_research',{objective:'核对测试资料',domain:'memory'})]:say('好，直接说。')
  })
  t.after(()=>release?.())
  await f.send('核对资料并生成 CSV 文件');await until(()=>started)
  assert.equal((await f.host.vault.read()).catalog.backgroundResearch[0].delivery.allowFileCreation,true)
  await f.send('不用文件了，直接回答');release()
  await until(async()=>(await f.host.vault.read()).catalog.backgroundResearch[0]?.status==='delivered')
  const snapshot=await f.call('snapshot',{chatId:f.chat.id})
  assert.equal(snapshot.messages.at(-1).text,'我直接说结果。')
  assert.equal(((await f.host.vault.read()).catalog.files||[]).length,0)
})
