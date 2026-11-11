import {DotError} from './vault.js'

// Read only the model-facing projection. Registry definitions contain executable
// callbacks and private presentation data; those do not belong in discovery.
export function registeredTools(services) {
  if(typeof services.tools?.schemas!=='function')return {ready:false,tools:[]}
  try {
    const rows=services.tools.schemas(services.toolScope)
    if(!Array.isArray(rows))return {ready:false,tools:[]}
    const unique=new Map()
    for(const row of rows)if(typeof row?.name==='string'&&row.name.length<=200)unique.set(row.name,{
      name:row.name,description:typeof row.description==='string'?row.description.slice(0,1600):'',
      parameters:row.parameters,
    })
    return {ready:true,tools:[...unique.values()].sort((a,b)=>a.name.localeCompare(b.name))}
  }catch{return {ready:false,tools:[]}}
}

export const capabilityTools=[{
  name:'discover_dsh_tools',
  description:'实时发现当前 DSH 环境全部已注册的模型工具。按 query 查找功能，offset 翻页；传 names 获取指定工具的完整参数。遇到 B站、办公或其他插件需求先查这里，再按 execution 路径执行。registered 表示接口存在，登录和执行结果以实际调用为准。',
  parameters:{type:'object',properties:{query:{type:'string',maxLength:200},names:{type:'array',items:{type:'string',maxLength:200},maxItems:5},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:30}},additionalProperties:false},
}]

function terms(query){
  const words=query.toLowerCase().split(/[\s,，、]+/u).filter(Boolean)
  if(/b站|哔哩|bili/iu.test(query))words.push('bili','bilibili')
  if(/办公|office|文档|ppt|excel|word/iu.test(query))words.push('office','document','presentation','spreadsheet','ppt','excel','word')
  return words
}

export function discoverTools(services,args={}, {directNames=[]}={}) {
  const {query='',names=[],offset=0,limit=20}=args||{}
  if(typeof query!=='string'||query.length>200||!Array.isArray(names)||names.length>5||names.some(n=>typeof n!=='string'||n.length>200)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>30)throw new DotError('请提供工具关键词或名称，并使用有效的分页范围。')
  const current=registeredTools(services),words=terms(query),selected=current.tools.filter(t=>names.length?names.includes(t.name):!words.length||words.some(w=>(t.name+' '+t.description).toLowerCase().includes(w)))
  let remaining=24000
  const items=selected.slice(offset,offset+limit).map(t=>{
    const execution=directNames.includes(t.name)||(t.name==='bili_watch'&&directNames.includes('read_bilibili_video'))?'background_research(domain=web)':services.workspaceTasks?'delegate_workspace_task':'host_agent'
    const item={name:t.name,description:t.description.slice(0,800),status:'registered',execution}
    if(names.length){
      const encoded=JSON.stringify(t.parameters??{})
      if(encoded.length<=remaining){item.parameters=JSON.parse(encoded);remaining-=encoded.length}
      else item.parametersOmitted='schema_too_large_use_host_agent'
    }
    return item
  })
  return {registryReady:current.ready,scope:'current_dsh_host',total:current.tools.length,matched:selected.length,items,nextOffset:offset+items.length<selected.length?offset+items.length:null,missing:names.filter(n=>!current.tools.some(t=>t.name===n)),services:{web:Boolean(services.web),browser:Boolean(services.browser),workspaceTasks:Boolean(services.workspaceTasks)},note:current.ready?'这是当前宿主实时注册的模型工具。仅提供网页或内部服务的插件，需由其公开适配器或 DSH 工作任务接入。':'当前工具注册表尚未就绪；这是检测状态，不能据此判定插件未安装。'}
}

export function capabilityContext(services,{directNames=[]}={}) {
  const current=registeredTools(services)
  const names=current.tools.map(t=>t.name),sample=names.join(', ').slice(0,2800)
  return '\n当前 DSH 插件能力（每次请求重新检测）：'+JSON.stringify({registryReady:current.ready,registeredToolCount:names.length,toolNames:sample,more:names.join(', ').length>2800,backgroundReadTools:directNames})+
    '\n需要插件能力时先用 discover_dsh_tools 查关键词，必要时按名称查看参数。以当前结果判断接口是否存在，历史聊天中的“没有接口”可能已经过期。公开资料读取可交给 background_research；其他办事需求沿用 DSH 工作区任务和宿主权限。接口注册、账号登录与调用成功是不同状态，答复依据实际检测和调用结果。工具目录与参数保留在内部，面向用户自然说明结果。B站视频截图直接用 capture_bilibili_frame，自动通过插件抽帧并保存为本地图片编号；发送已保存图片用 list_chat_files 查编号，再用 send_chat_image。询问连接或登录时调用 check_bilibili_connection，连接卡片由界面展示。Web 与 Desktop 分别加载插件；普通网页读取不携带插件凭据，验证码页只代表该次网页读取受限。'
}
