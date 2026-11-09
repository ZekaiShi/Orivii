import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {JSDOM} from 'jsdom'
import {z} from 'zod'
import {Vault} from '../src/vault.js'
import {MEMORY_DEFAULTS,LEGACY_DEFAULT_PERSONA,settingsOf} from '../src/memory.js'
import {ChatFiles,CHUNK_SIZE,generatedFile} from '../src/chat-files.js'
import {createDotRemote} from '../src/protocol.js'
import {DotHost} from '../src/host.js'
import {readBili} from '../src/bili.js'
import {biliRequest,qrSource,qrImage} from '../src/bili-client.js'
import {appearanceStyle,inkFor} from '../src/appearance.js'
import {createSendTransition} from '../src/motion.js'
import {uploadChatFile,downloadChatFile} from '../src/file-client.js'

test('attachments use encrypted storage, bounded ordered chunks, identity isolation and lossless downloads',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-files-')),vault=new Vault(root)
  t.after(async()=>{vault.close();await fs.rm(root,{recursive:true,force:true})})
  await vault.initialize('synthetic-file-password',MEMORY_DEFAULTS)
  const files=new ChatFiles(vault),bytes=Buffer.from('测试用户附件；不得公开\n'.repeat(15000)),owner='owner'
  assert.throws(()=>files.begin({name:'../secret',size:4},owner),/文件名/)
  assert.throws(()=>files.begin({name:'large',size:11*1024*1024},owner),/10 MB/)
  const u=files.begin({name:'notes.txt',size:bytes.length},owner)
  assert.throws(()=>files.chunk({id:u.id,offset:0,data:'YWJj'},'other'),/当前窗口/)
  assert.throws(()=>files.chunk({id:u.id,offset:10,data:'YWJj'},owner),/顺序/)
  assert.throws(()=>files.chunk({id:u.id,offset:0,data:'***'},owner),/分片/)
  for(let offset=0;offset<bytes.length;offset+=CHUNK_SIZE)files.chunk({id:u.id,offset,data:bytes.subarray(offset,offset+CHUNK_SIZE).toString('base64')},owner)
  const file=await files.finish(u.id,owner);assert.equal(file.kind,'text')
  const raw=await fs.readFile(path.join(vault.root,'files',file.id+'.json.enc'),'utf8')
  assert.equal(raw.includes('测试用户附件'),false);assert.equal(raw.includes(bytes.toString('base64')),false)
  const result=await downloadChatFile(file,(_action,r)=>files.read(r));assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes)
  assert.equal((await files.text(file.id)).text.length,8000)
  await assert.rejects(()=>files.resolve([randomUUID()]),/不属于/)
  await assert.rejects(()=>files.save('fake.png',Buffer.from('not an image'),'image/png'),/无法解码/)
  assert.throws(()=>generatedFile('fake.pdf','pretend PDF'),/伪造/)
  vault.close();await assert.rejects(()=>files.read({id:file.id}),/锁定/)
  await vault.unlock('synthetic-file-password');assert.deepEqual((await files.bytes(file.id)).bytes,bytes)
})

test('browser upload transfers file slices and cancellation never completes the upload',async()=>{
  const blob=new Blob(['abcd测试']),file={name:'demo.txt',type:'text/plain',size:blob.size,slice:(...a)=>blob.slice(...a)},calls=[]
  const rpc=async(action,r)=>{calls.push({action,r});if(action==='fileBegin')return {id:randomUUID(),chunkSize:4};if(action==='fileFinish')return {id:r.id,name:file.name}}
  await uploadChatFile(file,rpc)
  assert.equal(calls.filter(c=>c.action==='fileChunk').length,3)
  const c=new AbortController();c.abort();await assert.rejects(()=>uploadChatFile(file,rpc,c.signal))
})

test('strict gateway accepts file and appearance operations and rejects paths, extra fields and CSS injection',()=>{
  const contract=createDotRemote(z).descriptors[0].parameters[0].codec.create(),id=randomUUID()
  assert.ok(contract.safeParse({action:'fileChunk',id,offset:0,data:'YQ=='}).success)
  assert.ok(contract.safeParse({action:'send',chatId:id,text:'图片',requestId:'test',attachments:[id]}).success)
  assert.equal(contract.safeParse({action:'fileRead',id,path:'/private'}).success,false)
  assert.equal(contract.safeParse({action:'settings',settings:{characterColor:'red;url(https://evil.invalid)'}}).success,false)
  assert.throws(()=>settingsOf({bubbleColor:'var(--x)'}),/颜色/)
  const settings=settingsOf({bubbleColor:'#ffffff',replyColor:'#000000',characterColor:'#fedabc'})
  const styles=appearanceStyle(settings)
  assert.equal(styles['--dot-outgoing-ink'],'#000000');assert.equal(styles['--dot-incoming-ink'],'#ffffff')
  assert.equal(inkFor('#808080'),'#000000');assert.deepEqual(appearanceStyle(settingsOf({bubbleColor:'',replyColor:'',characterColor:''})),{})
})

