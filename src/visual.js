import {VISUAL_ICONS} from './visual-icons.js'
import {CANVAS_RATIOS} from './canvas.js'
export const VISUAL_TEMPLATES={explain:{label:'图解',icon:'book-open'},compare:{label:'对比',icon:'columns-2'},metrics:{label:'指标',icon:'chart-column'},steps:{label:'流程',icon:'list-ordered'},chart:{label:'数据',icon:'chart-line'},explore:{label:'交互',icon:'sliders-horizontal'}}
const visualId=/^[a-z][a-z0-9_]{0,39}$/
const visualIcon=value=>{if(typeof value!=='string'||!Object.hasOwn(VISUAL_ICONS,value))throw new Error('图标名称无效。');return value}
const visualObject=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('图文卡片字段无效。');return value}
const visualText=(value,max=500)=>{if(typeof value!=='string'||value.length>max)throw new Error('图文卡片文字过长或格式无效。');return value}
const visualNumber=value=>{if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)throw new Error('图文卡片数值无效。');return value}
const visualArray=(value,max)=>{if(!Array.isArray(value)||!value.length||value.length>max)throw new Error('图文卡片项目数量无效。');return value}
const visualName=value=>{if(typeof value!=='string'||!visualId.test(value)||['constructor','prototype','__proto__'].includes(value))throw new Error('图文卡片标识无效。');return value}
const visualScalar=(value,known)=>{
  if(typeof value==='string')return visualText(value)
  if(typeof value==='number')return visualNumber(value)
  visualObject(value,['ref']);visualName(value.ref);if(!known.has(value.ref))throw new Error('图文卡片引用尚未定义。');return {ref:value.ref}
}
const visualNumeric=(value,known)=>{if(typeof value==='string')throw new Error('图表数值须为数字或控件引用。');return visualScalar(value,known)}

