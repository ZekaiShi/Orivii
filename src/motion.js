// Keep closing surfaces mounted only for their short exit, and make them inert.
// Privacy transitions (lock, leaving Dot) bypass retention entirely.
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
