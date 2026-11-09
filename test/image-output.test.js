import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import {publicImage,workspaceImage,OUTPUT_IMAGE_LIMIT} from '../src/image-output.js'
import {DotHost} from '../src/host.js'
import {createFileCard} from '../src/file-client.js'
const sharp=createRequire(import.meta.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const png=()=>sharp({create:{width:40,height:32,channels:3,background:'#b7a7ed'}}).png().toBuffer()

test('outgoing URLs pin public DNS, recheck redirects, bound bytes and reject HTML or local addresses',async()=>{
  const bytes=await png(),requests=[]
  const requester=(url,options,callback)=>{
    requests.push({url:url.href,options})
    const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=Readable.from([bytes]);response.statusCode=200;response.headers={'content-type':'image/png'};callback(response)});return request
  }
  const result=await publicImage('https://images.example.org/cover.png',undefined,{resolver:async()=>[{address:'8.8.8.8',family:4}],requesters:{https:requester}})
  assert.deepEqual(result.bytes,bytes);assert.equal(result.mediaType,'image/png')
  requests[0].options.lookup('images.example.org',{all:true},(error,addresses)=>{assert.equal(error,null);assert.equal(addresses[0].address,'8.8.8.8')})
  assert.ok(!Object.keys(requests[0].options.headers).some(k=>/cookie|authorization/i.test(k)))
  await assert.rejects(()=>publicImage('https://images.example.org/a',undefined,{resolver:async()=>[{address:'127.0.0.1',family:4}]}),/内网/)
  await assert.rejects(()=>publicImage('http://127.0.0.1/a'),/公开网页/)
  const redirect=(url,_options,callback)=>{const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'https://internal.example.org/a'};callback(response)});return request}
  let queries=0
  await assert.rejects(()=>publicImage('https://images.example.org/a',undefined,{resolver:async()=>[{address:queries++?'10.0.0.1':'8.8.8.8',family:4}],requesters:{https:redirect}}),/内网/)
  const html=(url,_options,callback)=>{const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=Readable.from([]);response.statusCode=200;response.headers={'content-type':'text/html'};callback(response)});return request}
  await assert.rejects(()=>publicImage('https://images.example.org/a',undefined,{resolver:async()=>[{address:'8.8.8.8',family:4}],requesters:{https:html}}),/格式/)
})

test('a model sends a real workspace image, encrypted at rest and rendered as an image attachment',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-send-image-')),bytes=await png();let step=0,renderer
  await fs.writeFile(path.join(root,'drawing.png'),bytes)
  const services={extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(o){
    const block=o.purpose?{type:'text',text:'{}'}:step++===0?{type:'tool-call',id:'image',name:'send_chat_image',arguments:JSON.stringify({path:'drawing.png',caption:'给你看看这张图。'})}:{type:'text',text:'图片发好了。'}
    yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{if(renderer)await act(async()=>renderer.unmount());await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const open=await host.command({action:'setup',workspace:root,password:'fixture-password',settings:{autoPermanent:false,autoProfile:false,autoLearn:false}}),token=open.value.token
  const call=async(action,args={})=>{const r=await host.command({action,token,...args});assert.equal(r.ok,true,JSON.stringify(r));return r.value}
  const chat=await call('createChat'),job=await call('send',{chatId:chat.id,text:'发一下工作区的图片',requestId:randomUUID()})
  await host.engine.jobs.get(job.id)?.promise
  const snapshot=await call('snapshot',{chatId:chat.id}),bubble=snapshot.messages.find(m=>m.attachments?.length)
  assert.equal(bubble.text,'给你看看这张图。');assert.equal(bubble.attachments[0].kind,'image')
  const file=bubble.attachments[0],stored=await fs.readFile(path.join(root,'.dot-memory','files',file.id+host.vault.ext()),'utf8')
  assert.ok(!stored.includes(bytes.toString('base64')))
  t.mock.method(URL,'createObjectURL',()=> 'blob:fixture-image');t.mock.method(URL,'revokeObjectURL',()=>{})
  const Card=createFileCard(React,{rpc:call})
  await act(async()=>{renderer=TestRenderer.create(React.createElement(Card,{file}));await new Promise(r=>setTimeout(r,25))})
  assert.equal(renderer.root.findByType('img').props.src,'blob:fixture-image')
  const download=renderer.root.findByType('button')
  assert.equal(download.props['aria-label'],'下载 drawing.png');assert.match(download.props.className,/dot-image-download/)
  assert.equal(download.children.length,1);assert.equal(download.children[0].type,'svg','image downloads show only an arrow, with the file name available to assistive technology')
  assert.doesNotMatch(JSON.stringify(snapshot),/send_chat_image|base64|fixture-password/)
  assert.equal((await workspaceImage(root,'drawing.png')).bytes.length,bytes.length)
  await assert.rejects(()=>workspaceImage(root,'../outside.png'),/工作空间/)
  await assert.rejects(()=>workspaceImage(root,'.dot-memory/files/a.png'),/工作空间/)
  await fs.writeFile(path.join(root,'large.png'),Buffer.alloc(OUTPUT_IMAGE_LIMIT+1))
  await assert.rejects(()=>workspaceImage(root,'large.png'),/2 MB/)
})