export function validateVisualSpec(input){
  if(JSON.stringify(input).length>100000)throw new Error('图文卡片内容过大。')
  visualObject(input,['version','title','description','demo','template','ratio','controls','calculations','blocks','sources'])
  if(input.version!==1)throw new Error('图文卡片版本无效。')
  const result={version:1,title:visualText(input.title,120),blocks:[]},known=new Set()
  if(input.template!==undefined){if(!Object.hasOwn(VISUAL_TEMPLATES,input.template))throw new Error('图文模板无效。');result.template=input.template}
  if(input.ratio!==undefined){if(!CANVAS_RATIOS.includes(input.ratio))throw new Error('画布比例无效。');result.ratio=input.ratio}
  if(input.description!==undefined)result.description=visualText(input.description,600)
  if(input.demo!==undefined){if(typeof input.demo!=='boolean')throw new Error('演示标记无效。');result.demo=input.demo}
  if(input.controls!==undefined)result.controls=visualArray(input.controls,8).map(control=>{
    visualObject(control,['id','type','label','value','min','max','step','options'])
    const id=visualName(control.id),label=visualText(control.label,80)
    if(known.has(id))throw new Error('图文卡片标识重复。')
    let next
    if(control.type==='slider'){
      const min=visualNumber(control.min),max=visualNumber(control.max),value=visualNumber(control.value),step=visualNumber(control.step??1)
      if(max<=min||value<min||value>max||step<=0||step>max-min)throw new Error('滑块范围无效。')
      next={id,label,type:'slider',min,max,step,value}
    }else if(control.type==='toggle'){
      if(typeof control.value!=='boolean')throw new Error('开关值无效。');next={id,label,type:'toggle',value:control.value}
    }else if(control.type==='select'){
      const options=visualArray(control.options,8).map(option=>{visualObject(option,['label','value']);return {label:visualText(option.label,60),value:visualNumber(option.value)}})
      if(!options.some(option=>option.value===control.value))throw new Error('选择值无效。')
      next={id,label,type:'select',value:control.value,options}
    }else throw new Error('控件类型无效。')
    known.add(id);return next
  })
  if(input.calculations!==undefined)result.calculations=visualArray(input.calculations,12).map(calculation=>{
    visualObject(calculation,['id','op','inputs']);const id=visualName(calculation.id)
    if(known.has(id)||!['add','subtract','multiply','divide','power'].includes(calculation.op))throw new Error('计算项无效。')
    const inputs=visualArray(calculation.inputs,8).map(value=>visualNumeric(value,known))
    if(['subtract','divide','power'].includes(calculation.op)&&inputs.length!==2)throw new Error('计算项参数数量无效。')
    known.add(id);return {id,op:calculation.op,inputs}
  })
  result.blocks=visualArray(input.blocks,12).map(block=>{
    const type=block.type
    if(type==='text'){visualObject(block,['type','text']);return {type,text:visualText(block.text,4000)}}
    if(type==='metrics'){
      visualObject(block,['type','items']);return {type,items:visualArray(block.items,12).map(item=>{
        visualObject(item,['label','value','unit','hint','digits','icon']);const next={label:visualText(item.label,100),value:visualScalar(item.value,known)}
        if(item.icon!==undefined)next.icon=visualIcon(item.icon)
        for(const key of ['unit','hint'])if(item[key]!==undefined)next[key]=visualText(item[key],key==='hint'?300:40)
        if(item.digits!==undefined){if(!Number.isInteger(item.digits)||item.digits<0||item.digits>8)throw new Error('小数位数无效。');next.digits=item.digits}return next
      })}
    }
    if(type==='cards'){
      visualObject(block,['type','columns','items']);if(block.columns!==undefined&&![1,2,3].includes(block.columns))throw new Error('卡片列数无效。')
      return {type,columns:block.columns||2,items:visualArray(block.items,8).map(item=>{visualObject(item,['title','text','icon']);return {title:visualText(item.title,120),text:visualText(item.text,2000),...(item.icon!==undefined?{icon:visualIcon(item.icon)}:{})}})}
    }
    if(type==='table'){
      visualObject(block,['type','columns','rows']);const columns=visualArray(block.columns,8).map(value=>visualText(value,100))
      const rows=visualArray(block.rows,40).map(row=>{if(!Array.isArray(row)||row.length!==columns.length)throw new Error('表格列数不一致。');return row.map(value=>visualScalar(value,known))})
      return {type,columns,rows}
    }
    if(type==='chart'){
      visualObject(block,['type','kind','title','labels','series','unit'])
      if(!['bar','line'].includes(block.kind))throw new Error('图表类型无效。')
      const labels=visualArray(block.labels,40).map(value=>visualText(value,80)),series=visualArray(block.series,4).map(row=>{
        visualObject(row,['name','values']);if(!Array.isArray(row.values)||row.values.length!==labels.length)throw new Error('图表数据长度不一致。')
        return {name:visualText(row.name,80),values:row.values.map(value=>visualNumeric(value,known))}
      })
      return {type,kind:block.kind,title:visualText(block.title??'',120),labels,series,unit:visualText(block.unit??'',40)}
    }
    if(type==='flow'){
      visualObject(block,['type','items']);return {type,items:visualArray(block.items,8).map(item=>{visualObject(item,['title','text','icon']);return {title:visualText(item.title,120),text:visualText(item.text??'',600),...(item.icon!==undefined?{icon:visualIcon(item.icon)}:{})}})}
    }
    if(type==='svg'){visualObject(block,['type','source','caption']);return {type,source:visualText(block.source,40000),caption:visualText(block.caption??'',300)}}
    throw new Error('图文卡片组件类型无效。')
  })
  if(input.sources!==undefined)result.sources=visualArray(input.sources,8).map(source=>visualText(source,500))
  return result
}

