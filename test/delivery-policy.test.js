import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {deliveryIntent,deliveryPolicy} from '../src/delivery-policy.js'
import {visualPrompt} from '../src/visual.js'
import {DotHost} from '../src/host.js'

const message=(id,text,chatId='c',role='user')=>({id,text,chatId,role})
const policy=(messages,userId,options={})=>deliveryPolicy(messages,{chatId:'c',userId,...options})

test('file delivery follows direct requests, not HTML discussion, diagrams or quoted examples',()=>{
  for(const text of ['今天有点累','对比这两个方案','画一张流程图','HTML 是什么','如何生成 CSV 文件','解释一下如何用 Python 写文件','你总是写 HTML，这是为什么','我喜欢写 Python 代码','他说“生成一个 HTML 文件”是什么意思','看看这段代码\n```js\n// create an html file\n```','> 生成一个 HTML 文件\n这句话是什么意思']){
    assert.notEqual(deliveryIntent(text),'file',text)
  }
  for(const text of ['帮我生成一份 CSV','做个网页展示这组数据','请写一个 Python 脚本','把数据导出到 report.csv','给我一个 HTML','生成“说明.html”','修改刚才的 HTML 文件','Please create a downloadable HTML file','Export this table as CSV'])assert.equal(deliveryIntent(text),'file',text)
  assert.equal(deliveryIntent('不用生成文件，直接说吧'),'chat')
  assert.equal(deliveryIntent('只要一句话'),'chat')
  assert.equal(deliveryIntent('不要长篇解释，做个 CSV'),'file')
})

test('file followups stay in their chat and stop inheriting after a conversational pivot',()=>{
  const messages=[message('1','做个网页'),message('a','生成一个文件','other'),message('b','已保存 HTML','c','assistant'),message('2','改成蓝色'),message('3','继续'),message('4','今天好开心'),message('5','继续'),message('6','生成 result.csv')]
  for(const id of ['1','2','3','6'])assert.equal(policy(messages,id).allowFileCreation,true,id)
  for(const id of ['4','5','unknown'])assert.equal(policy(messages,id).allowFileCreation,false,id)
  assert.equal(policy([message('1','聊聊天'),message('2','生成 CSV')],'1').allowFileCreation,false,'future queued input does not authorize an earlier turn')
  assert.equal(policy([message('1','画张对比图'),message('2','改成蓝色')],'2').allowFileCreation,false,'native graphics remain native during edits')
})

test('background delivery keeps its original route, accepts explicit cancellation and reads no worker instructions',()=>{
  const messages=[message('1','核对这份资料'),message('2','请帮我生成另一个网页')]
  assert.equal(policy(messages,'1',{background:true,initial:{allowFileCreation:false}}).allowFileCreation,false)
  assert.equal(policy([message('1','查资料并生成 CSV'),message('2','今天吃得不错')],'1',{background:true,initial:{allowFileCreation:true}}).allowFileCreation,true)
  assert.equal(policy([message('1','查资料并生成 CSV'),message('2','不用文件了，直接回答')],'1',{background:true,initial:{allowFileCreation:true}}).allowFileCreation,false)
})

test('visual preference can be switched off while explicit file delivery remains available',()=>{
  assert.match(visualPrompt(true),/当图形能明显帮助理解.*优先用原生图文/)
  assert.doesNotMatch(visualPrompt(false),/优先|create_chat_file|说明\.html/)
  assert.match(visualPrompt(false),/默认用文字解释/)
  assert.match(visualPrompt(false,{allowFileCreation:true}),/create_chat_file/)
})

