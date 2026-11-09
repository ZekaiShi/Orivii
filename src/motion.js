// Keep closing surfaces mounted only for their short exit, and make them inert.
// Privacy transitions (lock, leaving Dot) bypass retention entirely.
export function createSendTransition(){
  const pending=new Map(),running=new Set()
  function clear(){pending.clear();for(const stop of [...running])stop()}
  function capture(id,composer){
    const doc=composer?.ownerDocument,win=doc?.defaultView
    if(!composer||doc.hidden||win.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return
    const r=composer.getBoundingClientRect()
    if(r.width&&r.height)pending.set(id,{x:r.x,y:r.y,width:r.width,height:r.height,at:Date.now()})
    for(const [key,v]of pending)if(Date.now()-v.at>2000)pending.delete(key)
  }
  function arrive(id,row){
    if(!row||!pending.has(id))return
    const from=pending.get(id);pending.delete(id)
    const doc=row.ownerDocument,win=doc.defaultView,bubble=row.querySelector('.dot-bubble')
    if(!bubble?.animate||doc.hidden||win.matchMedia?.('(prefers-reduced-motion: reduce)').matches||Date.now()-from.at>2000)return
    row.dataset.dotTransport='true'
    let frame,overlay,animations=[],closed=false
    const saved=bubble.style.visibility
    bubble.style.visibility='hidden'
    const stop=()=>{if(closed)return;closed=true;win.cancelAnimationFrame(frame);animations.forEach(a=>a.cancel());overlay?.remove();bubble.style.visibility=saved;doc.removeEventListener('visibilitychange',hidden);running.delete(stop)}
    const hidden=()=>{if(doc.hidden)stop()}
    running.add(stop);doc.addEventListener('visibilitychange',hidden)
    frame=win.requestAnimationFrame(()=>{frame=win.requestAnimationFrame(()=>{
      if(!row.isConnected){stop();return}
      const to=bubble.getBoundingClientRect(),style=win.getComputedStyle(bubble),fill=win.getComputedStyle(bubble,'::before').backgroundColor
      if(!to.width||!to.height){stop();return}
      overlay=bubble.cloneNode(true);overlay.removeAttribute('id');overlay.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'))
      overlay.setAttribute('aria-hidden','true');overlay.className='dot-send-flight'
      Object.assign(overlay.style,{position:'fixed',visibility:'visible',zIndex:1000,pointerEvents:'none',boxSizing:'border-box',overflow:'hidden',margin:0,left:to.x+'px',top:to.y+'px',width:to.width+'px',height:to.height+'px',padding:style.padding,font:style.font,lineHeight:style.lineHeight,color:style.color,background:fill||style.backgroundColor,borderRadius:style.borderRadius,boxShadow:style.boxShadow})
      overlay.querySelectorAll('*').forEach(e=>{e.style.animation='none';e.style.color='inherit'})
      doc.body.append(overlay);bubble.style.visibility='hidden';row.dataset.dotTransport='true'
      const dx=from.x-to.x,dy=from.y-to.y
      const movement=overlay.animate([
        {transform:`translate(${dx}px,${dy}px)`,width:from.width+'px',height:from.height+'px',borderRadius:'24px',offset:0},
        {transform:'translate(0,-6px)',width:to.width+'px',height:to.height+'px',borderRadius:style.borderRadius,offset:.74},
        {transform:'translate(0,2px)',offset:.88},
        {transform:'translate(0,0)',width:to.width+'px',height:to.height+'px',borderRadius:style.borderRadius,offset:1},
      ],{duration:620,easing:'cubic-bezier(.22,.8,.28,1)',fill:'both'})
      animations.push(movement)
      for(const child of overlay.children)animations.push(child.animate([{opacity:.35},{opacity:1}],{duration:400,fill:'both'}))
      movement.onfinish=stop
    })})
  }
  return {capture,arrive,clear}
}
export function createDotMotion(React) {
  const reduced=()=>typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  function Motion({show,children,immediate=false}) {
    const [retained,setRetained]=React.useState(Boolean(show)),last=React.useRef(null)
    const [less,setLess]=React.useState(reduced)
    React.useEffect(()=>{
      const media=typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)')
      const update=()=>setLess(Boolean(media?.matches))
      media?.addEventListener?.('change',update)
      return()=>media?.removeEventListener?.('change',update)
    },[])
    if(show)last.current=children
    React.useEffect(()=>{
      if(show){setRetained(true);return}
      if(immediate||less){setRetained(false);last.current=null;return}
      const timer=setTimeout(()=>{setRetained(false);last.current=null},180)
      return()=>clearTimeout(timer)
    },[show,immediate,less])
    if(!show&&(immediate||less||!retained))return null
    const child=show?children:last.current
    return child?React.cloneElement(child,{'data-dot-motion':show?'enter':'exit',...(!show?{inert:'','aria-hidden':true}:{})}):null
  }
  const disclosures=new WeakMap()
  function animateDisclosure(event) {
    const summary=event.target.closest?.('summary'),details=summary?.parentElement
    if(details?.tagName!=='DETAILS'||!event.currentTarget.contains(details))return
    if(event.target.closest?.('a,button,input'))return
    event.preventDefault()
    const previous=disclosures.get(details),opening=previous?!previous.opening:!details.open
    const height=details.getBoundingClientRect().height
    const savedOverflow=previous?.overflow??details.style.overflow
    previous?.animation.cancel()
    if(reduced()||!details.animate){details.open=opening;return}
    details.open=opening
    const target=details.getBoundingClientRect().height
    details.open=true;details.style.overflow='hidden'
    const animation=details.animate([{height:height+'px'},{height:target+'px'}],{duration:opening?220:160,easing:'cubic-bezier(.2,.8,.2,1)'})
    const record={animation,opening,overflow:savedOverflow};disclosures.set(details,record)
    const cleanup=()=>{if(disclosures.get(details)===record){disclosures.delete(details);details.style.overflow=savedOverflow}}
    animation.onfinish=()=>{details.open=opening;cleanup()}
    animation.oncancel=cleanup
  }
  return {Motion,animateDisclosure}
}