export function visualValues(spec,controls={}){
  const values=new Map()
  for(const control of spec.controls||[]){
    const candidate=controls[control.id]??control.value
    let value=control.value
    if(control.type==='toggle')value=typeof candidate==='boolean'?candidate:control.value
    else if(Number.isFinite(candidate))value=control.type==='slider'?Math.max(control.min,Math.min(control.max,candidate)):control.options.some(option=>option.value===candidate)?candidate:control.value
    values.set(control.id,typeof value==='boolean'?Number(value):value)
  }
  const resolve=value=>value&&typeof value==='object'?values.get(value.ref):value
  for(const c of spec.calculations||[]){
    const args=c.inputs.map(resolve);let value=null
    if(args.every(x=>typeof x==='number'&&Number.isFinite(x))){
      if(c.op==='add')value=args.reduce((a,b)=>a+b,0)
      if(c.op==='multiply')value=args.reduce((a,b)=>a*b,1)
      if(c.op==='subtract')value=args[0]-args[1]
      if(c.op==='divide'&&args[1]!==0)value=args[0]/args[1]
      if(c.op==='power'&&Math.abs(args[1])<=12)value=args[0]**args[1]
    }
    values.set(c.id,Number.isFinite(value)&&Math.abs(value)<=1e12?value:null)
  }
  return {values,resolve}
}
export function visualSummary(spec){
  const {resolve}=visualValues(spec),lines=[(spec.demo?'演示图示：':'图示：')+spec.title,spec.description||'']
  for(const block of spec.blocks){
    if(block.type==='text')lines.push(block.text)
    if(block.type==='metrics')lines.push(...block.items.map(item=>item.label+'：'+(resolve(item.value)??'—')+(item.unit||'')))
    if(block.type==='cards'||block.type==='flow')lines.push(...block.items.map(item=>item.title+'：'+item.text))
    if(block.type==='table')lines.push(block.columns.join(' / '),...block.rows.map(row=>row.map(resolve).join(' / ')))
    if(block.type==='chart')lines.push(block.title+' '+block.labels.join(' / '),...block.series.map(row=>row.name+'：'+row.values.map(resolve).join(', ')+' '+block.unit))
    if(block.type==='svg')lines.push(block.caption||'SVG 图示')
  }
  return lines.filter(Boolean).join('\n').slice(0,8000)
}
export function filePreviewKind(file){if(file.preview==='visual'||/\.orivii\.json$/i.test(file.name))return 'visual';if(/\.html?$/i.test(file.name))return 'html';if(/\.svg$/i.test(file.name))return 'svg';return null}

