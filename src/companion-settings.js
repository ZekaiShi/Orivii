// Settings presentation only. Assistant orchestration runs on Host.
export function createCompanionSettings(React,{rpc,markdown,download=downloadCard}){
  const h=React.createElement,{useState,useEffect,useRef}=React
  return function CompanionSettings({section='persona',onError,onSource:source,onMemories}){
    const [data,setData]=useState(null),[card,setCard]=useState(null),[policy,setPolicy]=useState({})
    const [pending,setPending]=useState(false),[notice,setNotice]=useState(''),[events,setEvents]=useState([])
    const [pass,setPass]=useState(''),[payload,setPayload]=useState(''),[filename,setFilename]=useState('')
    const alive=useRef(false),epoch=useRef(0),guard=useRef(false)
    const command=request=>rpc('extension',{request})
    const current=id=>alive.current&&epoch.current===id
    async function load(reset=false){const id=epoch.current,value=await command({operation:'view',section});if(!current(id))return;setData(value);if(reset){setCard(value.card||null);setPolicy(value.policy||{})}}
    useEffect(()=>{
      alive.current=true;const id=++epoch.current;setData(null);setPass('');setPayload('');setFilename('');setNotice('');setEvents([])
      load(true).catch(e=>{if(current(id))onError(e)})
      return()=>{alive.current=false;epoch.current++}
    },[section])
    useEffect(()=>{
      if(section!=='tasks')return
      let stopped=false,busy=false
      const timer=setInterval(async()=>{if(stopped||busy||globalThis.document?.hidden)return;busy=true;try{await load()}catch(e){if(!stopped&&alive.current)onError(e)}finally{busy=false}},2500)
      return()=>{stopped=true;clearInterval(timer)}
    },[section])
    async function act(fn){if(guard.current)return;guard.current=true;setPending(true);setNotice('');const id=epoch.current;try{await fn(id)}catch(e){if(current(id))onError(e)}finally{guard.current=false;if(current(id))setPending(false)}}
    const button=(label,fn,disabled=false)=>h('button',{type:'button',className:'dot-text-button',disabled:pending||disabled,onClick:()=>act(fn)},label)
    const field=(label,node)=>h('label',null,h('span',null,label),node)
    async function savePolicy(changes,id){if(!Object.keys(changes).length)return;await command({operation:'savePolicy',policy:changes});if(current(id)){setData(d=>({...d,policy:{...d.policy,...changes}}));setPolicy(p=>({...p,...changes}));setNotice('已保存。')}}
    const check=(key,label)=>h('label',{className:'dot-check'},h('input',{type:'checkbox',disabled:pending,checked:policy[key]!==false,onChange:e=>{const checked=e.target.checked;act(id=>savePolicy({[key]:checked},id))}}),label)
    async function eventList(){const id=epoch.current,value=await command({operation:'events'});if(current(id))setEvents(value)}
    async function selectFile(event){
      const file=event.target.files?.[0];event.target.value='';if(!file)return
      await act(async id=>{if(file.size>64000)throw new Error('偏好文件过大。');const text=await file.text();if(current(id)){setPayload(text);setFilename(file.name)}})
    }
    if(!data)return h('p',{role:'status'},'正在打开…')
    const status={queued:'等待开始',running:'正在处理',done:'已有回复',failed:'未能完成',interrupted:'已中断',cancelled:'已停止'}
    const changes=Object.fromEntries(Object.entries(policy).filter(([k,v])=>v!==data.policy?.[k]))
    return h('div',{className:'dot-settings dot-companion-settings'},
      notice?h('p',{role:'status'},notice):null,
      section==='persona'&&card?h(React.Fragment,null,
        data.growth?h('details',{className:'dot-advanced'},h('summary',null,'相处节奏'),
          field('相处模式',h('select',{value:data.growth.mode,disabled:pending,onChange:e=>{const mode=e.target.value;act(async()=>{const growth=await command({operation:'saveGrowth',growth:{mode}});setData(d=>({...d,growth}))})}},h('option',{value:'assistant'},'得力助手'),h('option',{value:'autonomous'},'自主相处'))),
          h('small',null,'自主相处允许拒绝普通请求；你可以随时切回。两种模式都遵守停止指令和工具授权。'),
          field('俏皮嘴硬的程度',h('input',{type:'range',min:0,max:1,step:.1,value:data.growth.tsundere,disabled:pending,onChange:e=>{const tsundere=Number(e.target.value);act(async()=>{const growth=await command({operation:'saveGrowth',growth:{tsundere}});setData(d=>({...d,growth}))})}})),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:data.growth.learning,disabled:pending,onChange:e=>{const learning=e.target.checked;act(async()=>{const growth=await command({operation:'saveGrowth',growth:{learning}});setData(d=>({...d,growth}))})}}),'在相处中慢慢调整倾向')):null,
        field('相处风格',h('select',{disabled:pending,value:card.template,onChange:e=>{const t=data.templates.find(t=>t.id===e.target.value);setCard(c=>({...c,template:t.id,label:t.label,axes:{...t.axes}}))}},...data.templates.map(t=>h('option',{key:t.id,value:t.id},t.label)))),
        field('你希望怎样相处',h('textarea',{disabled:pending,value:card.description,maxLength:2000,rows:4,placeholder:'比如：说话随意一些，偶尔斗嘴；我难过时认真听我说。',onChange:e=>setCard(c=>({...c,description:e.target.value}))})),
        h('details',{className:'dot-advanced'},h('summary',null,'细调表达方式'),
          ...Object.entries(data.axes).map(([key,label])=>h('label',{key,className:'dot-persona-axis'},h('span',null,label),h('input',{disabled:pending,type:'range',min:0,max:1,step:.05,value:card.axes[key],'aria-label':label,onChange:e=>setCard(c=>({...c,axes:{...c.axes,[key]:Number(e.target.value)}}))}))),
          field('感兴趣的话题（每行一个）',h('textarea',{disabled:pending,value:card.interests.join('\n'),maxLength:3200,onChange:e=>setCard(c=>({...c,interests:e.target.value.split('\n')}))})),
          field('说话示例（每行一条）',h('textarea',{disabled:pending,value:card.examples.join('\n'),maxLength:4000,onChange:e=>setCard(c=>({...c,examples:e.target.value.split('\n')}))}))),
        button('保存相处方式',async id=>{const saved=await command({operation:'saveCard',card});if(current(id)){setCard(saved);setData(d=>({...d,card:saved}));setNotice('已保存。')}},JSON.stringify(card)===JSON.stringify(data.card))):null,
      section==='care'?h(React.Fragment,null,
        check('enabled','有事时可以给我发消息'),
        h('p',null,'想让我到时叫你，聊天里告诉我就好。改时间、取消，也直接跟我说。'),
        h('details',{className:'dot-advanced'},h('summary',null,'少打扰时段'),
          ...[['quietStart','开始时间'],['quietEnd','结束时间']].map(([key,label])=>h('label',{key},label,h('input',{disabled:pending,type:'time',value:policy[key],onChange:e=>setPolicy(p=>({...p,[key]:e.target.value}))}))),
          h('p',null,'平时会避开这个时段；你明确约好的提醒仍按约定时间送达。'),
          field('所在时区',h('input',{disabled:pending,value:policy.timeZone,maxLength:80,onChange:e=>setPolicy(p=>({...p,timeZone:e.target.value}))})),
          button('保存时间偏好',id=>savePolicy(changes,id),!Object.keys(changes).length)),
        h('small',null,'需要 DSH 保持运行，并且 Orivii 已解锁。')):null,
      section==='tasks'?h(React.Fragment,null,
        !data.tasks.length?h('p',null,'需要我帮忙做事时，直接在聊天里交代就好。进展和回复会留在这里。'):null,
        ...data.tasks.slice().reverse().map(t=>h('article',{key:t.id,className:'dot-memory-entry'},h('strong',null,t.text.slice(0,100)),h('small',null,status[t.status]||'等待更新'),h('details',{open:['queued','running'].includes(t.status)},h('summary',null,'查看工作记录'),...t.messages.map((m,i)=>h('div',{key:i,className:'dot-task-message'},h('small',null,m.role==='user'?'你':'助手'),markdown(m.text)))),t.error?h('p',null,t.error):null,['queued','running'].includes(t.status)?button('停止这项工作',async()=>{await command({operation:'taskCancel',id:t.id});await load()}):null))):null,
      section==='privacy'?h(React.Fragment,null,
        check('analysisEnabled','留意我的近况与安排'),check('allowTasks','允许帮我在后台办事'),
        h('small',null,'工作记录单独保存在 DSH 中，不包含私人聊天和个人偏好。'),
        h('p',null,data.encrypted?'这份资料已由工作空间密码保护。':'当前工作空间采用明文保存，有目录权限的程序可以读取。'),
        data.personaAvailable!==false?h('details',{className:'dot-advanced'},h('summary',null,'偏好备份与导入'),
          field('备份密码',h('input',{disabled:pending,type:'password',autoComplete:'new-password',value:pass,maxLength:1024,placeholder:'至少 10 个字符',onChange:e=>setPass(e.target.value)})),
          button('导出加密备份',async id=>{const result=await command({operation:'exportCard',password:pass});if(current(id)){download(result.encryptedCard);setPass('');setNotice('偏好已导出，不包含聊天记录。')}},pass.length<10),
          field('选择备份或社区模板',h('input',{disabled:pending,type:'file',accept:'.json,.dotcard,application/json','aria-label':'选择备份或社区模板',onChange:selectFile})),
          filename?h('small',null,filename):null,
          button('导入这份偏好',async id=>{let encrypted;try{encrypted=JSON.parse(payload)?.format==='dot-persona-card'}catch{throw new Error('偏好文件格式不正确。')}await command(encrypted?{operation:'importCard',password:pass,encryptedCard:payload}:{operation:'importTemplate',json:payload});if(current(id)){setPass('');setPayload('');setFilename('');setNotice('偏好已导入。')}},!payload)):null,
        h('details',{className:'dot-advanced'},h('summary',null,'管理与修正资料'),
          onMemories?button('查看聊过的重要内容',onMemories):null,
          data.personaAvailable!==false?button('修正对近况的理解',eventList):null,
          ...events.slice().reverse().map(e=>h('article',{key:e.id,className:'dot-memory-entry'},h('textarea',{disabled:pending,value:e.text,maxLength:1000,onChange:event=>setEvents(rows=>rows.map(row=>row.id===e.id?{...row,text:event.target.value}:row))}),button('保存修正',async()=>{await command({operation:'event',id:e.id,text:e.text,enabled:e.enabled});await eventList()}),button(e.enabled?'不再据此理解我':'重新使用',async()=>{await command({operation:'event',id:e.id,enabled:!e.enabled});await eventList()}),button('查看原话',()=>source(e.sourceIds[0])))))):null)
  }
}
function downloadCard(text){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a')
  link.href=url;link.download='Orivii-preferences.dotcard';link.hidden=true;document.body.append(link)
  try{link.click()}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
}
