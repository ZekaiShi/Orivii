let replyInkId=0
const inkClamp=value=>Math.max(0,Math.min(1,value))
export function replyInkColor(progress,foreground=[250,250,250]) {
  const t=inkClamp(progress),lightInk=foreground.reduce((sum,v)=>sum+v,0)>450
  const pink=lightInk?[244,157,216]:[164,52,120],gold=lightInk?[252,216,142]:[137,95,24]
  const a=t<.45?pink:gold,b=t<.45?gold:foreground,f=inkClamp(t<.45?t/.45:(t-.45)/.55),mix=f*f*(3-2*f)
  return `rgba(${a.map((v,i)=>Math.round(v+(b[i]-v)*mix)).join(',')},${Math.min(1,.12+t*3).toFixed(3)})`
}

// Style fresh rendered text through ranges, without inserting spans into the
// native Markdown renderer's DOM. This preserves links, code and selection.
export function createReplyInk(root) {
  const doc=root.ownerDocument,win=doc.defaultView,registry=win.CSS?.highlights,Highlight=win.Highlight
  if(!registry||!Highlight||!win.requestAnimationFrame)return {update(){},dispose(){}}
  const media=win.matchMedia?.('(prefers-reduced-motion: reduce)')
  let previous='',runs=[],frame=null,style=null,foreground=[250,250,250],disposed=false
  function clear(){
    if(frame!==null)win.cancelAnimationFrame(frame);frame=null
    for(const run of runs)registry.delete(run.id)
    runs=[];style?.remove();style=null
  }
  function draw(){
    const now=win.performance.now()
    runs=runs.filter(run=>{if(now-run.time<560)return true;registry.delete(run.id);return false})
    if(!runs.length){clear();return}
    if(!style){style=doc.createElement('style');style.dataset.dotReplyInk='';doc.head.append(style)}
    style.textContent=runs.map(run=>`::highlight(${run.id}){color:${replyInkColor((now-run.time)/560,foreground)}}`).join('\n')
    if(frame===null)frame=win.requestAnimationFrame(()=>{frame=null;if(!disposed)draw()})
  }
  function update(animate){
    if(disposed)return
    const nodes=[];let text=''
    for(const part of root.querySelectorAll('.dot-rich-text')){
      const walker=doc.createTreeWalker(part,win.NodeFilter.SHOW_TEXT)
      while(walker.nextNode()){
        const node=walker.currentNode
        if(node.parentElement?.closest('pre,button,svg,script,style,[aria-hidden=true]'))continue
        nodes.push({node,start:text.length,end:text.length+node.length});text+=node.data
      }
    }
    if(!animate||doc.hidden||media?.matches||!text.startsWith(previous)){clear();previous=text;return}
    if(text.length>previous.length)runs.push({id:'dot-reply-ink-'+(++replyInkId),start:previous.length,end:text.length,time:win.performance.now()})
    previous=text
    if(!runs.length)return
    const computed=win.getComputedStyle(root).color,ink=computed.match(/[\d.]+/g)
    if(ink?.length>=3&&/^(?:rgba?\(|color\(srgb\s)/.test(computed))foreground=ink.slice(0,3).map(value=>Math.round(Number(value)*(computed.startsWith('color(')?255:1)))
    // Markdown may replace text nodes while retaining the same rendered text.
    // Rebind live ranges on each commit; never keep disconnected text nodes.
    for(const run of runs){
      const ranges=[]
      for(const {node,start,end} of nodes){
        if(end<=run.start||start>=run.end)continue
        const range=doc.createRange();range.setStart(node,Math.max(0,run.start-start));range.setEnd(node,Math.min(node.length,run.end-start));ranges.push(range)
      }
      registry.set(run.id,new Highlight(...ranges))
    }
    draw()
  }
  const pause=()=>{if(doc.hidden||media?.matches)clear()}
  doc.addEventListener('visibilitychange',pause);media?.addEventListener?.('change',pause)
  return {update,dispose(){disposed=true;clear();doc.removeEventListener('visibilitychange',pause);media?.removeEventListener?.('change',pause)}}
}
