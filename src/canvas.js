// Old file metadata remains readable; bubble layout uses complete content blocks.
export const CANVAS_RATIOS=['16:9','4:3','1:1','3:4']
export const bubbleContentLimit=height=>Math.min(480,Math.max(220,(Number.isFinite(height)?height:1000)-260))
export function groupBubbleBlocks(blocks,limit=480){
  const groups=[];let current=[],used=0
  for(let index=0;index<blocks.length;index++){
    const block=blocks[index],height=Math.max(1,Number(block.height)||1),next=block.keepWithNext&&index+1<blocks.length?Math.max(1,Number(blocks[index+1].height)||1):0
    if(current.length&&(block.breakBefore||used+height+next>limit)&&groups.length<127){groups.push(current);current=[];used=0}
    current.push(index);used+=height
  }
  if(current.length)groups.push(current)
  return groups
}
export function validCanvasMessage(data,id){
  return data?.type==='orivii:canvas'&&data.id===id&&Number.isInteger(data.height)&&data.height>0&&data.height<=1000000&&Number.isInteger(data.width)&&data.width>0&&data.width<=100000&&Number.isInteger(data.part)&&Number.isInteger(data.count)&&data.count>0&&data.count<=128&&data.part>=0&&data.part<data.count
}


export function previewColorPolicy(){
  const clamp=(n,max=255)=>Math.max(0,Math.min(max,Number.isFinite(n)?n:0))
  const parse=value=>{
    if(typeof value!=='string')return null
    value=value.trim().toLowerCase();if(value==='transparent')return [0,0,0,0]
    if(/^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/.test(value)){
      let hex=value.slice(1);if(hex.length<5)hex=[...hex].map(c=>c+c).join('')
      return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)).concat(hex.length===8?parseInt(hex.slice(6),16)/255:1)
    }
    const rgb=value.match(/^rgba?\((.*)\)$/),srgb=value.match(/^color\(srgb\s+(.+)\)$/),body=rgb?.[1]||srgb?.[1]
    if(!body)return null
    const fields=body.replace(/[,/]/g,' ').trim().split(/\s+/)
    if(fields.length<3||fields.length>4)return null
    const numbers=fields.map(parseFloat);if(!numbers.every(Number.isFinite))return null
    return numbers.slice(0,3).map((n,i)=>clamp(n*(srgb?255:fields[i].endsWith('%')?2.55:1))).concat(fields.length===4?clamp(numbers[3]/(fields[3].endsWith('%')?100:1),1):1)
  }
  const blend=(top,bottom)=>{
    const alpha=top[3]+bottom[3]*(1-top[3])
    return top.slice(0,3).map((n,i)=>alpha?(n*top[3]+bottom[i]*bottom[3]*(1-top[3]))/alpha:0).concat(alpha)
  }
  const css=color=>'rgb('+color.slice(0,3).map(n=>Math.round(clamp(n))).join(', ')+')'
  const luminance=color=>color.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0)
  const ratio=(a,b)=>{const x=luminance(blend(a,b)),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
  const black=[0,0,0,1],white=[255,255,255,1]
  const choose=(foreground,background,fallback)=>{
    const ink=parse(foreground),surface=parse(background)||white
    if(ink&&ratio(ink,surface)>=4.5)return null
    const candidates=[ink&&[...ink.slice(0,3),1],parse(fallback),black,white].filter(Boolean)
    return css(candidates.find(color=>ratio(color,surface)>=4.5)||candidates.sort((a,b)=>ratio(b,surface)-ratio(a,surface))[0])
  }
  const over=(foreground,background)=>css(blend(parse(foreground)||[0,0,0,0],parse(background)||white))
  const theme=(ink,surface,page)=>{
    const bg=over(surface,over(page,'#fff')),foreground=choose(ink,bg,'')||css(blend(parse(ink)||black,parse(bg)))
    return {ink:foreground,surface:bg}
  }
  return {choose,theme,over,contrast:(foreground,background)=>ratio(parse(foreground)||black,parse(background)||white)}
}

