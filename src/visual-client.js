export function createVisualRenderer(React,{markdown,markup}){
  const h=React.createElement,colors=['#a68bdf','#78b9a9','#edab80','#88acd7']
  const Icon=createVisualIcon(React)
  const textParts=text=>{
    if(text.length<=180||/[*_`\[\]|]/.test(text))return [text]
    const sentences=text.match(/[\s\S]*?(?:[。！？，；]|[.!?,;](?=\s|$)|\n\s*\n|$)/g)?.filter(Boolean)||[text],parts=[];let current=''
    for(const sentence of sentences){if(current&&current.length+sentence.length>180){parts.push(current);current=''}current+=sentence}
    if(current)parts.push(current);return parts
  }
  const display=(value,digits)=>value===null||value===undefined?'—':typeof value==='number'?digits===undefined?new Intl.NumberFormat(undefined,{maximumFractionDigits:6}).format(value):value.toFixed(digits):String(value)
  function Chart({block,resolve}){
    const element=React.useRef(null),[size,setSize]=React.useState(560)
    React.useLayoutEffect(()=>{const node=element.current,win=node?.ownerDocument?.defaultView;if(!win)return;const update=()=>{const width=Math.round(node.clientWidth);if(width>0)setSize(width)};update();const observer=win.ResizeObserver?new win.ResizeObserver(update):null;observer?.observe(node);return()=>observer?.disconnect()},[])
    const rows=block.series.map(series=>({...series,values:series.values.map(resolve)})),numbers=rows.flatMap(row=>row.values).filter(Number.isFinite)
    const low=Math.min(0,...numbers),high=Math.max(0,...numbers),span=high-low||1,pad=span*.08,min=low-pad,max=high+pad
    const ticks=Array.from({length:4},(_,tick)=>{const value=min+(max-min)*tick/3,magnitude=Math.abs(value);return {value,label:magnitude&&(magnitude<.001||magnitude>=1e6)?value.toExponential(2):display(Number(value.toPrecision(4)))}})
    const x0=Math.max(54,...ticks.map(tick=>tick.label.length*7+16)),y0=20,width=Math.max(1,size-x0-18),height=180
    const y=value=>y0+(max-value)/(max-min)*height,zero=y(0),group=width/block.labels.length,bar=Math.min(44,group*.72/rows.length)
    const items=[]
    ticks.forEach(({value,label},tick)=>{const at=y(value);items.push(h('g',{key:'tick:'+tick},h('line',{x1:x0,y1:at,x2:x0+width,y2:at,className:'dot-chart-grid'}),h('text',{x:x0-9,y:at+4,textAnchor:'end',className:'dot-chart-tick'},label)))})
    rows.forEach((row,s)=>{
      if(block.kind==='line'){
        let pen=false
        const path=row.values.map((value,i)=>{if(!Number.isFinite(value)){pen=false;return ''}const command=pen?'L':'M';pen=true;return `${command}${x0+group*(i+.5)},${y(value)}`}).join(' ')
        items.push(h('path',{key:'line:'+s,d:path,stroke:colors[s],strokeWidth:3,fill:'none',strokeLinecap:'round',strokeLinejoin:'round'}))
      }
      row.values.forEach((value,i)=>{
        if(!Number.isFinite(value))return
        const title=row.name+' · '+block.labels[i]+'：'+display(value)+' '+block.unit
        if(block.kind==='bar')items.push(h('rect',{key:s+':'+i,x:x0+group*(i+.5)+(s-rows.length/2)*bar,y:Math.min(y(value),zero),width:Math.max(1,bar-3),height:Math.max(1,Math.abs(y(value)-zero)),rx:5,fill:colors[s]},h('title',null,title)))
        else items.push(h('circle',{key:s+':'+i,cx:x0+group*(i+.5),cy:y(value),r:4,fill:colors[s]},h('title',null,title)))
      })
    })
    block.labels.forEach((label,i)=>{if(i%Math.ceil(block.labels.length/Math.max(2,Math.floor(size/85)))===0)items.push(h('text',{key:'label:'+i,x:x0+group*(i+.5),y:225,textAnchor:'middle',className:'dot-chart-tick'},h('title',null,label),label.length>8?label.slice(0,7)+'…':label))})
    const dataTable=h('div',{className:'dot-visual-table'},h('table',null,
      h('thead',null,h('tr',null,h('th',null,'项目'),...rows.map((row,i)=>h('th',{key:i},row.name)))),
      h('tbody',null,...block.labels.map((label,i)=>h('tr',{key:i},h('th',{scope:'row'},label),...rows.map((row,s)=>h('td',{key:s},display(row.values[i]))))))))
    return h('section',{ref:element,className:'dot-visual-chart'},block.title?h('h4',null,block.title):null,h('svg',{viewBox:'0 0 '+size+' 245',role:'img','aria-label':block.title||'数值图表'},h('title',null,block.title||'数值图表'),...items),
      h('div',{className:'dot-chart-legend'},...rows.map((row,i)=>h('span',{key:i},h('i',{style:{background:colors[i]}}),row.name)),block.unit?h('small',null,block.unit):null),
      dataTable)
  }
  return function VisualRenderer({spec,wrap,limit=480}){
    spec=React.useMemo(()=>validateVisualSpec(spec),[spec])
    const [controls,setControls]=React.useState(()=>Object.fromEntries((spec.controls||[]).map(control=>[control.id,control.value]))),[copied,setCopied]=React.useState(false)
    const {resolve,values}=visualValues(spec,controls),change=(id,value)=>{setCopied(false);setControls(old=>({...old,[id]:value}))}
    const template=spec.template||(spec.controls?.length?'explore':spec.blocks.some(block=>block.type==='chart')?'chart':'explain'),units=[],add=(key,node,breakBefore=false)=>{if(node)units.push({key,node,breakBefore})}
    if(spec.controls?.length){
      const inputs=spec.controls.map(control=>{
        const input=control.type==='slider'?h('input',{type:'range',min:control.min,max:control.max,step:control.step,value:controls[control.id],'aria-label':control.label,onChange:event=>change(control.id,Number(event.target.value))}):control.type==='toggle'?h('input',{type:'checkbox',checked:controls[control.id],'aria-label':control.label,onChange:event=>change(control.id,event.target.checked)}):h('select',{value:controls[control.id],'aria-label':control.label,onChange:event=>change(control.id,Number(event.target.value))},...control.options.map((option,i)=>h('option',{key:i,value:option.value},option.label)))
        return h('label',{key:control.id},h('span',null,control.label,control.type==='slider'?h('output',null,display(controls[control.id])):null),input)
      })
      add('controls',h('div',{className:'dot-visual-controls'},...inputs))
    }
    spec.blocks.forEach((block,index)=>{
      let node
      if(block.type==='text'){textParts(block.text).forEach((text,i)=>add('block:'+index+':text:'+i,h('div',{className:'dot-visual-text'},markdown(text)),i===0));return}
      if(block.type==='metrics')node=h('div',{className:'dot-visual-metrics'},...block.items.map((item,i)=>h('section',{key:i},h('span',null,item.icon?h(Icon,{name:item.icon}):null,item.label),h('strong',null,display(resolve(item.value),item.digits),item.unit?h('small',null,item.unit):null),item.hint?h('p',null,item.hint):null)))
      if(block.type==='cards'){block.items.forEach((item,i)=>textParts(item.text).forEach((text,part)=>add('block:'+index+':card:'+i+':'+part,h('section',{className:'dot-visual-card'},part===0?h('h4',null,item.title):null,markdown(text)),part===0)));return}
      if(block.type==='table'){
        for(let start=0;start<block.rows.length;start+=4)add('block:'+index+':rows:'+start,h('div',{className:'dot-visual-table'},h('table',null,h('thead',null,h('tr',null,...block.columns.map((label,i)=>h('th',{key:i,scope:'col'},label)))),h('tbody',null,...block.rows.slice(start,start+4).map((row,i)=>h('tr',{key:start+i},...row.map((cell,j)=>h('td',{key:j},display(resolve(cell))))))))),true)
        return
      }
      if(block.type==='chart')node=h(Chart,{block,resolve})
      if(block.type==='flow'){block.items.forEach((item,i)=>add('block:'+index+':step:'+i,h('ol',{className:'dot-visual-flow'},h('li',null,h('span',{className:'dot-visual-step'},item.icon?h(Icon,{name:item.icon}):i+1),h('div',null,h('h4',null,item.title),item.text?h('p',null,item.text):null))),i===0));return}
      if(block.type==='svg')node=h('figure',{className:'dot-visual-svg'},markup(block.source,'svg'),block.caption?h('figcaption',null,block.caption):null)
      add('block:'+index,node,true)
    })
    if(spec.sources?.length)add('sources',h('div',{className:'dot-visual-sources'},...spec.sources.map((source,i)=>h('p',{key:i},source))))
    if(spec.controls?.length)add('copy',h('button',{type:'button',className:'dot-text-button',onClick:async()=>{try{await globalThis.navigator.clipboard.writeText(JSON.stringify({controls,values:Object.fromEntries(values)},null,2));setCopied(true)}catch{setCopied(false)}}},h(Icon,{name:'copy'}),copied?'已复制':'复制当前配置'))
    const measured=React.useRef(new Map()),[layout,setLayout]=React.useState(null),signature=units.map(unit=>unit.key).join('|')
    React.useLayoutEffect(()=>{
      const first=[...measured.current.values()][0],win=first?.ownerDocument?.defaultView;if(!win)return
      const update=()=>{
        const groups=groupBubbleBlocks(units.map(unit=>({height:measured.current.get(unit.key)?.getBoundingClientRect().height||1,breakBefore:unit.breakBefore})),limit),next={signature,groups},value=JSON.stringify(next)
        setLayout(old=>JSON.stringify(old)===value?old:next)
      }
      update();const observer=win.ResizeObserver?new win.ResizeObserver(update):null
      for(const node of measured.current.values())observer?.observe(node)
      return()=>observer?.disconnect()
    },[units,limit])
    const groups=layout?.signature===signature?layout.groups:[units.map((_,i)=>i)]
    const content=groups.map((indices,index)=>{
      const body=h('article',{className:'dot-visual','aria-label':spec.title},h('div',{className:'dot-visual-content','data-template':template},spec.demo&&index===0?h('span',{className:'dot-visual-demo'},'演示数据'):null,...indices.map(i=>{const unit=units[i];return h('div',{key:unit.key,className:'dot-visual-unit',ref:node=>{if(node)measured.current.set(unit.key,node);else measured.current.delete(unit.key)}},unit.node)})))
      return wrap?wrap(body,index):h('div',{key:index},body)
    })
    return h(React.Fragment,null,...content)
  }
}

export function createVisualIcon(React){return function VisualIcon({name,size=17}){const nodes=VISUAL_ICONS[name]||VISUAL_ICONS.info;return React.createElement('svg',{className:'dot-visual-icon',width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},...nodes.map(([tag,attrs],index)=>React.createElement(tag,{...attrs,key:index})))}}

export function createArtifactPreview(React,{rpc,markdown}){
  const h=React.createElement,Icon=createVisualIcon(React),colors=previewColorPolicy()
  const Visual=createVisualRenderer(React,{markdown,markup:(source,format)=>h(ArtifactPreview,{source,format,compact:true})})
  function ArtifactPreview({file,source,format,compact=false,bubble=false,delay=0,onError=()=>{}}){
    const [data,setData]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[theme,setTheme]=React.useState(''),[heights,setHeights]=React.useState([1]),[limit,setLimit]=React.useState(480),root=React.useRef(null),frames=React.useRef([]),channel=React.useRef('')
    React.useEffect(()=>{
      let alive=true
      channel.current='orivii-'+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2))
      frames.current=[];setData(null);setError('');setHeights([1])
      rpc(file?'filePreview':'markupPreview',file?{id:file.id}:{source,format}).then(result=>{if(alive)setData(result)}).catch(()=>{if(alive)setError('预览暂不可用，可下载原文件。')})
      return()=>{alive=false}
    },[file?.id,source,format])
    React.useEffect(()=>{
      const win=root.current?.ownerDocument?.defaultView;if(!win)return
      let measureFrame=0
      const measure=frame=>frame?.contentWindow?.postMessage({type:'orivii:measure',id:channel.current},'*')
      const resize=()=>{setLimit(bubbleContentLimit(win.innerHeight));if(!measureFrame)measureFrame=win.requestAnimationFrame(()=>{measureFrame=0;frames.current.forEach(measure)})},receive=event=>{
        const value=event.data
        const frame=frames.current[value?.part]
        if(event.origin!=='null'||!validCanvasMessage(value,channel.current)||event.source!==frame?.contentWindow)return
        if(frame.clientWidth&&Math.abs(frame.clientWidth-value.width)>1){if(!measureFrame)measureFrame=win.requestAnimationFrame(()=>{measureFrame=0;frames.current.forEach(measure)});return}
        setHeights(old=>{
          const count=value.count
          const next=Array.from({length:count},(_,i)=>old[i]||1);next[value.part]=value.height
          return JSON.stringify(old)===JSON.stringify(next)?old:next
        })
      }
      resize();win.addEventListener('resize',resize);win.addEventListener('message',receive)
      return()=>{if(measureFrame)win.cancelAnimationFrame(measureFrame);win.removeEventListener('resize',resize);win.removeEventListener('message',receive)}
    },[])
    React.useEffect(()=>{
      const doc=root.current?.ownerDocument,win=doc?.defaultView;if(!win)return
      const page=root.current.closest('.dot-page')||root.current,update=()=>{const owner=root.current?.closest('.dot-bubble')||page,palette=colors.theme(win.getComputedStyle(owner).color,win.getComputedStyle(owner,'::before').backgroundColor,win.getComputedStyle(page).backgroundColor);setTheme(':root{--preview-ink:'+palette.ink+'!important;--preview-surface:'+palette.surface+'!important}')}
      update();const observer=win.MutationObserver?new win.MutationObserver(update):null;observer?.observe(doc.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});if(page!==doc.documentElement)observer?.observe(page,{attributes:true,attributeFilter:['class','style']});return()=>observer?.disconnect()
    },[])
    const document=React.useMemo(()=>data?.html?.replace('/*ORIVII_PREVIEW_THEME*/',theme),[data?.html,theme])
    async function save(){if(busy)return;setBusy(true);try{const blob=file?await downloadChatFile(file,rpc):new Blob([source],{type:format==='svg'?'image/svg+xml':format==='visual'?'application/json':'text/html'}),url=URL.createObjectURL(blob),a=globalThis.document.createElement('a');a.href=url;a.download=file?.name||(format==='svg'?'图示.svg':format==='visual'?'图文说明.orivii.json':'图文说明.html');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){onError(error)}finally{setBusy(false)}}
    const wrap=(content,index)=>{
      const inner=h('div',{className:'dot-artifact'+(compact?' dot-artifact-compact':''),ref:index===0?root:undefined},content,!compact&&index===0?h('button',{type:'button',className:'dot-artifact-download dot-icon-button',disabled:busy,'aria-label':'下载原文件',title:'下载原文件',onClick:save},h(Icon,{name:'download',size:17})):null)
      return bubble?h('div',{key:index,className:'dot-bubble dot-artifact-bubble',style:{'--bubble-delay':Math.min(delay+index*100,400)+'ms'}},h('div',{className:'dot-bubble-content'},inner)):h('div',{key:index,className:'dot-artifact-inline'},inner)
    }
    if(error||!data)return wrap(h('p',{role:'status',className:'dot-artifact-status'},error||'正在展开图文…'),0)
    if(data.kind==='visual')return h(Visual,{spec:data.spec,limit,wrap})
    return h(React.Fragment,null,...heights.map((height,index)=>wrap(h('iframe',{key:channel.current+':'+index,ref:node=>{frames.current[index]=node},onLoad:event=>event.currentTarget.contentWindow?.postMessage({type:'orivii:measure',id:channel.current},'*'),title:(format==='svg'?'图示':'图文内容')+' '+(index+1),name:JSON.stringify({id:channel.current,part:index,limit}),sandbox:'allow-scripts',referrerPolicy:'no-referrer',scrolling:'no',loading:'eager',srcDoc:document+'<!--orivii-limit:'+limit+'-->',className:'dot-artifact-frame',style:{width:'100%',height}}),index)))
  }
  return ArtifactPreview
}
import {validateVisualSpec,visualValues,VISUAL_TEMPLATES} from './visual.js'
import {downloadChatFile} from './file-client.js'
import {validCanvasMessage,groupBubbleBlocks,bubbleContentLimit,previewColorPolicy} from './canvas.js'
import {VISUAL_ICONS} from './visual-icons.js'
