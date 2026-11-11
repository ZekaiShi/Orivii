import {randomUUID} from 'node:crypto'
import {DotError} from './vault.js'
import {rememberProfile,profileOf} from './profile.js'
import {rememberLearned,recallLearned,learnedEntries,learnedText,relevance} from './recall.js'
import {webTools,searchWeb,readWeb} from './web.js'
import {dotExpression,expressionParameter,cleanReply} from './expression.js'
import {visibleReply} from './reply.js'
import {responseText,responseBubble} from './response-policy.js'
import {ChatFiles,CHAT_FILE_TOOLS,generatedFile} from './chat-files.js'
import {deliveryPolicy} from './delivery-policy.js'
import {readBili,biliAvailable,availableBiliTools,executeBiliTool,checkBiliConnection,biliConnectionTools,biliCaptureTool,biliFrameRequest} from './bili.js'
import {capabilityTools,discoverTools,capabilityContext} from './capabilities.js'
import {modelFailure} from './model-diagnostics.js'
import {VISUAL_TOOLS,validateVisualSpec,visualSummary,visualPrompt,filePreviewKind} from './visual.js'
import {importBiliImages,cachedBiliImages} from './bili-images.js'
import {CONTINUITY_PROMPT,continuityOf,applyContinuityAnalysis} from './continuity.js'
import {appendBubble, buildContext, tokens, searchArchive, readSources, ANALYSIS_PROMPT, parseAnalysis, ageMedium, rebalance} from './memory.js'

