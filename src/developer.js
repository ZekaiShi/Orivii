// Owner-only diagnostic view. Never persists data or includes hidden reasoning.
export function developerDiff(before,after){
  if(!before||!after)return []
  const rows=[]
  for(const key of Object.keys(after.companion?.axes||{}))if(before.companion?.axes?.[key]!==after.companion.axes[key])rows.push({kind:'人格参数',field:after.companion.axisLabels[key]||key,before:before.companion?.axes?.[key],after:after.companion.axes[key]})
  const labels={preferredName:'称呼',identity:'身份',preferences:'相处偏好'}
  for(const [key,label] of Object.entries(labels)){
    const a=before.profile?.fields?.[key]?.value||'',b=after.profile?.fields?.[key]?.value||''
    if(a!==b)rows.push({kind:'用户印象',field:label,before:a||'未记录',after:b||'未记录'})
  }
  const a=(before.companion?.interests||[]).map(e=>e.topic).join('、'),b=(after.companion?.interests||[]).map(e=>e.topic).join('、')
  if(a!==b)rows.push({kind:'兴趣',field:'话题',before:a||'未记录',after:b||'未记录'})
  for(const [key,label]of [['knowledgeCount','知识'],['memeCount','梗']])if(before[key]!==after[key])rows.push({kind:'长期记录',field:label,before:before[key],after:after[key]})
  return rows
}
export function createDeveloperPanel(React,{rpc,extra=()=>null}){
  const h=React.createElement,{useState,useEffect,useRef}=React
  return function DeveloperPanel({chatId,active=true,onError,onSource}){
    const [enabled,setEnabled]=useState(false),[data,setData]=useState(null),[baseline,setBaseline]=useState(null),[pending,setPending]=useState(false)
    const generation=useRef(0),alive=useRef(false)
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;rpc('developerMode',{enabled:false}).catch(()=>{})}},[])
    useEffect(()=>{generation.current++;setData(null);setBaseline(null)},[chatId])
    useEffect(()=>{if(!active){generation.current++;setEnabled(false);setData(null);setBaseline(null);rpc('developerMode',{enabled:false}).catch(()=>{})}},[active])
    useEffect(()=>{
      if(!enabled||!active)return
      let stopped=false,busy=false;const id=generation.current
      async function poll(){if(stopped||busy||globalThis.document?.hidden)return;busy=true;try{const value=await rpc('developerSnapshot',{chatId});if(!stopped&&alive.current&&id===generation.current)setData(value)}catch(e){if(!stopped&&alive.current&&id===generation.current){setData(null);setEnabled(false);onError(e)}}finally{busy=false}}
      poll();const timer=setInterval(poll,1500)
      return()=>{stopped=true;clearInterval(timer)}
    },[enabled,active,chatId])
    async function toggle(value){
      if(pending)return
      const id=++generation.current;setPending(true);setData(null);setBaseline(null)
      try{await rpc('developerMode',{enabled:value});if(alive.current&&id===generation.current)setEnabled(value);else await rpc('developerMode',{enabled:false})}
      catch(e){if(alive.current&&id===generation.current)onError(e)}finally{if(alive.current)setPending(false)}
    }
    const current=data?.current,companion=current?.companion,request=data?.observation?.request,analysis=data?.observation?.analysis
    const comparison=baseline||data?.observation?.adaptation?.before||analysis?.before
    const diff=developerDiff(comparison,current),phase={responding:'生成回复',searching:'联网查资料',recalling:'查聊天记录',error:'处理失败'}
    const status={queued:'等待后台整理',running:'正在后台整理',complete:'整理完成',incomplete:'部分整理未完成',disabled:'自动整理已关闭'}
    const emotionLabels={joy:'快乐',affection:'亲近',sadness:'悲伤',distress:'痛苦',anger:'生气',fear:'担忧',curiosity:'好奇'}
    const percent=v=>Number.isFinite(v)?Math.round(v*100)+'%':'未捕获'
    const source=id=>id?h('button',{type:'button',className:'dot-text-button',onClick:()=>onSource(id)},'查看原话'):null
    return h('div',{className:'dot-settings dot-developer'},
      extra(),
      h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:enabled,disabled:pending||!active,onChange:e=>toggle(e.target.checked)}),'开启本窗口开发者模式'),
      h('small',null,'默认关闭。离开此面板或锁定后关闭，不保存调试快照，也不向外部服务发送调试数据。'),
      !enabled?null:!data?h('p',{role:'status'},'正在读取本机状态…'):h(React.Fragment,null,
        h('p',null,'这里显示应用保存与注入的状态，不是模型内部权重或隐藏思考。'),
        h('h3',null,'当前运行'),h('p',null,phase[data.phase]||'空闲'),
        request?h('p',null,`${request.provider} / ${request.model} · 第 ${request.step} 次调用 · ${new Date(request.time).toLocaleTimeString()}`):h('p',null,'开启后发送一条消息，才会记录实际调用。'),
        h('p',null,analysis?status[analysis.status]||analysis.status:'尚无后台整理记录'),
        h('h3',null,'人格参数'),h('small',null,companion?.axesLearning==='explicit-dialogue'?'模板提供起点；明确的语气要求会在本轮回复前调整并保存。普通情绪和引用内容不自动改人格。':'当前扩展仍只支持模板或手动调整；需要更新本机扩展。'),
        companion?h('div',{className:'dot-dev-table'},h('div',{className:'dot-dev-axis'},h('span',null,'维度'),h('span',null,'当前'),h('span',null,'上次实际注入')),
          ...Object.entries(companion.axes).map(([key,value])=>h('div',{className:'dot-dev-axis',key},h('span',null,companion.axisLabels[key]),h('span',null,percent(value)),h('span',null,percent(request?.context?.companion?.axes?.[key]))))):h('p',null,'本地扩展不支持状态观测。'),
        h('h3',null,'对用户当前情绪的估计'),h('small',null,'不是 Orivii 自己的感受；仅有出处的当前事件参与计算，数值也会随时间衰减。'),
        ...Object.entries(companion?.emotions||{}).map(([key,value])=>h('label',{key,className:'dot-dev-meter'},h('span',null,emotionLabels[key]||key),h('meter',{min:0,max:1,value,'aria-label':emotionLabels[key]||key}),h('span',null,percent(value)))),
        h('h3',null,'对话是否带来变化'),
        h('button',{type:'button',className:'dot-text-button',onClick:()=>setBaseline(structuredClone(current))},'设为对比起点'),
        h('small',null,baseline?'与本窗口设定的起点比较。':data?.observation?.adaptation?'与本轮语气调整前比较。':'默认与最近一次后台整理前比较；没有变化就如实显示。'),
        ...diff.map((r,i)=>h('article',{key:i,className:'dot-memory-entry'},h('strong',null,r.kind+' · '+r.field),h('p',null,String(r.before)+' → '+String(r.after)))),
        !diff.length?h('p',null,comparison?'尚无人格参数、偏好或兴趣变化。':'尚无对比记录。'):null,
        h('details',{className:'dot-advanced'},h('summary',null,'最近说话方式调整'),...(companion?.styleChanges||[]).slice().reverse().map((e,i)=>h('article',{key:i,className:'dot-memory-entry'},h('small',null,new Date(e.time).toLocaleString()+' · '+(e.origin==='settings'?'本机设置':'对话中的明确要求')),...e.changes.map(v=>h('p',{key:v.axis},`${companion.axisLabels[v.axis]}：${percent(v.before)} → ${percent(v.after)}`)),source(e.sourceId)))),
        h('details',{className:'dot-advanced'},h('summary',null,'实际使用的相处偏好'),
          ...['preferredName','identity','preferences'].map(key=>h('article',{key,className:'dot-memory-entry'},h('strong',null,{preferredName:'称呼',identity:'身份',preferences:'偏好'}[key]),h('p',null,'当前：'+(current.profile?.fields?.[key]?.value||'未记录')),h('p',null,'上次注入：'+(request?.context?.profile?.fields?.[key]?.value||'未捕获或无记录')),source(current.profile?.fields?.[key]?.sourceIds?.[0]))),
          h('p',null,'当前兴趣：'+((companion?.interests||[]).map(e=>e.topic).join('、')||'未记录')),h('p',null,'上次注入兴趣：'+((request?.context?.companion?.interests||[]).slice(0,12).map(e=>e.topic).join('、')||'未捕获或无记录'))),
        h('details',{className:'dot-advanced'},h('summary',null,'最近情绪事件的依据'),...(companion?.events||[]).slice().reverse().map(e=>h('article',{key:e.id,className:'dot-memory-entry'},h('p',null,e.text),h('small',null,`${e.subject} · ${e.temporalScope} · 置信度 ${percent(e.confidence)} · ${e.enabled?'启用':'停用'}`),source(e.sourceIds?.[0])))),
        h('details',{className:'dot-advanced'},h('summary',null,'本轮表情事件'),...(data.presentations||[]).map(e=>h('p',{key:e.id},new Date(e.time).toLocaleTimeString()+' · '+e.expression)))
      ))
  }
}