const say=text=>[{type:'text',text}]
const tool=(name,args)=>[{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}]
async function fixture(t,handler){
  const root=await fs.mkdtemp(path.join(tmpdir(),'orivii-routing-')),requests=[]
  const services={extension:{createExtension:()=>null},defaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{async prepareCall(config){return {config,context:{contextWindow:128000},async *stream(o){
    const blocks=o.purpose?say('{}'):(requests.push(o),await handler(o))
    for(const [index,block]of blocks.entries())yield {type:'block-end',index,block}
    yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const host=new DotHost(services,{pointer:path.join(root,'pointer.json')})
  t.after(async()=>{await host.dispose();await fs.rm(root,{recursive:true,force:true})})
  const setup=await host.command({action:'setup',workspace:path.join(root,'workspace'),plaintext:true,plaintextAcknowledgement:'明文没有密码保护',settings:{autoPermanent:false,autoLearn:false,autoProfile:false}})
  assert.equal(setup.ok,true,JSON.stringify(setup))
  const call=async(action,args={})=>{const result=await host.command({action,token:setup.value.token,...args});assert.equal(result.ok,true,JSON.stringify(result));return result.value}
  const chat=await call('createChat')
  const send=async text=>{const job=await call('send',{chatId:chat.id,text,requestId:randomUUID()});await host.engine.jobs.get(job.id)?.promise;return call('snapshot',{chatId:chat.id})}
  return {host,call,chat,send,requests}
}

test('a model cannot turn casual chat into a file write even by calling an unlisted tool',async t=>{
  let round=0
  const f=await fixture(t,o=>{
    assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
    assert.ok(o.tools.some(t=>t.name==='send_chat_image'))
    if(++round===1)return tool('create_chat_file',{name:'unasked.html',text:'<p>FILE_SHOULD_NOT_EXIST</p>'})
    const result=o.messages.findLast(m=>m.role==='tool');assert.equal(result.isError,true)
    assert.match(result.content[0].text,/present_visual/)
    return say('今天有什么开心的事呀？')
  })
  const snapshot=await f.send('今天好开心')
  assert.equal(f.requests.length,2,'no separate routing model call')
  assert.equal(snapshot.jobs.at(-1).status,'done')
  assert.deepEqual(snapshot.messages.filter(m=>m.role==='assistant').map(m=>m.text),['今天有什么开心的事呀？'])
  assert.equal(((await f.host.vault.read()).catalog.files||[]).length,0)
  assert.doesNotMatch(JSON.stringify(snapshot.messages),/create_chat_file|delivery-route|FILE_SHOULD_NOT_EXIST/)
  await assert.rejects(f.host.engine.preparePresentation('create_chat_file',{name:'direct.html',text:'x'},new AbortController().signal),error=>error.code==='delivery-route')
})

test('ordinary comparisons can render native bubbles without creating free HTML',async t=>{
  let round=0
  const f=await fixture(t,o=>{
    assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
    assert.ok(o.tools.some(t=>t.name==='present_visual'))
    return ++round===1?tool('present_visual',{spec:{version:1,title:'方案对比',template:'compare',blocks:[{type:'cards',columns:2,items:[{title:'A',text:'简单'},{title:'B',text:'灵活'}]}]}}):say('看你更重视哪一项。')
  })
  const snapshot=await f.send('用图文比较两个方案')
  const file=snapshot.messages.find(m=>m.attachments?.length)?.attachments[0]
  assert.match(file.name,/\.orivii\.json$/)
  assert.equal((await f.host.vault.read()).catalog.files.length,1)
})

test('real HTML creation, followup edits and returning to chat use different tool routes',async t=>{
  let round=0
  const f=await fixture(t,o=>{
    round++
    if(round===1||round===3){
      assert.ok(o.tools.some(t=>t.name==='create_chat_file'))
      return tool('create_chat_file',{name:round===1?'example.html':'edited.html',text:'<section data-bubble>真实内容</section>'})
    }
    if(round===5)assert.ok(!o.tools.some(t=>t.name==='create_chat_file'))
    return say(round===5?'听起来不错呀。':'做好了。')
  })
  let snapshot=await f.send('生成一个 HTML 文件')
  assert.equal(snapshot.messages.find(m=>m.attachments?.length).attachments[0].name,'example.html')
  snapshot=await f.send('改成蓝色')
  const edited=snapshot.messages.find(m=>m.attachments?.[0].name==='edited.html').attachments[0]
  const contents=await f.call('fileRead',{id:edited.id})
  assert.equal(Buffer.from(contents.data,'base64').toString(),'<section data-bubble>真实内容</section>')
  await f.send('今天心情不错')
  assert.equal(f.requests.length,5)
})