const memoryTools=[
  {name:'reply_to_user',description:'发送自然的阶段回应，然后继续办事。同一轮最多4次；首次可先回应再检索，之后仅在有新发现或需要解释变化时回应，不重复报进度。每次独立选择 expression。只写给用户看的话，不写内部计划、参数或未经核实的回忆。',parameters:{type:'object',properties:{text:{type:'string',maxLength:500},expression:expressionParameter},required:['text','expression'],additionalProperties:false}},
  {name:'finish_reply',description:'向用户发送最终回复并结束本轮。text 是完整 Markdown 正文，expression 选择本条回复的实际语气。必须单独调用，不与搜索或其他工具并行；不再另写重复正文。',parameters:{type:'object',properties:{text:{type:'string',maxLength:100000},expression:expressionParameter},required:['text','expression'],additionalProperties:false}},
  {name:'memory_search',description:'搜索所有 Orivii 聊天原始气泡，返回真实出处和节选。使用明确人名、事件或关键词。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
  {name:'memory_read',description:'根据消息编号读取真实原文，核实摘要与检索结果。',parameters:{type:'object',properties:{ids:{type:'array',items:{type:'string'},maxItems:20}},required:['ids'],additionalProperties:false}},
]
// Reasoning is confined to the live tool loop, never archived or sent to the UI.
export async function collect(stream,signal,onText=()=>{},onChunk=()=>{}) {
  const blocks=new Map(),deltas=new Map();let finish,replayState
  for await(const chunk of stream) {
    if(signal?.aborted)throw new DotError('已停止当前回复。','cancelled')
    onChunk(chunk)
    if(chunk.type==='text-delta') {deltas.set(chunk.index,(deltas.get(chunk.index)||'')+chunk.text);onText([...deltas.values()].join('\n'))}
    if(chunk.type==='block-end')blocks.set(chunk.index,chunk.block)
    if(chunk.type==='finish'){finish=chunk.reason;replayState=chunk.replayState}
  }
  if(!finish)throw new DotError('模型连接中断，尚未收到完整回复。','model')
  if(finish.kind==='error'||finish.kind==='aborted') {
    const code=/^[A-Z_]{1,40}$/.test(finish.failure?.code||'')?finish.failure.code:'MODEL_ERROR'
    const error=new DotError(`模型请求未完成（${code}）。请稍后重试；持续出现时可检查模型连接。`,'model')
    error.diagnostic=modelFailure(finish.failure);throw error
  }
  for(const [index,text] of deltas)if(!blocks.has(index))blocks.set(index,{type:'text',text})
  const content=[...blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,block])=>block)
  return {content,text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),calls:content.filter(b=>b.type==='tool-call'),finish,...(replayState?{replayState}:{})}
}
export class DotEngine {
  constructor(vault,services) {
    this.files=new ChatFiles(vault)
    this.vault=vault;this.services=services;this.jobs=new Map();this.partial=new Map();this.deliveryRevision=0;this.maintenance=Promise.resolve();this.queueTimer=null;this.pumpingQueue=false;this.cancelling=false
    this.presentationEvents=new Map();this.presentationSequence=0;this.observations=new Map();this.developerEnabled=false
    this.extension=services.extension?.createExtension({vault,services,appendBubble,selection:state=>this.selection(state),isForegroundBusy:()=>[...this.jobs.values()].some(j=>['queued','running'].includes(j.job.status)),complete:async({state,system,input,maxTokens,signal})=>{
      const call=await this.prepare(state,signal,maxTokens)
      if(tokens(system)+tokens(input)+maxTokens>call.context?.contextWindow)throw new DotError('后台请求超出模型容量。','capacity')
      return (await collect(call.stream({...call.config,system,messages:[{role:'user',content:[{type:'text',text:input}]}],signal,purpose:'compaction'}),signal)).text
    }})||null
    this.vault.responsePolicy=this.extension?.createResponsePolicy?.()||null
    this.delivering=false;this.accepting=0;this.acceptance=Promise.resolve();this.stopped=false;this.lifecycle=new AbortController()
    this.research=this.extension?.createResearch?.({vault,services,collect,webTools,webAvailable:()=>Boolean(services.web)||biliAvailable(services),availableWebTools:()=>[...(services.web?webTools:[]),...availableBiliTools(services,{companionActive:Boolean(this.media?.active)}),...capabilityTools],memoryTools:memoryTools.filter(t=>t.name.startsWith('memory_')),prepare:(s,signal,max)=>this.prepare(s,signal,max),deliverReady:()=>this.deliverResearch(),lookup:async(name,args,state,signal)=>{
      if(signal.aborted)throw new DotError('已取消。','cancelled')
      if(name==='discover_dsh_tools')return discoverTools(services,args,{directNames:availableBiliTools(services,{companionActive:Boolean(this.media?.active)}).map(t=>t.name)})
      if(availableBiliTools(services).some(t=>t.name===name)&&name!=='read_bilibili_video'){if(state.catalog.settings.webSearch===false)throw new DotError('联网已关闭。');return executeBiliTool(services,name,args,signal,{companionActive:Boolean(this.media?.active),cacheImages:(request,activeSignal)=>cachedBiliImages(this.files,request,activeSignal),captureImages:(result,request,options)=>importBiliImages(this.files,result,request,signal,options)})}
      if(name==='read_bilibili_video'){if(state.catalog.settings.webSearch===false)throw new DotError('联网已关闭。');return readBili(services,args,signal,{companionActive:Boolean(this.media?.active)})}
      if(name==='web_search'||name==='web_read'){
        if(state.catalog.settings.webSearch===false)throw new DotError('联网已关闭。')
        return name==='web_search'?searchWeb(services.web,args.query,signal):readWeb(services.web,args.url,signal)
      }
      if(name==='memory_search')return [...(this.extension?.search(state,args.query)||[]),...recallLearned(state,args.query,5).map(e=>({text:learnedText(e),sourceIds:e.sourceIds,status:e.status})),...await searchArchive(vault,state,args.query,8)]
      if(name==='memory_read')return readSources(vault,state,args.ids,8000)
      throw new DotError('查询工具不可用。')
    }})||null
  }
  progress(chatId) {
    const jobs=[...this.jobs.values()].filter(({job})=>job.chatId===chatId&&['queued','running'].includes(job.status))
    return {chatId,partial:this.partial.get(chatId)||null,backgroundPhase:jobs.some(({job})=>job.kind==='continuation')?'responding':this.research?.phase(chatId)||null,presentationEvents:this.presentationEvents.get(chatId)||[],revision:this.deliveryRevision,running:jobs.length>0}
  }
  async prepareVisibleReply(text,signal){
    const clean=cleanReply(text).text,policy=this.vault.responsePolicy
    if(signal?.aborted)throw new DotError('已停止当前回复。','cancelled')
    // Model-assisted editing must happen outside the vault transaction so a
    // slow provider cannot prevent another user message from being accepted.
    const revised=policy?.revise?await policy.revise(clean,{state:await this.vault.read(),signal}):clean
    if(signal?.aborted||this.stopped)throw new DotError('已停止当前回复。','cancelled')
    return responseText(this.vault,revised)
  }
  present(job,messageId,expression){
    const events=this.presentationEvents.get(job.chatId)||[]
    if(events.some(e=>e.messageId===messageId))return
    events.push({id:++this.presentationSequence,jobId:job.id,messageId,expression:dotExpression(expression),time:Date.now()})
    this.presentationEvents.set(job.chatId,events.slice(-32))
    if(this.presentationEvents.size>16)this.presentationEvents.delete(this.presentationEvents.keys().next().value)
  }
  observe(job,patch){
    if(!this.developerEnabled)return
    this.observations.set(job.chatId,{...this.observations.get(job.chatId),...structuredClone(patch)})
    if(this.observations.size>16)this.observations.delete(this.observations.keys().next().value)
  }
  inspectedState(state){return {profile:structuredClone(profileOf(state)),companion:this.extension?.inspect?.(state)||null,knowledgeCount:(state.permanent.knowledge||[]).filter(e=>e.enabled!==false&&e.status==='active').length,memeCount:(state.permanent.memes||[]).filter(e=>e.enabled!==false&&e.status==='active').length}}
  setDeveloper(enabled){this.developerEnabled=enabled;if(!enabled)this.observations.clear()}
  selection(state) {
    const s=state.catalog.settings
    return s.provider&&s.model ? {provider:s.provider,model:s.model} : this.services.defaultModel.currentSelection()
  }
  async prepare(state,signal,maxTokens=8192) {
    return this.services.llm.prepareCall({...this.selection(state),maxTokens},signal)
  }
  async deliveryFor(state,job,task){
    let messages=state.short.messages
    if(!messages.some(m=>m.id===job.userId&&m.role==='user')){
      const original=await this.vault.message(job.userId).catch(()=>null)
      if(original?.role==='user'&&original.chatId===job.chatId)messages=[original,...messages]
    }
    return deliveryPolicy(messages,{chatId:job.chatId,userId:job.userId,background:Boolean(task),initial:task?.delivery})
  }
  requestTools(state,delivery={allowFileCreation:false}){
    const online=(Boolean(this.services.web)||biliAvailable(this.services))&&state.catalog.settings.webSearch!==false
    const mediaTools=this.media?.active?[{name:'observe_current_media',description:'查看正在陪伴窗口中播放的当前画面或可见文字，绝不读取未来剧情。需要查询时先简短回应再调用。',parameters:{type:'object',properties:{},additionalProperties:false}}]:[]
    const extensionTools=this.extension?.tools(state)||[]
    const captureTools=online&&this.research?.capture&&availableBiliTools(this.services,{companionActive:Boolean(this.media?.active)}).some(tool=>tool.name==='read_bilibili_images')?[biliCaptureTool]:[]
    return {online,mediaTools,extensionTools,tools:[...(this.research?memoryTools.filter(t=>!t.name.startsWith('memory_')):memoryTools),...(this.research?this.research.tools():online?[...(this.services.web?webTools:[]),...availableBiliTools(this.services,{companionActive:Boolean(this.media?.active)})]:[]),...captureTools,...CHAT_FILE_TOOLS.filter(t=>delivery.allowFileCreation||t.name!=='create_chat_file'),...VISUAL_TOOLS,...capabilityTools,...biliConnectionTools,...extensionTools,...mediaTools]}
  }
  async preparePresentation(name,args,signal,{networkAllowed=false,delivery}={}){
    signal.throwIfAborted()
    let file,text,artifactOnly=false,created=true
    if(name==='present_visual'){
      if(Object.keys(args).length!==1||!args.spec)throw new DotError('请提供完整的图文卡片。')
      const spec=validateVisualSpec(args.spec),label=(spec.title.replace(/[\x00-\x1f\x7f/\\:]/g,' ').trim()||'图文说明').slice(0,80)
      file=await this.files.save(label+'.orivii.json',Buffer.from(JSON.stringify(spec),'utf8'));text=visualSummary(spec);artifactOnly=true
    }else if(name==='create_chat_file'){
      if(delivery?.allowFileCreation!==true)throw new DotError('当前内容直接用文字回复；需要图示时用 present_visual。','delivery-route')
      file=await this.files.save(args.name,generatedFile(args.name,args.text));text='已生成：'+file.name;artifactOnly=Boolean(filePreviewKind(file))
    }else if(name==='send_chat_image'){
      file=await this.files.outgoingImage(args,{signal,networkAllowed});text=await this.prepareVisibleReply(args.caption?.trim()||'图片',signal);artifactOnly=!args.caption?.trim();created=!args.id
    }else throw new DotError('交付工具无效。')
    if(signal.aborted){if(created)await this.files.discard(file.id).catch(()=>{});signal.throwIfAborted()}
    return {file,text,artifactOnly,created,response:{[name==='send_chat_image'?'sent':name==='present_visual'?'presented':'created']:true,file}}
  }
  async probeModel(signal,{roundtrip=false,videoId,videoImages=false,videoCache=true,videoAnalyze=true}={}){
    if(this.isForegroundBusy()||this.accepting)throw new DotError('请等当前回复结束后再检测模型。','busy')
    const state=await this.vault.read(),{tools}=this.requestTools(state,{allowFileCreation:true}),results=[]
    if(videoImages){
      if(!videoId||state.catalog.settings.webSearch===false)throw new DotError('请提供视频编号并开启联网。')
      const start=Date.now(),result=await executeBiliTool(this.services,'read_bilibili_images',{bv:videoId,step:30},signal,{companionActive:Boolean(this.media?.active),...(videoCache?{cacheImages:(request,activeSignal)=>cachedBiliImages(this.files,request,activeSignal)}:{}),captureImages:(value,args,options)=>importBiliImages(this.files,value,args,signal,options)}),extractionMs=Date.now()-start
      const files=(result.images||[]).slice(0,4),call=await this.prepare(state,signal,2048),imageInputDeclared=Boolean(call.inputModalities?.includes('image')),imageBridgeReady=Boolean(this.services.frameInput);let vision=false,description='',imageDeliveredToModel=false,finishReason
      const modelStarted=Date.now()
      if(videoAnalyze&&files.length&&call.inputModalities?.includes('image')&&this.services.frameInput){
        await this.files.withImages(files,this.services.frameInput,signal,async images=>{
          imageDeliveredToModel=images.length===files.length
          const response=await collect(call.stream({...call.config,system:'用一句中文描述提供的视频画面。仅根据当前图片回答。',messages:[{role:'user',content:[{type:'text',text:'请描述这几张实际画面。'},...images]}],tools:[],signal}),signal)
          finishReason=response.finish.kind
          vision=images.length===files.length&&Boolean(response.text.trim());description=cleanReply(response.text).text.slice(0,500)
        })
      }
      return {videoFramesCheck:{ok:files.length>0,frameCount:result.frameCount,frameCountScope:result.frameCountScope||'plugin-result',images:files,librarySaved:files.length>0,vision,imageInputDeclared,imageBridgeReady,imageDeliveredToModel,finishReason,description,cached:Boolean(result.cached),timings:{...result.timings,extractionMs,modelMs:videoAnalyze?Date.now()-modelStarted:0},elapsedMs:Date.now()-start},chatWritten:false,syntheticPrompt:true}
    }
    for(const shape of ['user','tools','research-tools','assistant-first','assistant-last']){
      const withTools=shape!=='user'
      const call=await this.prepare(state,signal,128),start=Date.now();let finish,blocks=0
      const messages=[{role:'user',content:[{type:'text',text:'Reply OK.'}]}],assistant={id:randomUUID(),role:'assistant',source:{kind:'model',...this.selection(state)},content:[{type:'text',text:'OK.'}]}
      if(shape==='assistant-first')messages.unshift(assistant)
      if(shape==='assistant-last')messages.push(assistant)
      const activeTools=shape==='research-tools'?(this.research?.availableWebTools?.()||[]):withTools?tools:[]
      for await(const chunk of call.stream({...call.config,system:'Connection test. Reply OK without calling tools.',messages,tools:activeTools,signal})){
        signal.throwIfAborted();if(chunk.type==='block-end')blocks++;if(chunk.type==='finish')finish=chunk.reason
      }
      results.push({shape,withTools,ok:Boolean(finish&&!['error','aborted'].includes(finish.kind)),failure:modelFailure(finish?.failure),elapsedMs:Date.now()-start,blocks})
    }
    if(roundtrip){
      const start=Date.now(),tool={name:'orivii_probe_echo',description:'Return OK for this connection test.',parameters:{type:'object',properties:{},additionalProperties:false}},messages=[{role:'user',content:[{type:'text',text:'Call orivii_probe_echo once, then reply OK.'}]}]
      try{
        const call=await this.prepare(state,signal,2048),system='Connection test. Call orivii_probe_echo exactly once before replying OK.',first=await collect(call.stream({...call.config,system,messages,tools:[tool],signal}),signal)
        if(first.calls.length!==1||first.calls[0].name!==tool.name)throw new DotError('模型没有选择本次测试工具。','probe')
        messages.push({id:randomUUID(),role:'assistant',source:{kind:'model',...this.selection(state),...(first.replayState?{replayState:first.replayState}:{})},content:first.content},{role:'tool',toolCallId:first.calls[0].id,content:[{type:'text',text:'OK'}]})
        const next=await this.prepare(state,signal,256),last=await collect(next.stream({...next.config,system,messages,tools:[tool],signal}),signal)
        results.push({shape:'tool-roundtrip',withTools:true,ok:Boolean(last.text)&&!last.calls.length,failure:null,elapsedMs:Date.now()-start,nativeReplayPreserved:Boolean(first.replayState)})
      }catch(e){results.push({shape:'tool-roundtrip',withTools:true,ok:false,failure:e.diagnostic||{code:e.code||'MODEL_ERROR',message:'工具往返测试未完成。'},elapsedMs:Date.now()-start})}
    }
    const latest=state.short.messages.findLast(m=>m.role==='user')
    let contextShape=null
    if(latest){const call=await this.prepare(state,signal,128),context=buildContext(state,latest.chatId,call.context.contextWindow,call.config,{companionContext:this.extension?.context(state,latest.text)});contextShape={firstRole:context.messages[0]?.role,lastRole:context.messages.at(-1)?.role,messages:context.messages.length}}
    let videoCheck
    if(videoId){
      try{
        if(state.catalog.settings.webSearch===false)throw new DotError('联网已关闭。')
        const result=await readBili(this.services,{bv:videoId},signal,{companionActive:Boolean(this.media?.active)})
        let data;try{data=JSON.parse(result.content)}catch{}
        videoCheck={ok:true,videoId,source:data?.source||'plugin-text',textChars:typeof data?.text==='string'?data.text.length:result.content.length,structured:Boolean(data),truncated:result.truncated}
      }catch(e){videoCheck={ok:false,videoId,code:e.code||'bili_read'}}
    }
    return {selection:this.selection(state),toolCount:tools.length,invalidSchemas:tools.filter(t=>!t.parameters||t.parameters.type!=='object').map(t=>t.name),contextShape,results,...(videoCheck?{videoCheck}:{}),syntheticPrompt:true,chatWritten:false}
  }
  isForegroundBusy(){return [...this.jobs.values()].some(e=>['queued','running'].includes(e.job.status))}
  interruptReply(chatId){for(const e of this.jobs.values())if(e.job.chatId===chatId&&e.job.status==='running')e.controller.abort()}
  notifyVisible(message){if(message.presentation?.artifactOnly)return;try{this.voice?.accepted(message)}catch{}}
  async start(chatId,text,requestId,metadata={}) {
    this.accepting++
    const pending=this.acceptance.then(()=>this.startForeground(chatId,text,requestId,metadata))
    this.acceptance=pending.catch(()=>{})
    try{return await pending}finally{this.accepting--;this.research?.kick()}
  }
  async startForeground(chatId,text,requestId,metadata={}) {
    if(typeof text!=='string'||!text.trim()||text.length>16000)throw new DotError('消息长度应为 1–16000 字。')
    if(typeof requestId!=='string'||requestId.length>100)throw new DotError('缺少发送请求编号。')
    for(const entry of this.jobs.values())if(entry.job.kind==='continuation'&&entry.job.status==='running')entry.controller.abort()
    if(this.stopped||this.cancelling)throw new DotError('已停止接收消息，请稍后重试。','locked')
    const controller=new AbortController()
    const before=await this.vault.read()
    const prepared=await this.prepare(before,controller.signal)
    const attachments=await this.files.resolve(metadata.attachments||[])
    const media=await this.media?.context(false)
    let adaptation=null
    const accepted=await this.vault.transaction(async state=>{
      const duplicate=state.catalog.jobs.find(j=>j.requestId===requestId)
      if(duplicate)return {...duplicate,duplicate:true}
      if(this.stopped||this.cancelling)throw new DotError('已停止接收消息。','locked')
      if(metadata.origin==='voice'&&this.voice?.status()?.id!==metadata.callId)throw new DotError('通话已结束。','call')
      const queued=state.catalog.jobs.some(j=>['queued','running','memory'].includes(j.status))
      const preview=structuredClone(state)
      preview.short.messages.push({id:randomUUID(),chatId,role:'user',text,time:Date.now()})
      rebalance(preview)
      buildContext(preview,chatId,prepared.context?.contextWindow,prepared.config,{webAvailable:Boolean(this.services.web)&&preview.catalog.settings.webSearch!==false,companionContext:this.extension?.context(preview,text),workspaceAvailable:Boolean(this.extension?.tools(preview).some(t=>t.name==='delegate_workspace_task'))})
      const message=await appendBubble(this.vault,state,chatId,'user',text,{requestId,...(attachments.length?{attachments}:{}),...(metadata.origin==='voice'?{origin:'voice',callId:metadata.callId}:{}),...(media?.activity?{activity:media.activity}:{})})
      const prior=this.developerEnabled?this.inspectedState(state):null
      const adjusted=this.extension?.beforeReply?.(state,message)
      if(adjusted?.changed&&this.developerEnabled)adaptation={time:Date.now(),before:prior,after:this.inspectedState(state)}
      const job={id:randomUUID(),requestId,chatId,userId:message.id,status:queued?'queued':'running',startedAt:Date.now(),pid:process.pid,...(media?.text?{mediaContext:media.text}:{}),...(this.voice?.status()?{voiceEpoch:this.voice.status().epoch,voiceCallId:this.voice.status().id}:{})}
      state.catalog.jobs=[...state.catalog.jobs.filter(j=>['queued','running','memory'].includes(j.status)),...state.catalog.jobs.filter(j=>!['queued','running','memory'].includes(j.status)).slice(-99)];state.catalog.jobs.push(job)
      return job
    })
    if(accepted.duplicate)return accepted
    this.observe(accepted,{adaptation,request:null,analysis:null})
    let resolve
    const promise=new Promise(done=>{resolve=done}),entry={promise,resolve,controller,job:accepted,prepared}
    this.jobs.set(accepted.id,entry);this.deliveryRevision++
    if(accepted.status==='running')this.launch(entry);else this.kickQueue()
    return accepted
  }
  launch(entry){
    if(entry.launched)return
    entry.launched=true
    const {job,prepared,controller}=entry
    this.partial.set(job.chatId,{text:'',stage:'正在思考…',phase:'responding',jobId:job.id})
    const timeout=setTimeout(()=>controller.abort(),10*60*1000);timeout.unref?.()
    this.run(job,prepared,controller.signal).finally(()=>{
      clearTimeout(timeout);this.jobs.delete(job.id)
      if(this.partial.get(job.chatId)?.jobId===job.id)this.partial.delete(job.chatId)
      entry.resolve();this.deliveryRevision++;this.kickQueue();this.research?.kick()
    }).catch(()=>{})
  }
  kickQueue(delay=0){
    if(this.stopped||this.cancelling||this.queueTimer!==null||![...this.jobs.values()].some(e=>e.job.status==='queued'))return
    this.queueTimer=setTimeout(()=>{this.queueTimer=null;this.pumpQueue().catch(()=>{})},delay);this.queueTimer.unref?.()
  }
  async pumpQueue(){
    if(this.stopped||this.cancelling||this.pumpingQueue)return
    this.pumpingQueue=true
    try{
      const entry=[...this.jobs.values()].find(e=>e.job.status==='queued')
      if(!entry)return
      const claimed=await this.vault.transaction(s=>{
        if(this.stopped||this.cancelling||entry.controller.signal.aborted)return false
        if(s.catalog.jobs.some(j=>['running','memory'].includes(j.status)))return false
        const row=s.catalog.jobs.find(j=>j.id===entry.job.id)
        if(row?.status!=='queued')return false
        row.status='running';row.startedAt=Date.now();return true
      })
      if(claimed&&entry.controller.signal.aborted){
        await this.vault.transaction(s=>{const row=s.catalog.jobs.find(j=>j.id===entry.job.id);if(row){row.status='cancelled';row.finishedAt=Date.now()}})
        entry.job.status='cancelled';this.jobs.delete(entry.job.id);entry.resolve()
      }
      else if(claimed){entry.job.status='running';this.deliveryRevision++;this.launch(entry)}
      else this.kickQueue(250)
    }finally{this.pumpingQueue=false}
  }
  async run(job,prepared,signal) {
    try {
      let state=await this.vault.read()
      // Later accepted messages wait their turn; an earlier reply must not
      // answer them prematurely and then answer the same text again.
      const waiting=new Set(state.catalog.jobs.filter(j=>j.status==='queued').map(j=>j.userId))
      const contextState=structuredClone(state)
      contextState.short.messages=contextState.short.messages.filter(m=>!waiting.has(m.id)).map(m=>responseBubble(this.vault,m))
      contextState.catalog.messages=contextState.catalog.messages.filter(m=>!waiting.has(m.id))
      const delivery=await this.deliveryFor(contextState,job);job.delivery=delivery
      const {online,mediaTools,extensionTools,tools}=this.requestTools(state,delivery),webSources=new Map()
      let connectionShown=false
      const deliverFinal=async(text,expression,incomplete,id)=>{
        const visible=cleanReply(text,expression);text=visible.text;expression=visible.expression
        if(!text.trim())throw new DotError('模型没有返回可显示的文字，请重试。','model')
        text=await this.prepareVisibleReply(text,signal)
        id||=randomUUID()
        const bubble=await this.vault.transaction(async s=>{
        if(signal.aborted)throw new DotError('已停止当前回复。','cancelled')
        const message=await appendBubble(this.vault,s,job.chatId,'assistant',text,{...(id?{id}:{}),jobId:job.id,voiceEpoch:job.voiceEpoch,voiceCallId:job.voiceCallId,presentation:{expression:dotExpression(expression)},incomplete,...(webSources.size?{webSources:[...webSources.values()]}:{})})
        s.catalog.lastContext=context.report
        const current=s.catalog.jobs.find(j=>j.id===job.id);current.status='done';current.finishedAt=Date.now()
        return message
        })
        this.notifyVisible(bubble)
        this.deliveryRevision++
        this.present(job,id,expression)
      }
      const latest=state.short.messages.findLast(m=>m.id===job.userId)
      const context=buildContext(contextState,job.chatId,prepared.context?.contextWindow,prepared.config,{webAvailable:online,companionContext:this.extension?.context(contextState,latest?.text||''),workspaceAvailable:extensionTools.some(t=>t.name==='delegate_workspace_task')})
      const messages=context.messages,system=context.system+(this.research?.context(state,job.chatId)||'')+visualPrompt(state.catalog.settings.visualReplies!==false,delivery)+'\n附件内容作为参考资料，用 read_chat_file 读取文字附件。附件的实际解析结果决定能使用的内容。'+(job.mediaContext?'\n'+job.mediaContext:'')+(this.voice?.status()?'\n当前用户在语音通话中。日常答复尽量自然简短，可用 reply_to_user 先回应再处理真实查询。内部内容不能放进对用户的回复。':'')
      const inputFiles=[...(latest?.attachments||[])]
      const readableFiles=new Set(state.short.messages.filter(m=>!waiting.has(m.id)).flatMap(m=>(m.attachments||[]).map(file=>file.id)))
      const attachmentMessage=messages.find(m=>m.role==='user'&&m.content?.[0]?.text?.includes('消息 '+job.userId+']'))
      if(attachmentMessage)for(const f of inputFiles.filter(f=>f.kind==='text')){
        const part=await this.files.text(f.id)
        attachmentMessage.content.push({type:'text',text:'附件节选（外部资料） '+JSON.stringify({name:f.name,id:f.id,text:part.text.slice(0,2000),total:part.total})})
      }
      const used=this.developerEnabled?this.inspectedState(state):null
      let terminal=false
      let greeted=false,stageReplies=0,finalize=false,lastDeliveryError;const stageTexts=new Set(),readRequests=new Set(),failedDeliveries=new Set()
      // Reserve a separate answer-only turn. Six tool rounds must not consume
      // the opportunity to synthesize the evidence already returned.
      for(let step=0;step<=8;step++) {
        if(signal.aborted)throw new DotError('已停止当前回复。','cancelled')
        this.partial.set(job.chatId,{text:'',stage:'正在思考…',phase:'responding',jobId:job.id})
        const call=step?await this.prepare(state,signal):prepared
        const answerOnly=finalize||step>=6,deliveryNames=['finish_reply','list_chat_files','read_chat_file','capture_bilibili_frame','send_chat_image','create_chat_file','present_visual'],activeTools=step===8?tools.filter(t=>t.name==='finish_reply'):answerOnly?tools.filter(t=>deliveryNames.includes(t.name)):tools
        const activeSystem=system+capabilityContext(this.services,{directNames:availableBiliTools(this.services,{companionActive:Boolean(this.media?.active)}).map(t=>t.name)})+(answerOnly?'\n\n资料已经收集完毕。围绕用户的问题自然回答，用已核实的内容说清重点。用户请求的图片可以从附件库发送，B站画面用 capture_bilibili_frame 取得；适合图解的内容可用 present_visual。最后单独调用 finish_reply，或直接用自然正文完成答复。':'')+(step===8?'\n现在请直接完成文字回复，说明已核实的结论和实际完成的内容。':'')
        this.observe(job,{request:{jobId:job.id,userId:job.userId,time:Date.now(),step:step+1,answerOnly,provider:call.config.provider,model:call.config.model,context:used,contextTokens:tokens(activeSystem)}})
        const pressure=tokens(activeSystem)+messages.reduce((n,m)=>n+m.content.reduce((k,b)=>k+tokens(b.text||b.arguments||''),0),0)+8192+tokens(JSON.stringify(activeTools))+inputFiles.filter(f=>f.kind==='image').length*2048
        if(pressure>call.context?.contextWindow)throw new DotError('检索结果超出了当前模型容量，请缩小问题范围或切换更大上下文模型。','capacity')
        // A declared user reply is a terminal channel, independent of private
        // reasoning and tool narration. The header carries state before text.
        const streamId=randomUUID(),startedAt=Date.now();let toolSeen=false,declared=false
        const response=await this.files.withImages(inputFiles,call.inputModalities?.includes('image')?this.services.frameInput:null,signal,images=>{
          const label=images.length?'当前请求实际展示的图片附件编号（按图片顺序）：'+inputFiles.filter(file=>file.kind==='image').slice(0,4).map(file=>file.id).join(', '):inputFiles.some(f=>f.kind==='image')?'图片附件已取得，可发送；此次图片理解通道未启用。':''
          const imageContent=[...images,...(label?[{type:'text',text:label}]:[])]
          const callMessages=messages.map(m=>m===attachmentMessage?{...m,content:[...m.content,...imageContent]}:m)
          if(!attachmentMessage&&imageContent.length)callMessages.push({role:'user',content:imageContent})
          return collect(call.stream({...call.config,system:activeSystem,messages:callMessages,tools:activeTools,signal}),signal,text=>{
          const visible=visibleReply(text)
          if(!visible||toolSeen)return
          declared=true
          this.present(job,streamId,visible.expression)
          this.partial.set(job.chatId,{text:responseText(this.vault,visible.text,{partial:true}),stage:'正在输入…',phase:'responding',jobId:job.id,id:streamId,time:startedAt,presentation:{id:streamId,expression:visible.expression}})
        },chunk=>{
          if(chunk.type==='tool-call-delta'||chunk.type==='block-start'&&chunk.blockType==='tool-call'||chunk.type==='block-end'&&chunk.block.type==='tool-call'){
            toolSeen=true
            this.partial.set(job.chatId,{text:'',stage:'正在思考…',phase:'responding',jobId:job.id})
          }
        })})
        const visible=visibleReply(response.text)
        if(!visible&&response.text.trimStart().startsWith('[dot-reply:'))throw new DotError('模型回复格式不完整，请重试。','model')
        if((declared||visible)&&response.calls.length)throw new DotError('回复与工具调用混在一起，已停止本轮；请重试。','model')
        if(response.text.trim()&&!response.calls.length) {
          const text=visible?visible.text:response.text
          if(!text.trim())throw new DotError('模型没有返回可显示的文字，请重试。','model')
          await deliverFinal(text,visible?.expression||'neutral',response.finish.kind==='max-tokens',visible?streamId:undefined)
        }
        if(!response.calls.length){if(!response.text.trim())throw new DotError('模型没有返回可显示的文字，请重试。','model');terminal=true;break}
        if(answerOnly&&response.calls.some(tool=>!activeTools.some(allowed=>allowed.name===tool.name)))break
        messages.push({id:randomUUID(),role:'assistant',source:{kind:'model',provider:call.config.provider,model:call.config.model,...(response.replayState?{replayState:response.replayState}:{})},content:response.content})
        // Deliver the acknowledgement before any disk lookup, even if the
        // provider orders the parallel tool calls differently.
        for(const tool of [...response.calls].sort((a,b)=>Number(b.name==='reply_to_user')-Number(a.name==='reply_to_user'))) {
          let result,isError=false,readKey
          try {
            const args=JSON.parse(tool.arguments)
            state=await this.vault.read()
            if(this.research&&response.calls.some(t=>t.name==='background_research')&&(response.calls.filter(t=>t.name==='background_research').length!==1||response.calls.some(t=>!['background_research','reply_to_user'].includes(t.name))))throw new DotError('后台派发只可单独调用或与一次简短回应同时调用，其他操作请单独处理。')
            if(this.research?.tools().some(t=>t.name===tool.name)){
              result=await this.research.tool(tool.name,args,job,tool.id)
              if(tool.name==='background_research'&&result.accepted){
                if(!greeted)await deliverFinal(typeof args.reply==='string'&&args.reply.trim()?args.reply.trim().slice(0,500):'好，我看看。',args.expression||'neutral',false)
                else await this.vault.transaction(s=>{const current=s.catalog.jobs.find(j=>j.id===job.id);current.status='done';current.finishedAt=Date.now()})
                terminal=true;break
              }
            }
            else if(tool.name==='capture_bilibili_frame'&&tools.some(item=>item.name===tool.name)){
              result=await this.research.capture(biliFrameRequest(args),job,tool.id)
              if(result.accepted){
                if(!greeted)await deliverFinal('我把视频里的画面取出来。','neutral',false)
                else await this.vault.transaction(s=>{const current=s.catalog.jobs.find(j=>j.id===job.id);current.status='done';current.finishedAt=Date.now()})
                terminal=true;break
              }
            }
            else if(tool.name==='finish_reply'){
              if(response.calls.length!==1)throw new DotError('finish_reply 必须单独调用；请先完成其他工具，再提交最终回复。')
              if(typeof args.text!=='string'||!args.text.trim()||args.text.length>100000)throw new DotError('最终回复应为 1–100000 字。')
              await deliverFinal(args.text,args.expression,response.finish.kind==='max-tokens')
              terminal=true;break
            }
            if(['memory_search','memory_read','web_search','web_read'].includes(tool.name)){
              readKey=tool.name+':'+JSON.stringify(tool.name==='memory_read'?[...new Set(args.ids||[])].sort():tool.name==='web_read'?String(args.url||'').trim():String(args.query||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase())
              if(readRequests.has(readKey)){finalize=true;throw new DotError('相同查询已执行，结果已在上下文中。不要重复读取，现在请依据已有结果给出最终答复。')}
            }
            const webCall=['web_search','web_read'].includes(tool.name)
            if((webCall||['memory_search','memory_read'].includes(tool.name))&&!greeted){
              const bubble=await this.vault.transaction(s=>appendBubble(this.vault,s,job.chatId,'assistant',webCall?'我帮你查一下最新的信息。':'我想想，稍等我一下。',{jobId:job.id,voiceEpoch:job.voiceEpoch,voiceCallId:job.voiceCallId}))
              this.present(job,bubble.id,'neutral')
              this.notifyVisible(bubble)
              this.deliveryRevision++
              greeted=true
            }
            if(this.research?.tools().some(t=>t.name===tool.name)){}
            else if(tool.name==='discover_dsh_tools'){result=discoverTools(this.services,args,{directNames:availableBiliTools(this.services,{companionActive:Boolean(this.media?.active)}).map(t=>t.name)})}
            else if(tool.name==='check_bilibili_connection'){
              result=await checkBiliConnection(this.services,{signal,verify:state.catalog.settings.webSearch!==false})
              if(result.state!=='connected'&&!connectionShown){
                const bubble=await this.vault.transaction(s=>{signal.throwIfAborted();return appendBubble(this.vault,s,job.chatId,'assistant','B站连接',{jobId:job.id,connection:'bilibili'})})
                this.deliveryRevision++;connectionShown=true
              }
              result={...result,connectionCardShown:connectionShown}
            }
            else if(tool.name==='list_chat_files'){
              result=await this.files.list(args);for(const file of result.files)readableFiles.add(file.id)
            }
            else if(tool.name==='read_chat_file'){
              if(!readableFiles.has(args.id))throw new DotError('请先使用当前上下文中已有的附件编号。')
              const [file]=await this.files.resolve([args.id])
              if(file.kind==='image'&&call.inputModalities?.includes('image')&&this.services.frameInput){
                if(!inputFiles.some(f=>f.id===file.id)){inputFiles.push(file);while(inputFiles.filter(f=>f.kind==='image').length>4)inputFiles.splice(inputFiles.findIndex(f=>f.kind==='image'),1)}
                result={file,imageInNextRequest:true}
              }else result=await this.files.text(args.id,args.offset)
            }
            else if(['create_chat_file','send_chat_image','present_visual'].includes(tool.name)){
              const deliveryKey=tool.name+':'+JSON.stringify(args)
              if(failedDeliveries.has(deliveryKey))throw new DotError('这个来源已经校验过。请从本地附件库选取图片编号，或用 capture_bilibili_frame 取得视频画面。')
              const presentation=await this.preparePresentation(tool.name,args,signal,{networkAllowed:state.catalog.settings.webSearch!==false,delivery})
              const bubble=await this.vault.transaction(s=>{signal.throwIfAborted();return appendBubble(this.vault,s,job.chatId,'assistant',presentation.text,{jobId:job.id,attachments:[presentation.file],presentation:{artifactOnly:presentation.artifactOnly}})})
              this.notifyVisible(bubble);this.deliveryRevision++;readableFiles.add(presentation.file.id);result=presentation.response
            }
            else if(tool.name==='read_bilibili_video'){
              if(!online)throw new DotError('联网未开启。')
              this.partial.set(job.chatId,{text:'',phase:'searching',stage:'正在查资料…',jobId:job.id})
              result=await readBili(this.services,args,signal,{companionActive:Boolean(this.media?.active)})
            }
            else if(availableBiliTools(this.services).some(t=>t.name===tool.name)){
              if(!online)throw new DotError('联网未开启。')
              this.partial.set(job.chatId,{text:'',phase:'searching',stage:'正在查资料…',jobId:job.id})
              result=await executeBiliTool(this.services,tool.name,args,signal,{companionActive:Boolean(this.media?.active),cacheImages:(request,activeSignal)=>cachedBiliImages(this.files,request,activeSignal),captureImages:(result,request,options)=>importBiliImages(this.files,result,request,signal,options)})
              for(const image of result.images||[]){readableFiles.add(image.id);if(inputFiles.filter(file=>file.kind==='image').length<4&&!inputFiles.some(file=>file.id===image.id))inputFiles.push(image)}
            }
            else if(tool.name==='reply_to_user'){
              if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)throw new DotError('简短回应应为 1–500 字。')
              if(stageTexts.has(args.text.trim()))throw new DotError('这句阶段回应已发送，请继续处理，不要重复发送。')
              if(stageReplies>=4)throw new DotError('已发送4次阶段回应，请完成检索并给出最终答复。')
              const text=await this.prepareVisibleReply(args.text.trim(),signal)
              const bubble=await this.vault.transaction(s=>{if(signal.aborted)throw new DotError('已停止当前回复。','cancelled');return appendBubble(this.vault,s,job.chatId,'assistant',text,{jobId:job.id,voiceEpoch:job.voiceEpoch,voiceCallId:job.voiceCallId,presentation:{expression:dotExpression(args.expression)}})})
              stageReplies++;stageTexts.add(args.text.trim());this.present(job,bubble.id,bubble.presentation?.expression)
              this.notifyVisible(bubble)
              this.deliveryRevision++
              greeted=true;result={sent:true}
            }
            else if(tool.name==='memory_search'){
              this.partial.set(job.chatId,{text:'',stage:'正在回想…',phase:'recalling',jobId:job.id})
              const records=await searchArchive(this.vault,state,args.query,8)
              const learned=recallLearned(state,args.query,6).map(e=>({kind:e.kind,id:e.sourceIds[0],text:learnedText(e),sourceIds:e.sourceIds,status:e.status}))
              const important=state.permanent.entries.filter(e=>e.enabled&&relevance(e.text,args.query)>0).slice(-4).map(e=>({kind:'important',id:e.sourceIds[0],text:e.text,sourceIds:e.sourceIds}))
              const all=learnedEntries(state)
              const ranked=[...(this.extension?.search(state,args.query)||[]),...learned,...important,...records.map(record=>({...record,revisions:all.filter(e=>e.sourceIds.includes(record.id)&&e.status!=='active').map(e=>{
                const replacement=all.find(next=>next.id===e.replacedBy)
                return {status:e.status,...(replacement?{update:learnedText(replacement),sourceIds:replacement.sourceIds}:{})}
              })}))]
              result=[];let remaining=Math.min(4000,Math.max(500,call.context.contextWindow-pressure-2000))
              for(const hit of ranked){const size=tokens(JSON.stringify(hit));if(size>remaining)continue;result.push(hit);remaining-=size}
            }
            else if(tool.name==='memory_read'){
              this.partial.set(job.chatId,{text:'',stage:'正在回想…',phase:'recalling',jobId:job.id})
              result=await readSources(this.vault,state,args.ids,Math.min(14000,Math.max(1000,call.context.contextWindow-pressure-1000)))
            }
            else if(webCall){
              if(!online||state.catalog.settings.webSearch===false)throw new DotError('联网功能已关闭或尚未就绪。','web')
              this.partial.set(job.chatId,{text:'',stage:'正在查资料…',phase:'searching',jobId:job.id})
              result=tool.name==='web_search'?await searchWeb(this.services.web,args.query,signal):await readWeb(this.services.web,args.url,signal)
              const sources=tool.name==='web_search'?result.sources:result.statusCode>=200&&result.statusCode<300?[{url:result.url,title:webSources.get(result.url)?.title||result.url}]:[]
              for(const source of sources)if(webSources.size<16)webSources.set(source.url,{url:source.url,title:source.title,...(source.publishedAt?{publishedAt:source.publishedAt}:{}),retrievedAt:result.retrievedAt})
              const budget=Math.min(6000,Math.max(800,call.context.contextWindow-pressure-2000))
              while(tokens(JSON.stringify(result))>budget&&result.content?.length){result.content=result.content.slice(0,Math.floor(result.content.length*.65));result.truncated=true}
              while(tokens(JSON.stringify(result))>budget&&result.sources?.length>1){result.sources.pop();result.truncated=true}
              if(tokens(JSON.stringify(result))>budget&&result.sources?.length){result.sources=[];result.truncated=true}
            }
            else if(tool.name==='observe_current_media'&&mediaTools.length){this.partial.set(job.chatId,{text:'',stage:'正在看…',phase:'searching',jobId:job.id});result=await this.media.context(true)}
            else if(extensionTools.some(t=>t.name===tool.name)){result=await this.extension.tool(tool.name,args,state,job);isError=result?.ok===false}
            else throw new DotError('当前没有这个工具。')
            if(readKey&&!isError)readRequests.add(readKey)
          }catch(e){
            result={error:e instanceof DotError?e.message:'操作未完成，请检查参数或稍后重试。'};isError=true
            if(e.code==='delivery-route')result.recovery={reply:'finish_reply',visual:'present_visual'}
            else if(['send_chat_image','create_chat_file','present_visual'].includes(tool.name)){
              lastDeliveryError={tool:tool.name,error:result.error};failedDeliveries.add(tool.name+':'+tool.arguments);try{failedDeliveries.add(tool.name+':'+JSON.stringify(JSON.parse(tool.arguments)))}catch{}
              result.recovery={localLibrary:'list_chat_files',...(tools.some(item=>item.name==='capture_bilibili_frame')?{videoFrames:'capture_bilibili_frame'}:{})}
              if(failedDeliveries.size>=2)finalize=true
            }
          }
          await this.vault.transaction(s=>{
            const current=s.catalog.jobs.find(j=>j.id===job.id);current.internalSteps??=[]
            current.internalSteps.push({tool:tool.name,isError,result:JSON.stringify(result).slice(0,16000),time:Date.now()})
          })
          messages.push({id:randomUUID(),role:'tool',source:{kind:'tool',callId:tool.id},toolCallId:tool.id,isError,content:[{type:'text',text:JSON.stringify(result)}]})
        }
        if(terminal)break
        if(answerOnly&&step===8)break
      }
      if(!terminal&&lastDeliveryError){await deliverFinal((lastDeliveryError.tool==='send_chat_image'?'这张图片还没发出来：':'这份图文还没交付成功：')+lastDeliveryError.error,'uncertain',false);terminal=true}
      if(!terminal)throw new DotError('这次没能整理出完整答复，抱歉让你等了。可以直接重试，不必重新描述一遍。','model')
      job.status='done'
      this.kickQueue();this.research?.kick()
      this.observe(job,{analysis:{jobId:job.id,status:'queued',time:Date.now()}})
      if(this.partial.get(job.chatId)?.jobId===job.id)this.partial.delete(job.chatId)
      // New messages can start as soon as the final answer is saved. Analysis
      // is serialized separately and cannot turn a delivered reply into failure.
      this.maintenance=this.maintenance.then(()=>signal.aborted?undefined:this.maintain(job,signal)).catch(()=>{})
      await this.maintenance
    } catch(e) {
      job.status=signal.aborted?'cancelled':'failed'
      if(this.partial.get(job.chatId)?.jobId===job.id)this.partial.delete(job.chatId)
      await this.vault.transaction(s=>{
        const j=s.catalog.jobs.find(j=>j.id===job.id)
        j.status=signal.aborted?'cancelled':'failed';j.finishedAt=Date.now()
        j.error=e instanceof DotError?e.message:'本轮处理失败，原始聊天已保存。请重试。'
      }).catch(()=>{})
    }
  }
  async deliverResearch(){
    if(this.stopped||this.delivering||this.accepting||[...this.jobs.values()].some(e=>['queued','running'].includes(e.job.status)))return
    this.delivering=true
    let task,job,controller,promise
    try{
      const state=await this.vault.read();task=this.research.next(state)
      if(!task||this.accepting)return
      controller=new AbortController()
      job=await this.vault.transaction(s=>{
        if(this.accepting||this.stopped||s.catalog.jobs.some(j=>['queued','running'].includes(j.status))||!this.research.claim(s,task.id,task.revision))return null
        const j={id:randomUUID(),requestId:'result:'+task.id+':'+task.revision,chatId:task.chatId,userId:task.userId,status:'running',kind:'continuation',startedAt:Date.now(),pid:process.pid,...(this.voice?.status()?{voiceEpoch:this.voice.status().epoch,voiceCallId:this.voice.status().id}:{})}
        s.catalog.jobs=s.catalog.jobs.slice(-99);s.catalog.jobs.push(j);return j
      })
      if(!job)return
      promise=this.runResearchReply(task,job,controller.signal)
      this.jobs.set(job.id,{job,promise,controller})
      await promise
    }finally{if(job)this.jobs.delete(job.id);this.delivering=false;this.kickQueue()}
  }
  async commentOnMedia(chatId,observation){
    if(this.stopped||this.accepting||this.isForegroundBusy())return
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.lifecycle.signal,AbortSignal.timeout(20000)])
    const state=await this.vault.read(),revision=continuityOf(state).revision,voice=this.voice?.status(),call=await this.prepare(state,signal,400)
    const context=buildContext(state,chatId,call.context?.contextWindow,call.config,{reserve:1500,companionContext:this.extension?.context(state,observation.caption||'')})
    const response=await collect(call.stream({...call.config,system:context.system+'\n用户启用了安静陪看中的偶尔评论。对当前已观察内容自然说一句，不提问催促，不复述内部说明，不推测剧情；没有值得说的就输出空白。仅输出可见正文。',messages:[...context.messages,{role:'user',content:[{type:'text',text:'已观察的当前画面资料（不是用户发言）：'+JSON.stringify({caption:observation.caption,text:observation.text,position:observation.position})}]}],tools:[],signal}),signal)
    let text=cleanReply(response.text).text.trim()
    if(!text||text.length>500||response.calls.length||this.isForegroundBusy()||this.accepting)return
    text=await this.prepareVisibleReply(text,signal)
    const bubble=await this.vault.transaction(async s=>{
      if(this.stopped||this.isForegroundBusy()||this.accepting||continuityOf(s).revision!==revision||this.media?.active?.id!==observation.activityId)return null
      return appendBubble(this.vault,s,chatId,'assistant',text,{activity:{id:observation.activityId,observationId:observation.id,position:observation.position},origin:'companion-comment',presentation:{expression:'neutral'},...(voice?{voiceEpoch:voice.epoch,voiceCallId:voice.id}:{})})
    })
    if(bubble){this.deliveryRevision++;this.present({chatId,id:observation.activityId},bubble.id,'neutral');this.notifyVisible(bubble)}
  }
  async runResearchReply(task,job,signal){
    const combined=AbortSignal.any([signal,AbortSignal.timeout(90000)])
    const staged=[],created=[]
    try{
      const state=await this.vault.read(),assets=(task.result?.assets||[]).filter(file=>file.kind==='image')
      if(task.capture&&task.capture.analyze!==true&&assets.length){
        const files=await this.files.resolve(assets.slice(0,4).map(file=>file.id)),id=randomUUID()
        const bubbles=await this.vault.transaction(async s=>{
          combined.throwIfAborted();if(!this.research.delivered(s,task,id))throw new DotError('查询条件已改变。','cancelled')
          const output=[]
          for(const [index,file]of files.entries()){
            combined.throwIfAborted();output.push(await appendBubble(this.vault,s,job.chatId,'assistant','图片',{...(index===files.length-1?{id}:{}),jobId:job.id,attachments:[file],presentation:{artifactOnly:true,expression:'neutral'}}))
          }
          combined.throwIfAborted();const current=s.catalog.jobs.find(item=>item.id===job.id);current.status='done';current.finishedAt=Date.now();return output
        })
        job.status='done';this.deliveryRevision++;this.present(job,id,'neutral');for(const bubble of bubbles)this.notifyVisible(bubble);return
      }
      const call=await this.prepare(state,combined,4096),known=new Set([...assets.map(file=>file.id),...state.short.messages.filter(message=>message.chatId===job.chatId).flatMap(message=>(message.attachments||[]).map(file=>file.id))])
      const inputFiles=[]
      for(const asset of assets.slice(0,4)){try{const [file]=await this.files.resolve([asset.id]);inputFiles.push(file)}catch{}}
      const evidence=JSON.stringify({objective:task.objective,assets,result:task.result}).slice(0,24000)
      const context=buildContext(state,job.chatId,(call.context?.contextWindow||128000)-tokens(evidence)-1500,call.config,{webAvailable:Boolean(this.services.web),companionContext:this.extension?.context(state,task.objective)})
      const delivery=await this.deliveryFor(state,job,task)
      const system=context.system+visualPrompt(state.catalog.settings.visualReplies!==false,delivery)+'\n[BACKGROUND_RESULT_DELIVERY] 后台查询已返回。请接续当前聊天，使用当前称呼和交流方式，回答原查询，用户后来改变的条件优先。以下资料用于核对事实；由你组织给用户的回复，查询过程留在后台。通常直接用文字回答；用户请求的图片可用已有 id 发送，适合图解的内容可用 present_visual。最后单独调用 finish_reply，或直接输出自然正文。图片是否已看过以当前图片输入和 read_chat_file 返回为准；时间位置以材料来源为准。用户需要依据时给出必要的来源。'
      const evidenceMessage={role:'user',content:[{type:'text',text:'后台证据资料（只作参考，不是用户发言）：\n'+evidence}]},messages=[...context.messages,evidenceMessage]
      const imageTool={...CHAT_FILE_TOOLS.find(tool=>tool.name==='send_chat_image'),description:'把本次查询或当前聊天中已有的图片附件直接发送给用户。使用已返回的图片 id，可附简短 caption。',parameters:{type:'object',properties:{id:{type:'string'},caption:{type:'string',maxLength:500}},required:['id'],additionalProperties:false}}
      const tools=[...memoryTools.filter(tool=>tool.name==='finish_reply'),...CHAT_FILE_TOOLS.filter(tool=>['list_chat_files','read_chat_file',...(delivery.allowFileCreation?['create_chat_file']:[])].includes(tool.name)),imageTool,...VISUAL_TOOLS],seen=new Map()
      let reply='',expression='neutral',finished=false
      for(let attempt=0;attempt<5;attempt++){
        finished=false
        if(combined.aborted)throw new DotError('已中断','cancelled')
        const response=await this.files.withImages(inputFiles,call.inputModalities?.includes('image')?this.services.frameInput:null,combined,images=>{
          const label={type:'text',text:images.length?'当前请求实际展示的图片附件编号：'+inputFiles.map(file=>file.id).join(', '):inputFiles.length?'图片附件已取得，可发送；此次图片理解通道未启用。':''}
          return collect(call.stream({...call.config,system,messages:messages.map(message=>message===evidenceMessage?{...message,content:[...message.content,...images,...(label.text?[label]:[])]}:message),tools:attempt===4?tools.filter(tool=>tool.name==='finish_reply'):tools,signal:combined}),combined)
        })
        if(!response.calls.length){const visible=visibleReply(response.text)||cleanReply(response.text);reply=visible.text;expression=visible.expression;finished=Boolean(reply.trim())}
        else if(response.calls.length===1&&response.calls[0].name==='finish_reply'){
          try{const value=JSON.parse(response.calls[0].arguments);if(typeof value.text==='string'){const visible=cleanReply(value.text,value.expression);reply=visible.text;expression=visible.expression;finished=Boolean(reply.trim())}}catch{}
        }
        if(finished&&!/<system-reminder>|Current runtime context|\[dot-reply:[^\]]*$/.test(reply))break
        reply=''
        if(!response.calls.length){messages.push({role:'user',content:[{type:'text',text:'请依据已返回的资料，给出本次查询的自然回复；图片和文件可通过交付工具发送。'}]});continue}
        messages.push({id:randomUUID(),role:'assistant',source:{kind:'model',provider:call.config.provider,model:call.config.model,...(response.replayState?{replayState:response.replayState}:{})},content:response.content})
        for(const tool of response.calls){
          let result,isError=false
          try{
            if(tool.name==='create_chat_file'&&!delivery.allowFileCreation)throw new DotError('当前内容直接用文字回复；需要图示时用 present_visual。','delivery-route')
            if(!tools.some(allowed=>allowed.name===tool.name)||response.calls.some(item=>item.name==='finish_reply'))throw new DotError('使用本轮提供的工具；完成后单独调用 finish_reply。')
            const args=JSON.parse(tool.arguments),key=tool.name+':'+tool.arguments
            if(seen.has(key))result=seen.get(key)
            else if(tool.name==='list_chat_files'){
              result=await this.files.list(args);for(const file of result.files)known.add(file.id)
            }else if(tool.name==='read_chat_file'){
              if(!known.has(args.id))throw new DotError('请使用本次查询或当前聊天已有的附件编号。')
              const [file]=await this.files.resolve([args.id])
              if(file.kind==='image'){
                if(!inputFiles.some(item=>item.id===file.id)){inputFiles.push(file);if(inputFiles.length>4)inputFiles.shift()}
                result={file,imageInNextRequest:Boolean(call.inputModalities?.includes('image')&&this.services.frameInput)}
              }else result=await this.files.text(args.id,args.offset)
            }else{
              if(staged.length>=8)throw new DotError('本次图文交付已满，请结束当前回复。')
              if(tool.name==='send_chat_image'&&(!known.has(args.id)||args.path||args.url))throw new DotError('请使用已取得的图片附件编号。')
              const presentation=await this.preparePresentation(tool.name,args,combined,{delivery})
              staged.push(presentation);known.add(presentation.file.id);if(presentation.created)created.push(presentation.file.id)
              result=presentation.response;seen.set(key,result)
            }
          }catch(error){combined.throwIfAborted();isError=true;result={error:error instanceof DotError?error.message:'本次图文交付未完成，请根据已有材料继续回复。'}}
          messages.push({role:'tool',toolCallId:tool.id,isError,content:[{type:'text',text:JSON.stringify(result)}]})
        }
      }
      if(!reply.trim())reply=staged.length?'给你放在这里了。':'刚才那件事，我还没能把依据核对完整，暂时不能给你一个确定的结论。'
      reply=await this.prepareVisibleReply(reply,combined)
      if(combined.aborted)throw new DotError('已中断','cancelled')
      const id=randomUUID()
      const delivered=await this.vault.transaction(async s=>{
        if(combined.aborted||!this.research.delivered(s,task,id))throw new DotError('查询条件已改变。','cancelled')
        const artifacts=[]
        for(const item of staged)artifacts.push(await appendBubble(this.vault,s,job.chatId,'assistant',item.text,{jobId:job.id,attachments:[item.file],presentation:{artifactOnly:item.artifactOnly}}))
        const bubble=await appendBubble(this.vault,s,job.chatId,'assistant',reply,{id,jobId:job.id,voiceEpoch:job.voiceEpoch,voiceCallId:job.voiceCallId,presentation:{expression}})
        const j=s.catalog.jobs.find(j=>j.id===job.id);j.status='done';j.finishedAt=Date.now()
        return {bubble,artifacts}
      })
      job.status='done';this.deliveryRevision++;this.present(job,id,expression);for(const artifact of delivered.artifacts)this.notifyVisible(artifact);this.notifyVisible(delivered.bubble)
      this.maintenance=this.maintenance.then(()=>this.stopped?undefined:this.maintain(job,signal)).catch(()=>{})
    }catch{
      for(const id of created)await this.files.discard(id).catch(()=>{})
      job.status='cancelled'
      await this.vault.transaction(s=>{
        const j=s.catalog.jobs.find(j=>j.id===job.id);if(j){j.status='cancelled';j.finishedAt=Date.now()}
        this.research.release(s,task,!signal.aborted)
      }).catch(()=>{})
    }
  }
  async analyze(sources,state,signal) {
    signal=AbortSignal.any([signal,this.lifecycle.signal,AbortSignal.timeout(60000)])
    const call=await this.prepare(state,signal,4096)
    const input=JSON.stringify(sources.map(({id,role,text,time,activity})=>({id,role,text,time,...(activity?{activity}:{})})))
    const previous=recallLearned(state,sources.map(m=>m.text).join(' '),8).map(({id,kind,topic,text,status})=>({id,kind,topic,text,status}))
    const system=ANALYSIS_PROMPT+'\n'+CONTINUITY_PROMPT+'\n已有连续事项：'+JSON.stringify(continuityOf(state).threads.slice(-12))+'\n已有相关记录（仅供比较，不能作为本轮新证据）：'+JSON.stringify(previous)+'\n另外输出 knowledge 和 memes 数组。每项 {topic,text,sourceId,quote,tags:[]}，quote 和 tags 必须逐字来自本轮气泡。梗可增加 usage（适合的语境）和 avoid（避免的语境），无法判断则留空。knowledge 收集讨论形成的知识、方法和判断，区分用户观点和助手解释，不暗示经过外部验证；memes 收集真正谈到的梗、广告词、歌曲与共同笑点，不凭空补充。发现旧记录被明确修正时可加 supersedes（已有记录 id）、relation:"corrects"；只是提出疑问时 relation:"questions"。没有证据则数组为空。不要按最新说法盲目覆盖，也不要把普通一餐或临时任务当成知识。'+(this.extension?'\n'+this.extension.analysisPrompt(state):'')
    if(tokens(input)+tokens(system)+4096>call.context?.contextWindow)return null
    const result=await collect(call.stream({...call.config,system,messages:[{role:'user',content:[{type:'text',text:input}]}],signal,purpose:'compaction'}),signal)
    return parseAnalysis(result.text,sources)
  }
  async maintain(job,signal) {
    if(this.stopped)return
    let state=await this.vault.read(),warning=false
    const analysisEnabled=state.catalog.settings.autoPermanent||state.catalog.settings.autoProfile!==false||state.catalog.settings.autoLearn!==false||this.extension?.needsAnalysis(state)
    const before=this.developerEnabled?this.inspectedState(state):null
    this.observe(job,{analysis:{jobId:job.id,status:'running',time:Date.now(),before}})
    if(analysisEnabled) {
      try {
        const continuityRevision=continuityOf(state).revision
        const refs=state.catalog.messages.filter(m=>m.id===job.userId||m.jobId===job.id)
        const sources=await Promise.all(refs.slice(-8).map(m=>this.vault.message(m.id)))
        const analysis=await this.analyze(sources,state,signal)
        if(!analysis)warning=true
        else await this.vault.transaction(s=>{
          if(s.catalog.settings.autoPermanent)for(const e of analysis.salient)if(!s.permanent.entries.some(x=>x.sourceIds[0]===e.sourceIds[0]&&x.quote===e.quote))s.permanent.entries.push(e)
          if(s.catalog.settings.autoProfile!==false)rememberProfile(s,analysis.profile)
          if(s.catalog.settings.autoLearn!==false)rememberLearned(s,analysis.learned)
          this.extension?.applyAnalysis(s,analysis.extension,sources)
          applyContinuityAnalysis(s,analysis.continuity,sources,continuityRevision)
        })
        if(analysis)await this.extension?.schedule()
      }catch {warning=true}
    }
    state=await this.vault.read()
    const pending=[...state.medium.entries,...state.long.entries].filter(e=>e.pending&&e.attempts<3).slice(0,8)
    for(const item of pending) {
      if(signal.aborted)return
      let analysis=null
      try {analysis=await this.analyze(await Promise.all(item.sourceIds.map(id=>this.vault.message(id))),state,signal)}catch {warning=true}
      await this.vault.transaction(s=>{
        const entry=[...s.medium.entries,...s.long.entries].find(e=>e.id===item.id)
        if(!entry)return
        entry.attempts++
        if(analysis?.summary&&analysis.overview) {
          entry.summary=s.long.entries.includes(entry)?analysis.overview:analysis.summary
          entry.overview=analysis.overview;entry.tokens=tokens(entry.summary);entry.pending=false;entry.method='model'
          if(s.catalog.settings.autoLearn!==false)rememberLearned(s,analysis.learned)
        }else warning=true
        ageMedium(s)
      })
    }
    await this.vault.transaction(s=>{s.catalog.memoryNotice=warning?'聊天原文已保存；部分自动记忆整理未完成，暂用有出处的原文节选。':''})
    this.observe(job,{analysis:{jobId:job.id,status:warning?'incomplete':analysisEnabled?'complete':'disabled',time:Date.now(),before,after:this.developerEnabled?this.inspectedState(await this.vault.read()):null}})
  }
  async cancel() {
    this.cancelling=true;clearTimeout(this.queueTimer);this.queueTimer=null
    try{
      const entries=[...this.jobs.values()]
      for(const entry of entries)entry.controller.abort()
      const queued=entries.filter(e=>e.job.status==='queued')
      if(queued.length)await this.vault.transaction(s=>{for(const entry of queued){
        const row=s.catalog.jobs.find(j=>j.id===entry.job.id)
        if(row){row.status='cancelled';row.finishedAt=Date.now()}
      }})
      for(const entry of queued){entry.job.status='cancelled';this.jobs.delete(entry.job.id);entry.resolve()}
      await Promise.allSettled(entries.map(e=>e.promise))
    }finally{this.cancelling=false;this.deliveryRevision++;this.kickQueue()}
  }
  async shutdown(){this.stopped=true;this.files.close();this.lifecycle.abort();for(const entry of this.jobs.values())entry.controller.abort();await this.research?.stop();await this.extension?.stop();await this.cancel();await this.maintenance}
}