// This fixed program groups complete DOM blocks; it never clips or translates text.
export function runPreviewCanvas(group,colorFactory){
  let config;try{config=JSON.parse(window.name)}catch{return}
  if(typeof config.id!=='string'||!config.id||!Number.isInteger(config.part)||config.part<0)return
  const flow=document.getElementById('orivii-preview-content');if(!flow)return
  const colors=colorFactory(),original=flow.cloneNode(true),limit=Math.min(720,Math.max(200,Number(config.limit)||480))
  let queued=false,last='',width=0
  function update(){
    queued=false
    flow.replaceChildren(...[...original.childNodes].map(node=>node.cloneNode(true)))
    const styles=[...flow.querySelectorAll('style')].map(node=>node.cloneNode(true)),units=[]
    const size=node=>{
      if(node.nodeType!==1){const range=document.createRange();range.selectNode(node);return range.getBoundingClientRect().height||1}
      const style=getComputedStyle(node);return node.getBoundingClientRect().height+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0)
    }
    function collect(node,boundary=false){
      if(node.nodeType===3){if(node.textContent.trim())units.push({node,height:size(node),breakBefore:boundary});return}
      if(node.nodeType!==1||node.tagName==='STYLE')return
      const height=size(node),tag=node.tagName,semantic=tag==='SECTION'||node.classList.contains('card')||node.hasAttribute('data-bubble')
      if(tag==='TABLE'&&height>limit&&node.tBodies.length){
        const rows=[...node.tBodies].flatMap(body=>[...body.rows]),head=node.tHead,groups=group(rows.map(row=>({height:size(row)})),Math.max(80,limit-(head?size(head):0)-24))
        if(groups.length>1){
          const fragment=document.createDocumentFragment(),tables=groups.map((indices,index)=>{
            const table=node.cloneNode(false)
            for(const child of node.children)if(child.tagName==='COLGROUP'||child===head||(child.tagName==='CAPTION'&&index===0))table.append(child.cloneNode(true))
            const body=document.createElement('tbody');for(const i of indices)body.append(rows[i].cloneNode(true));table.append(body)
            if(index===groups.length-1&&node.tFoot)table.append(node.tFoot.cloneNode(true))
            fragment.append(table);return table
          })
          node.replaceWith(fragment);for(const table of tables)units.push({node:table,height:size(table),breakBefore:true});return
        }
      }
      const container=['MAIN','ARTICLE','DIV','SECTION','ASIDE','UL','OL'].includes(tag),children=[...node.childNodes].filter(child=>child.nodeType===1?child.tagName!=='STYLE':child.textContent?.trim())
      if(container&&children.length&&(!semantic||height>limit)){
        children.forEach((child,index)=>collect(child,(boundary||semantic)&&index===0));return
      }
      units.push({node,height,breakBefore:boundary||semantic,keepWithNext:/^H[2-6]$/.test(tag)})
    }
    for(const child of [...flow.childNodes])collect(child)
    const groups=group(units,limit),selected=groups[config.part]||[],range=document.createRange()
    if(selected.length){
      range.setStartBefore(units[selected[0]].node);range.setEndAfter(units[selected.at(-1)].node)
      const parent=range.commonAncestorContainer,fragment=range.cloneContents()
      if(parent!==flow&&parent.nodeType===1){const wrapper=parent.cloneNode(false);wrapper.append(fragment);flow.replaceChildren(...styles,wrapper)}
      else flow.replaceChildren(...styles,fragment)
    }else flow.replaceChildren(...styles)
    const rootStyle=getComputedStyle(document.documentElement),baseInk=rootStyle.getPropertyValue('--preview-ink').trim()||getComputedStyle(flow).color,surface=rootStyle.getPropertyValue('--preview-surface').trim()||'#fff'
    function repair(node,background){
      if(node.nodeType!==1||['STYLE','SCRIPT','TITLE','DEFS','CLIPPATH','MASK'].includes(node.tagName.toUpperCase()))return
      const style=getComputedStyle(node),backdrop=colors.over(style.backgroundColor,background),svg=node.namespaceURI==='http://www.w3.org/2000/svg',svgText=svg&&['text','tspan'].includes(node.localName)
      if((!svg||svgText)&&[...node.childNodes].some(child=>child.nodeType===3&&child.textContent.trim())){
        const value=svgText?style.fill:style.color,replacement=value==='none'&&svgText?null:colors.choose(value,backdrop,baseInk)
        if(replacement)node.style.setProperty(svgText?'fill':'color',replacement,'important')
      }
      for(const child of node.children)repair(child,backdrop)
    }
    repair(flow,surface)
    const height=Math.ceil(Math.max(1,flow.getBoundingClientRect().height,flow.scrollHeight))
    if(height>1000000)return
    const message={type:'orivii:canvas',id:config.id,part:config.part,count:Math.max(1,groups.length),height,width:Math.round(flow.clientWidth)},signature=JSON.stringify(message)
    if(last!==signature){last=signature;window.parent.postMessage(message,'*')}
    width=flow.clientWidth
  }
  const schedule=()=>{if(!queued){queued=true;queueMicrotask(update)}}
  window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.type==='orivii:measure'&&event.data.id===config.id){last='';schedule()}})
  window.addEventListener('resize',()=>{if(flow.clientWidth!==width)schedule()})
  if(window.ResizeObserver)new ResizeObserver(()=>{if(flow.clientWidth!==width)schedule()}).observe(flow)
  document.fonts?.ready.then(schedule);schedule()
}
