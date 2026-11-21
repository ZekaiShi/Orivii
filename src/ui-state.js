export function createDotView() {
  let value={expanded:false,active:null,ready:false,chats:[],name:'Orivii',eyeAnimation:true}
  const listeners=new Set()
  return {
    get:()=>value,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    set:patch=>{value={...value,...patch};for(const listener of listeners)listener()},
    clear(){this.set({ready:false,chats:[],active:null,name:'Orivii',eyeAnimation:true,characterColor:''})},
  }
}

// DSH's current sidebar slot owns only the icon. Keep this compatibility
// adapter local to our own row; do not replace the shell or its workspace list.
export function attachDotSidebar(icon,onClick) {
  // Recent DSH hosts also render panel icons inside the More menu. Those
  // menuitems keep the host's open/pin actions and never own a chat subtree.
  if(icon?.closest('[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'))return null
  const row=icon?.closest('button')
  if(!row?.parentNode)return null
  // The current sidebar wraps the row and its unpin action in one flex entry.
  // A full-width subtree beside the button would consume its label's width.
  // Mount after the complete entry; older hosts render the button directly.
  const navigation=row.closest('nav')
  let anchor=row
  if(navigation)while(anchor.parentElement&&anchor.parentElement!==navigation)anchor=anchor.parentElement
  const mount=row.ownerDocument.createElement('div')
  mount.className='dot-sidebar-mount';mount.id='dot-sidebar-chats'
  anchor.after(mount)
  const previous={expanded:row.getAttribute('aria-expanded'),controls:row.getAttribute('aria-controls')},motion= row.getAttribute('data-dot-native-row')
  row.setAttribute('data-dot-native-row','')
  const click=event=>{event.preventDefault();event.stopPropagation();onClick()}
  row.addEventListener('click',click,true)
  row.setAttribute('aria-controls',mount.id)
  const Observer=row.ownerDocument.defaultView?.MutationObserver
  const observer=Observer?new Observer(()=>{if(row.isConnected&&anchor.nextSibling!==mount)anchor.after(mount)}):null
  observer?.observe(anchor.parentNode,{childList:true})
  return {mount,setExpanded:value=>row.setAttribute('aria-expanded',String(value)),dispose(){
    observer?.disconnect();row.removeEventListener('click',click,true);mount.remove()
    if(motion===null)row.removeAttribute('data-dot-native-row');else row.setAttribute('data-dot-native-row',motion)
    for(const [key,value] of Object.entries(previous)){const name=key==='expanded'?'aria-expanded':'aria-controls';if(value===null)row.removeAttribute(name);else row.setAttribute(name,value)}
  }}
}