test('bili adapter reuses only the installed tool; rejects missing dependency and whole-video reads during companion mode',async()=>{
  const calls=[],services={tools:{get:n=>n==='bili_watch',execute:async request=>{calls.push(request);return {content:[{type:'text',text:'{"text":"verified subtitle"}'}]}}}}
  const result=await readBili(services,{bv:'https://www.bilibili.com/video/BV1xx411c7mD/',p:2},new AbortController().signal)
  assert.equal(calls.length,1);assert.equal(calls[0].name,'bili_watch');assert.deepEqual(calls[0].arguments,{command:'text',bv:'BV1xx411c7mD',p:2,format:'md',head:6000})
  assert.match(result.content,/verified/);assert.equal(result.untrusted,true)
  await assert.rejects(()=>readBili(services,{bv:'BV1xx411c7mD'},undefined,{companionActive:true}),/陪看/)
  await assert.rejects(()=>readBili({}, {bv:'BV1xx411c7mD'}),/安装/)
  await assert.rejects(()=>readBili(services,{bv:'https://evil.invalid/private'}),/有效/)
  assert.equal(calls.length,1)
})

test('Bili QR uses plugin same-origin endpoints and rejects executable SVG',async()=>{
  const dom=new JSDOM(),svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill="#fff" d="M0 0h20v20H0z"/></svg>'
  assert.match(qrSource(svg,dom.window.DOMParser),/^data:image\/svg\+xml/)
  for(const hostile of [svg.replace('<path','<script>bad()</script><path'),svg.replace('fill="#fff"','fill="url(https://evil.invalid)"'),svg.replace('<path','<image href="https://evil.invalid"/><path')])assert.throws(()=>qrSource(hostile,dom.window.DOMParser))
  let request
  const result=await biliRequest('/login/qr',{},undefined,async(url,options)=>{request={url,options};return new Response('{"ok":true,"data":{"key":"synthetic"}}')})
  assert.equal(result.ok,true);assert.equal(request.url,'/api/bili-watch/login/qr');assert.equal(request.options.credentials,'same-origin')
  await assert.rejects(()=>biliRequest('https://evil.invalid',{}))
  dom.window.close()
})

test('Bili scroll QR uses its own login API and strips unrelated provider fields',async()=>{
  const calls=[],png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  const fetcher=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('start')?{ok:true,key:'synthetic-key',qr:png,url:'private-login-url',credential:'private-cookie'}:{ok:true,state:'ok',file:'private-path',credential:'private-cookie'}))}
  const start=await biliRequest('/login/qr',{},undefined,fetcher,'scroll')
  assert.equal(calls[0].url,'/api/bili-duty/login/start');assert.equal(calls[0].options.credentials,'same-origin')
  assert.equal(qrImage(start.data),png);assert.doesNotMatch(JSON.stringify(start),/private-/)
  const poll=await biliRequest('/login/poll',{key:start.data.key},undefined,fetcher,'scroll')
  assert.equal(calls[1].url,'/api/bili-duty/login/poll');assert.deepEqual(poll,{ok:true,state:'ok'})
  assert.throws(()=>qrImage({png:'https://evil.invalid/qr.png'}));assert.throws(()=>qrImage({png:'data:image/svg+xml,<svg/>'}))
  await assert.rejects(()=>biliRequest('/login/qr',{},undefined,fetcher,'unknown'))
})