const visualSchemaScalar={anyOf:[{type:'string',maxLength:500},{type:'number'},{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false}]}
const visualSchemaNumber={anyOf:[{type:'number'},{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false}]}
const visualSchemaItem=(properties,required)=>({type:'object',properties,required,additionalProperties:false})
const visualSchemaString={type:'string'}
const visualSchemaIcon={type:'string',enum:Object.keys(VISUAL_ICONS)}
export const VISUAL_TOOLS=[{name:'present_visual',description:'选择固定模板并填入内容，展示气泡内完整的图文内容。template=explain 图解、compare 对比、metrics 指标、steps 流程、chart 数据、explore 交互。宽度跟随气泡，高度随内容自然展开，背景透明。每份内容讲清一个主题；内容较多时客户端按完整内容块新增聊天气泡。title 仅作内部识别，直接呈现内容。填 blocks 与 controls 即可；卡片、指标、流程的 icon 选内置 Lucide 名称。demo 标记演示数据，真实资料给 sources。version=1；value 可为数字、文字或 {ref:id}，calculations 支持 add/subtract/multiply/divide/power。',parameters:visualSchemaItem({spec:visualSchemaItem({
  version:{type:'integer',enum:[1]},title:{type:'string',maxLength:120},description:{type:'string',maxLength:600},demo:{type:'boolean'},template:{type:'string',enum:Object.keys(VISUAL_TEMPLATES)},
  controls:{type:'array',maxItems:8,items:visualSchemaItem({id:visualSchemaString,type:{type:'string',enum:['slider','select','toggle']},label:visualSchemaString,value:{anyOf:[{type:'number'},{type:'boolean'}]},min:{type:'number'},max:{type:'number'},step:{type:'number'},options:{type:'array',items:visualSchemaItem({label:visualSchemaString,value:{type:'number'}},['label','value'])}},['id','type','label','value'])},
  calculations:{type:'array',maxItems:12,items:visualSchemaItem({id:visualSchemaString,op:{type:'string',enum:['add','subtract','multiply','divide','power']},inputs:{type:'array',items:visualSchemaNumber,maxItems:8}},['id','op','inputs'])},
  blocks:{type:'array',minItems:1,maxItems:12,items:{anyOf:[
    visualSchemaItem({type:{type:'string',enum:['text']},text:visualSchemaString},['type','text']),
    visualSchemaItem({type:{type:'string',enum:['metrics']},items:{type:'array',items:visualSchemaItem({label:visualSchemaString,value:visualSchemaScalar,unit:visualSchemaString,hint:visualSchemaString,digits:{type:'integer',minimum:0,maximum:8},icon:visualSchemaIcon},['label','value'])}},['type','items']),
    visualSchemaItem({type:{type:'string',enum:['cards']},columns:{type:'integer',enum:[1,2,3]},items:{type:'array',items:visualSchemaItem({title:visualSchemaString,text:visualSchemaString,icon:visualSchemaIcon},['title','text'])}},['type','items']),
    visualSchemaItem({type:{type:'string',enum:['table']},columns:{type:'array',items:visualSchemaString},rows:{type:'array',items:{type:'array',items:visualSchemaScalar}}},['type','columns','rows']),
    visualSchemaItem({type:{type:'string',enum:['chart']},kind:{type:'string',enum:['bar','line']},title:visualSchemaString,labels:{type:'array',items:visualSchemaString},series:{type:'array',items:visualSchemaItem({name:visualSchemaString,values:{type:'array',items:visualSchemaNumber}},['name','values'])},unit:visualSchemaString},['type','kind','labels','series']),
    visualSchemaItem({type:{type:'string',enum:['flow']},items:{type:'array',items:visualSchemaItem({title:visualSchemaString,text:visualSchemaString,icon:visualSchemaIcon},['title'])}},['type','items']),
    visualSchemaItem({type:{type:'string',enum:['svg']},source:visualSchemaString,caption:visualSchemaString},['type','source']),
  ]}},sources:{type:'array',items:visualSchemaString,maxItems:8},
},['version','title','blocks'])},['spec'])}]
export function visualPrompt(enabled=true,{allowFileCreation=false}={}){
  return '\n对话表达：日常交流直接用自然的文字气泡接话，回应眼前的话题；资料查询通常用简洁正文说明结果。'+
    (enabled?'当图形能明显帮助理解界面、机制、数据、流程或多项对比时，优先用原生图文模板或真实截图说明。':'默认用文字解释，用户请求图示时使用图文能力。')+
    '图文用 present_visual 选择固定模板填内容：explain 图解、compare 双栏对比、metrics 指标、steps 流程、chart 数据、explore 交互；特殊图形可放入 svg block。图文作为聊天内容直接放入气泡，保持正常字号，每个完整内容块占一个气泡，内容较多时接续新气泡。外层圆角和底色由聊天气泡提供，内部透明、平直排版；文字沿用气泡前景色，图表保持清晰对比。title 仅作内部识别，可见内容从图形、数据或正文开始，到内容本身结束。'+
    (allowFileCreation?'本次包含用户提出的文件、网页或代码交付任务，可用 create_chat_file 生成真实可下载附件。HTML 文件 text 写完整内容，每个独立主题用 <section data-bubble> 包住；聊天预览以内容为主，页面式大标题、页眉、页脚和生成说明留空。布局容器透明、平直排版，色板用 data-color 标明真实色值；<i data-icon="book-open"></i> 插入内置图标。':'')+
    '图片用 send_chat_image 直接发送；已有图片用本地附件 id，工作空间相对路径或公开图片直链也可读取并保存。list_chat_files 按文件名或 BV 号找旧图，跨聊天复用。B站截图用 capture_bilibili_frame，默认先找本地图，再取快速预览，拿到就发送；需要解读时 analyze=true，看清原图细字时 mode=frames。'+
    'present_visual 的 blocks 组合 metrics/cards/table/chart/flow/svg/text；卡片、流程和指标的 icon 选内置 Lucide 名称。controls 放滑块、选项和开关，用 {ref:id} 与 calculations 关联数值。demo=true 标明演示，真实数据写 sources。SVG 用 currentColor、透明背景和正常字号，图表采用柔和配色。'
}