test('composer flight is one-shot, preserves text scaling, and cleans up on hidden page or privacy reset',()=>{
  const dom=new JSDOM('<div id="composer"></div><div id="row"><div class="dot-bubble"><div>synthetic message</div></div></div>',{pretendToBeVisual:true}),win=dom.window,doc=win.document
  let hidden=false,reduced=false,serial=0;const raf=new Map(),animations=[]
  Object.defineProperty(doc,'hidden',{get:()=>hidden});win.matchMedia=()=>({matches:reduced})
  win.requestAnimationFrame=fn=>{raf.set(++serial,fn);return serial};win.cancelAnimationFrame=id=>raf.delete(id)
  const flush=()=>{for(const [id,fn]of [...raf]){raf.delete(id);fn()}}
  win.getComputedStyle=()=>({padding:'12px',font:'14px sans-serif',lineHeight:'24px',color:'black',backgroundColor:'white',borderRadius:'18px',boxShadow:'none'})
  win.HTMLElement.prototype.animate=function(frames,options){const a={frames,options,cancel(){this.cancelled=true}};animations.push(a);return a}
  const composer=doc.getElementById('composer'),row=doc.getElementById('row'),bubble=row.firstChild
  composer.getBoundingClientRect=()=>({x:10,y:600,width:600,height:50});bubble.getBoundingClientRect=()=>({x:390,y:500,width:220,height:60})
  const motion=createSendTransition();motion.capture('a',composer);motion.arrive('a',row);flush();flush()
  assert.ok(doc.querySelector('.dot-send-flight'));assert.equal(bubble.style.visibility,'hidden')
  assert.match(animations[0].frames[0].transform,/translate/);assert.doesNotMatch(JSON.stringify(animations[0].frames),/scale/)
  const count=animations.length;motion.arrive('a',row);flush();assert.equal(animations.length,count)
  hidden=true;doc.dispatchEvent(new win.Event('visibilitychange'));assert.equal(doc.querySelector('.dot-send-flight'),null);assert.equal(bubble.style.visibility,'')
  hidden=false;reduced=true;motion.capture('b',composer);motion.arrive('b',row);flush();assert.equal(raf.size,0)
  reduced=false;motion.capture('c',composer);motion.arrive('c',row);motion.clear();assert.equal(raf.size,0)
  dom.window.close()
})

test('real host accepts attachment messages, model reads a text file and delivers a downloadable file without tool leakage',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-file-host-'));let step=0,fileId
  const services={extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(options){
    let block
    if(options.purpose)block={type:'text',text:'{}'}
    else if(step++===0){assert.match(JSON.stringify(options.messages),/temperature,21/);block={type:'tool-call',id:'read',name:'read_chat_file',arguments:JSON.stringify({id:fileId})}}
    else if(step===2)block={type:'tool-call',id:'create',name:'create_chat_file',arguments:JSON.stringify({name:'result.csv',text:'temperature,21\n'})}
    else block={type:'text',text:'文件已经做好了。'}
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')});t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const setup=await host.command({action:'setup',workspace:root,plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{persona:LEGACY_DEFAULT_PERSONA}});assert.equal(setup.ok,true)
  assert.equal((await host.vault.read()).catalog.settings.persona,MEMORY_DEFAULTS.persona)
  const token=setup.value.token,call=async(action,data={})=>{const r=await host.command({action,token,...data});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  const file=await host.engine.files.save('input.csv',Buffer.from('temperature,21\n'));fileId=file.id
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,requestId:randomUUID(),text:'读一下附件，生成一份 CSV',attachments:[file.id]})
  await host.engine.jobs.get(job.id)?.promise
  const state=await call('snapshot',{chatId:chat.id}),output=state.messages.find(m=>m.role==='assistant'&&m.attachments?.length)
  assert.equal(state.jobs.at(-1).status,'done');assert.equal(output.attachments[0].name,'result.csv')
  assert.doesNotMatch(state.messages.map(m=>m.text).join('\n'),/read_chat_file|create_chat_file|tool-call/)
  const downloaded=await call('fileRead',{id:output.attachments[0].id});assert.equal(Buffer.from(downloaded.data,'base64').toString(),'temperature,21\n')
  const denied=await host.command({action:'fileRead',token:'0'.repeat(64),id:file.id});assert.equal(denied.ok,false)
  await call('settings',{settings:{bubbleColor:'#e2d7ff',characterColor:'#123456',persona:'自定义测试人设，保留这段原文。'}});assert.equal((await call('snapshot')).settings.characterColor,'#123456')
  await host.dispose()
  const restored=new DotHost(services,{pointer:path.join(root,'pointer.json')});t.after(()=>restored.dispose())
  const reopened=await restored.command({action:'unlock',workspace:root,password:''});assert.equal(reopened.ok,true,JSON.stringify(reopened))
  assert.equal((await restored.vault.read()).catalog.settings.persona,'自定义测试人设，保留这段原文。')
})
