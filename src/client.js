import {DEFAULTS,readPreferences,visibleMessages,unwrap} from './core.js'
import {createDotRemote} from './protocol.js'
import {createDotView,attachDotSidebar} from './ui-state.js'
import {createDotMotion,createSendTransition} from './motion.js'
import {APPEARANCE_KEYS,appearanceStyle} from './appearance.js'
import {createBiliConnection} from './bili-client.js'
import {createFileCard,uploadChatFile} from './file-client.js'
import {createArtifactPreview} from './visual-client.js'
import {createDotEye,DOT_RING} from './eye.js'
import {messageBubbleParts,createPacedReply} from './reply.js'
import {publicBubble} from './expression.js'
import {createCompanionSettings} from './companion-settings.js'
import {createDeveloperPanel} from './developer.js'
import {createLiveSettings} from './live-client.js'
import {createIdentitySettings} from './identity-client.js'

const PANEL_ID='dsh-companion-dot'
const DRAWER_TITLES={settings:'设置',appearance:'外观',identities:'我的 Orivii',liveSettings:'陪伴与连接',companion:'一起看',developer:'开发者模式',persona:'交流方式',care:'消息与安静时段',privacy:'数据与权限',tasks:'工作记录',profile:'关于你',memory:'聊过的内容',search:'查聊天记录',source:'原始聊天'}
async function apply(ctx) {
  const unmount=await ctx.remote.$mount(createDotRemote(require('zod').z))
  // Mounted namespaces are separate Cordis services; UI callbacks must close
  // over a context that explicitly injects them, not the mounting context.
  const ui=ctx.inject(['remote.dotCompanion'],registerUi)
  try {await ui} catch(error) {await ui.dispose();await unmount();throw error}
  return async()=>{await ui.dispose();await unmount()}
}
function registerUi(ctx) {
  let legacySession,directoryPicker
  ctx.inject(['remote.session'],child=>{
    legacySession=child.remote.session
    return()=>{legacySession=undefined}
  })
  ctx.inject(['remote.directoryPicker'],child=>{
    directoryPicker=child.remote.directoryPicker
    return()=>{directoryPicker=undefined}
  })
  const React=require('react'),h=React.createElement
  const {useState,useEffect,useRef,useSyncExternalStore}=React
  const {Motion,animateDisclosure}=createDotMotion(React)
  const DotEye=createDotEye(React)
  const PacedReply=createPacedReply(React)
  const view=createDotView()
  const useView=()=>useSyncExternalStore(view.subscribe,view.get,view.get)
  const subscribePanel=listener=>ctx.layout?.panelInfo?.subscribe?.(listener)||(()=>{})
  const panelVisible=()=>ctx.layout?.panelInfo?ctx.layout.panelInfo.getSnapshot().activePanelId===PANEL_ID:true
  let unlockToken='' // capability lives only in this renderer's memory
  async function rpc(action,data={}) {
    const capability=unlockToken
    const result=unwrap(await ctx.remote.dotCompanion.command({action,token:capability,...data}))
    if(capability!==unlockToken){const error=new Error('已切换 Orivii，忽略先前的响应。');error.code='stale';throw error}
    if(!result.ok){const error=new Error(result.error.message);error.code=result.error.code;throw error}
    return result.value
  }
  const additions=new Map(),addonListeners=new Set();let addonSnapshot=[]
  const addonSubscribe=fn=>{addonListeners.add(fn);return()=>addonListeners.delete(fn)}
  const bridge={rpc,view,addDeveloperPanel(key,Component){additions.set(key,Component);addonSnapshot=[...additions.values()];for(const fn of addonListeners)fn();return()=>{additions.delete(key);addonSnapshot=[...additions.values()];for(const fn of addonListeners)fn()}}}
  ctx.on?.('companion/client-request',receive=>receive(bridge))
  ctx.emit?.('companion/client-ready',bridge)
  function ExtensionPanels(){const components=useSyncExternalStore(addonSubscribe,()=>addonSnapshot,()=>addonSnapshot);return h(React.Fragment,null,...components.map((Component,i)=>h(Component,{key:i})))}
  function Ring({size=20}) {return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none','aria-hidden':true},h('circle',{cx:12,cy:12,r:DOT_RING.radius,stroke:'currentColor',strokeWidth:DOT_RING.stroke}))}
  function Icon({name,size=18}) {
    const paths={add:'M12 5v14M5 12h14',send:'M12 19V5m-6 6 6-6 6 6',back:'m14 6-6 6 6 6',close:'m6 6 12 12M18 6 6 18',more:'M5 12h.01M12 12h.01M19 12h.01',edit:'m15 5 4 4M4 20l4-1 12-12-4-4L4 15v5Z'}
    return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]}))
  }
  const button=(label,onClick,className='dot-text-button',content,disabled=false)=>h('button',{type:'button',onClick,className,'aria-label':label,title:label,disabled},content||label)
  const markdownLabels={code:{copyLabel:'复制',copiedLabel:'已复制',toolbarLabels:{codeLabel:'代码',wrapLabel:'自动换行',unwrapLabel:'取消换行'}},footnotes:'脚注'}
  const CompanionSettings=createCompanionSettings(React,{rpc,markdown:text=>h(require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText,{text,labels:markdownLabels})})
  const DeveloperPanel=createDeveloperPanel(React,{rpc,extra:()=>h(ExtensionPanels)})
  const LiveSettings=createLiveSettings(React,{rpc})
  const BiliConnection=createBiliConnection(React,{rpc})
  const FileCard=createFileCard(React,{rpc})
  const ArtifactPreview=createArtifactPreview(React,{rpc,markdown:text=>h('div',{className:'dot-rich-text'},h(require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText,{text,labels:markdownLabels}))})
  const IdentitySettings=createIdentitySettings(React,{rpc})
  const avatar=(size=36)=>h('span',{className:'dot-avatar',style:{width:size,height:size}},h(Ring,{size:Math.round(size*.65)}))
  function openDotRow(){
    if(ctx.layout.panelInfo.getSnapshot().activePanelId!==PANEL_ID){view.set({expanded:false});ctx.layout.selectPanel(PANEL_ID)}
    else view.set({expanded:!view.get().expanded})
  }
  function DotSidebarIcon({size=20,active=false}) {
    const state=useView(),icon=useRef(null),adapter=useRef(null),[mount,setMount]=useState(null)
    const panelActive=useSyncExternalStore(subscribePanel,panelVisible,panelVisible)
    useEffect(()=>{
      const attached=attachDotSidebar(icon.current,openDotRow);adapter.current=attached;setMount(attached?.mount||null)
      return()=>{attached?.dispose();adapter.current=null}
    },[])
    useEffect(()=>{adapter.current?.setExpanded(active&&state.expanded&&size!==18)},[active,state.expanded,size])
    return h(React.Fragment,null,h('span',{ref:icon,'data-dot-sidebar-icon':true,style:appearanceStyle(state)},h(DotEye,{compact:true,size,active:state.ready&&panelActive,enabled:state.eyeAnimation!==false})),h('style',null,STYLE),
      mount?require('react-dom').createPortal(h(Motion,{show:active&&state.expanded&&size!==18,immediate:!active||size===18||!state.ready},h('div',{className:'dot-sidebar-presence'},h('div',{className:'dot-sidebar-clip'},h(DotSidebarChats)))),mount):null)
  }
  function DotSidebarChats(){
    const state=useView(),[query,setQuery]=useState(''),[archived,setArchived]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('')
    async function act(fn){if(pending)return;setPending(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setPending(false)}}
    async function reload(id=view.get().active){const capability=unlockToken,next=await rpc('snapshot',{chatId:id});if(capability&&capability===unlockToken)view.set({chats:next.chats,active:id})}
    const chats=state.chats.filter(c=>Boolean(c.archived)===archived&&c.title.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.updatedAt-a.updatedAt)
    return h('section',{className:'dot-sidebar-tree','aria-label':'Orivii 聊天列表',onClick:e=>e.stopPropagation()},
      state.ready?h(React.Fragment,null,
        h('div',{className:'dot-sidebar-tools'},button('新建 Orivii 聊天',()=>act(async()=>{const chat=await rpc('createChat',{title:'新的聊天'});await reload(chat.id);ctx.layout.selectPanel(PANEL_ID)}),'dot-sidebar-action',h(React.Fragment,null,h(Icon,{name:'edit',size:14}),' 新聊天'),pending),button(archived?'返回聊天':'已归档',()=>setArchived(!archived),'dot-sidebar-action')),
        state.chats.length>6?h('input',{'aria-label':'搜索 Orivii 聊天',value:query,placeholder:'搜索聊天',onChange:e=>setQuery(e.target.value),onKeyDown:e=>e.stopPropagation()}):null,
        ...chats.map(c=>h('div',{key:c.id,className:'dot-sidebar-chat'+(c.id===state.active?' is-active':'')},
          h('button',{type:'button',className:'dot-sidebar-chat-title','aria-current':c.id===state.active?'page':undefined,onClick:()=>{view.set({active:c.id});ctx.layout.selectPanel(PANEL_ID)}},c.title),
          button(c.archived?'恢复此聊天':'归档此聊天',()=>act(async()=>{await rpc('editChat',{chatId:c.id,archived:!c.archived});await reload()}),'dot-sidebar-chat-action',c.archived?'↩':'−',pending))),
        !chats.length?h('p',null,archived?'还没有归档的聊天。':'从一句话开始。'):null):h('p',null,'打开记忆库后，聊天会出现在这里。'),
      error?h('p',{role:'alert'},error):null)
  }
  function DotPage() {
    const panelActive=useSyncExternalStore(subscribePanel,panelVisible,panelVisible)
    const navigation=useView(),active=navigation.active,setActive=id=>view.set({active:id})
    const [ready,setReady]=useState(Boolean(unlockToken))
    const [snapshot,setSnapshot]=useState(null),[draft,setDraft]=useState('')
    const [error,setError]=useState('')
    const [busy,setBusy]=useState(false),[menu,setMenu]=useState(false),[drawerPath,setDrawerPath]=useState([])
    const drawer=drawerPath.at(-1)||null,parentDrawer=drawerPath.at(-2),drawerHeading=useRef(null),drawerEpoch=useRef(0)
    const [morePreferences,setMorePreferences]=useState(false)
    function setDrawer(next,reset=false){drawerEpoch.current++;setDrawerPath(path=>!next?[]:reset?[next]:path.includes(next)?path.slice(0,path.indexOf(next)+1):[...path,next])}
    function backDrawer(){drawerEpoch.current++;setDrawerPath(path=>path.slice(0,-1))}
    useEffect(()=>{if(drawer)drawerHeading.current?.focus({preventScroll:true})},[drawer])
    const [workspace,setWorkspace]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('')
    const [identities,setIdentities]=useState([]),[sessionMode,setSessionMode]=useState('run'),[identityId,setIdentityId]=useState(null)
    const switching=useRef(false)
    const [companionName,setCompanionName]=useState('Orivii'),[preferredName,setPreferredName]=useState(''),[profileDraft,setProfileDraft]=useState({})
    const [creating,setCreating]=useState(true),[plaintext,setPlaintext]=useState(false)
    const [initializing,setInitializing]=useState(true),[inspecting,setInspecting]=useState(true),[workspaceInfo,setWorkspaceInfo]=useState(null)
    const [browse,setBrowse]=useState(null),[browseBusy,setBrowseBusy]=useState(false),[browseError,setBrowseError]=useState(''),[browsePath,setBrowsePath]=useState(''),[folderName,setFolderName]=useState(''),[showHidden,setShowHidden]=useState(false)
    const [settings,setSettings]=useState({}),[models,setModels]=useState([]),[rename,setRename]=useState('')
    const [layer,setLayer]=useState('permanent'),[memories,setMemories]=useState([]),[memoryEdit,setMemoryEdit]=useState(null)
    const [query,setQuery]=useState(''),[hits,setHits]=useState([]),[source,setSource]=useState(null)
    const [older,setOlder]=useState([])
    const [outbox,setOutbox]=useState([])
    const [files,setFiles]=useState([]),filesRef=useRef([]),fileInput=useRef(null),composer=useRef(null),uploads=useRef(new Map()),sendTransition=useRef(null)
    if(!sendTransition.current)sendTransition.current=createSendTransition()
    function changeFiles(fn){filesRef.current=typeof fn==='function'?fn(filesRef.current):fn;setFiles(filesRef.current)}
    function clearUploads(){for(const c of uploads.current.values())c.abort();uploads.current.clear();changeFiles([]);sendTransition.current.clear()}
    useEffect(()=>()=>{for(const c of uploads.current.values())c.abort();sendTransition.current.clear()},[])
    useEffect(()=>{if(!panelActive)sendTransition.current.clear()},[panelActive])
    async function addFiles(list){
      for(const file of Array.from(list||[])){
        if(filesRef.current.length>=4){setError('每条消息最多附加 4 个文件。');break}
        const localId=crypto.randomUUID(),controller=new AbortController();uploads.current.set(localId,controller)
        changeFiles(old=>[...old,{localId,name:file.name,status:'uploading'}])
        uploadChatFile(file,rpc,controller.signal).then(result=>{if(!controller.signal.aborted)changeFiles(old=>old.map(f=>f.localId===localId?{...result,localId,status:'ready'}:f))}).catch(e=>{if(!controller.signal.aborted){changeFiles(old=>old.filter(f=>f.localId!==localId));fail(e)}}).finally(()=>uploads.current.delete(localId))
      }
    }
    function removeFile(file){uploads.current.get(file.localId)?.abort();changeFiles(old=>old.filter(f=>f.localId!==file.localId));if(file.id)rpc('fileDiscard',{id:file.id}).catch(fail)}
    const enteredAt=useRef(Date.now()),stickToBottom=useRef(true)
    const eyeController=useRef(null)
    const [mediaState,setMediaState]=useState(null),[mediaUrl,setMediaUrl]=useState(''),[mediaMode,setMediaMode]=useState('video')
    useEffect(()=>{const close=()=>{rpc('mediaStop').catch(()=>{})};globalThis.addEventListener?.('pagehide',close);return()=>{globalThis.removeEventListener?.('pagehide',close);close()}},[])
    useEffect(()=>{if(!ready)return;let stopped=false,busy=false;const poll=async()=>{if(busy||stopped)return;busy=true;try{const v=await rpc('mediaStatus');if(!stopped)setMediaState(v)}catch{}finally{busy=false}};poll();const timer=setInterval(poll,2000);return()=>{stopped=true;clearInterval(timer)}},[ready,identityId])
    const activeRef=useRef(active),alive=useRef(true),epoch=useRef(0),scroll=useRef(null),draftRef=useRef(''),chatCreation=useRef(null),preserveDraftFor=useRef(null),browseAbort=useRef(null)
    useEffect(()=>{
      if(!menu&&!drawer)return
      const doc=scroll.current?.ownerDocument
      const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(false);if(parentDrawer)backDrawer();else{setDrawer(null);doc?.querySelector('.dot-header-actions [aria-label="更多"]')?.focus()}}}
      const outside=event=>{if(menu&&!event.target.closest?.('.dot-header-actions'))setMenu(false)}
      doc?.addEventListener('keydown',key);doc?.addEventListener('pointerdown',outside)
      return()=>{doc?.removeEventListener('keydown',key);doc?.removeEventListener('pointerdown',outside)}
    },[menu,drawer,parentDrawer])
    activeRef.current=active
    const prefs=snapshot?.settings||DEFAULTS
    const selected=snapshot?.chats.find(c=>c.id===active)
    const jobs=snapshot?.jobs||[],running=jobs.find(j=>j.chatId===active&&j.status==='running'&&j.kind!=='continuation')||jobs.find(j=>j.chatId===active&&j.status==='queued')
    const lastJob=jobs.findLast(j=>j.chatId===active)
    const sending=outbox.some(m=>m.chatId===active&&m.status==='sending')
    const working=Boolean(running?.chatId===active||sending)
    const messages=React.useMemo(()=>{
      const saved=[...older,...(snapshot?.messages||[])].filter((m,i,all)=>m.chatId===active&&all.findIndex(x=>x.id===m.id)===i)
      return [...saved,...outbox.filter(m=>m.chatId===active&&!saved.some(s=>s.requestId===m.id||s.id===m.serverId)).map(m=>({...m,role:'user',requestId:m.id}))].map(publicBubble).filter(m=>m.text.trim())
    },[older,snapshot?.messages,outbox,active])
    function fail(e){if(e.code==='stale')return;if(e.code==='locked')clearPrivate();setError(e.message||'连接失败，请重试。')}
    function clearPrivate(){clearUploads();setMediaState(null);setMediaUrl('');epoch.current++;unlockToken='';activeRef.current=null;view.clear();setReady(false);setIdentityId(null);setSnapshot(null);setOutbox([]);chatCreation.current=null;draftRef.current='';setOlder([]);setMemories([]);setHits([]);setSource(null);setMemoryEdit(null);setDrawer(null);setMenu(false);setDraft('');setPassword('');setConfirm('');setSettings({});setModels([]);setMorePreferences(false);setProfileDraft({});setPreferredName('');setCompanionName('Orivii');setRename('');setQuery('')}
    useEffect(()=>{view.set({ready,chats:ready?snapshot?.chats||view.get().chats:[],name:ready?snapshot?.settings?.name||'Orivii':'Orivii',eyeAnimation:ready?snapshot?.settings?.eyeAnimation!==false:true,characterColor:ready?snapshot?.settings?.characterColor||'':''})},[ready,snapshot])
    useEffect(()=>{enteredAt.current=Date.now();stickToBottom.current=true;setOlder([]);if(preserveDraftFor.current!==active){draftRef.current='';setDraft('');clearUploads()}preserveDraftFor.current=null;setError('')},[active])
    useEffect(()=>{setOutbox(old=>{const rest=old.filter(m=>!(snapshot?.messages||[]).some(s=>s.requestId===m.id||s.id===m.serverId));return rest.length===old.length?old:rest})},[snapshot?.messages])
    async function refresh(id=activeRef.current) {
      const generation=epoch.current
      const next=await rpc('snapshot',{chatId:id})
      if(alive.current&&generation===epoch.current&&id===activeRef.current)setSnapshot(next)
      return next
    }
    async function action(fn){if(busy)return;setBusy(true);setError('');try{await fn()}catch(e){fail(e)}finally{if(alive.current)setBusy(false)}}
    function adoptInspection(info){setWorkspaceInfo(info);setCreating(info.state==='new');if(info.state==='existing')setPlaintext(info.encrypted===false)}
    function changeWorkspace(value){setWorkspace(value);setWorkspaceInfo(null);setInspecting(true);setPlaintext(false);setError('');setPassword('');setConfirm('')}
    useEffect(()=>{
      alive.current=true
      async function restore(){
        let restoredWorkspace
        const previousChat=unlockToken?activeRef.current:null
        try{const opened=await rpc('resume');if(alive.current)await adoptOpen(opened,previousChat)}catch(e){
          if(e.code!=='locked')throw e
          const s=await rpc('status');restoredWorkspace=s.workspace;if(alive.current){setWorkspace(s.workspace);adoptInspection(s);setReady(false)}
        }
        const list=await rpc('identities');if(alive.current){setIdentities(list.items);const selected=list.items.find(item=>item.workspace===restoredWorkspace)||list.items.find(item=>item.active);if(selected)setSessionMode(selected.mode)}
      }
      restore().catch(e=>{if(alive.current)fail(e)}).finally(()=>{if(alive.current){setInitializing(false);setInspecting(false)}})
      return()=>{alive.current=false;epoch.current++;browseAbort.current?.abort()}
    },[])
    useEffect(()=>{
      if(initializing||ready)return
      let stopped=false
      setInspecting(true)
      const timer=setTimeout(()=>{
        if(!workspace.trim()){setWorkspaceInfo(null);setInspecting(false);return}
        rpc('status',{workspace:workspace.trim()}).then(info=>{if(!stopped)adoptInspection(info)}).catch(e=>{if(!stopped){setWorkspaceInfo(null);fail(e)}}).finally(()=>{if(!stopped)setInspecting(false)})
      },250)
      return()=>{stopped=true;clearTimeout(timer)}
    },[workspace,initializing,ready])
    function closeBrowse(){browseAbort.current?.abort();setBrowse(null);setBrowseBusy(false);setBrowseError('')}
    async function chooseDirectory(){
      if(!directoryPicker){setError('DSH 目录选择服务尚未就绪，请稍后重试或填写路径。');return}
      if(browseBusy)return
      browseAbort.current?.abort();const abort=new AbortController();browseAbort.current=abort
      setBrowseBusy(true);setError('');setBrowseError('')
      try {
        // Ask the host's native chooser first. A web listing is only needed
        // when DSH explicitly selected its headless/remote browse backend.
        const result=await directoryPicker.pick(abort.signal)
        if(abort.signal.aborted||!alive.current)return
        if(!result.ok&&result.error?.code==='directory-picker/unavailable'&&result.error?.details?.capability==='browse') {
          await browseDirectory();return
        }
        const picked=unwrap(result)
        if(picked)changeWorkspace(picked)
      } catch(e){if(!abort.signal.aborted&&alive.current)setError(e.message||'无法打开系统目录选择器。')}
      finally{if(browseAbort.current===abort&&alive.current)setBrowseBusy(false)}
    }
    async function browseDirectory(target){
      if(!directoryPicker){setError('DSH 目录浏览服务尚未就绪，请稍后重试或填写路径。');return}
      browseAbort.current?.abort();const abort=new AbortController();browseAbort.current=abort
      setBrowseBusy(true);setBrowseError('');setBrowse(old=>old||{path:'',crumbs:[],entries:[]})
      try {
        const result=await directoryPicker.list(target||undefined,abort.signal)
        if(abort.signal.aborted||!alive.current)return
        const listing=unwrap(result)
        setBrowse(listing);setBrowsePath(listing.path);setFolderName('')
      } catch(e){if(!abort.signal.aborted&&alive.current)setBrowseError(e.message||'无法读取此目录。')}
      finally{if(browseAbort.current===abort&&alive.current)setBrowseBusy(false)}
    }
    async function createFolder(){
      if(!directoryPicker||!browse?.path||!folderName.trim()||browseBusy)return
      const owner=browseAbort.current
      setBrowseBusy(true);setBrowseError('')
      try {const target=unwrap(await directoryPicker.createDirectory(browse.path,folderName.trim()));if(alive.current&&browseAbort.current===owner&&!owner.signal.aborted)await browseDirectory(target)}
      catch(e){if(alive.current&&browseAbort.current===owner&&!owner.signal.aborted)setBrowseError(e.message||'创建文件夹失败。')}
      finally{if(alive.current&&browseAbort.current===owner)setBrowseBusy(false)}
    }
    useEffect(()=>{
      if(!ready)return
      let stopped=false,polling=false
      async function poll(){if(polling)return;polling=true;try{await refresh()}catch(e){if(!stopped)fail(e)}finally{polling=false}}
      poll();const timer=running?null:setInterval(poll,1500)
      return()=>{stopped=true;if(timer!==null)clearInterval(timer)}
    },[ready,active,running?.id,identityId])
    useEffect(()=>{
      if(!ready||!active||running?.chatId!==active||!panelActive)return
      let stopped=false,polling=false,lastRevision=-1,observedRunning=false,lastSnapshotAt=0
      const generation=epoch.current,id=active
      async function progress(){
        if(stopped||polling||scroll.current?.ownerDocument.hidden)return
        polling=true
        try{
          const next=await rpc('progress',{chatId:id})
          if(stopped||generation!==epoch.current||id!==activeRef.current)return
          const completed=observedRunning&&!next.running
          observedRunning=next.running
          if(completed||next.revision!==lastRevision||!next.running&&Date.now()-lastSnapshotAt>=1500){lastRevision=next.revision;lastSnapshotAt=Date.now();await refresh(id)}
          else setSnapshot(old=>{
            if(!old||old.chatId!==id)return old
            const a=old.partial,b=next.partial
            if(a?.id===b?.id&&a?.text===b?.text&&a?.phase===b?.phase&&a?.stage===b?.stage&&a?.presentation?.expression===b?.presentation?.expression&&old.presentationEvents?.at(-1)?.id===next.presentationEvents?.at(-1)?.id)return old
            return {...old,partial:b,presentationEvents:next.presentationEvents}
          })
        }catch(e){if(!stopped&&generation===epoch.current)fail(e)}finally{polling=false}
      }
      progress();const timer=setInterval(progress,120)
      return()=>{stopped=true;clearInterval(timer)}
    },[ready,active,running?.id,panelActive])
    useEffect(()=>{if(scroll.current&&stickToBottom.current)scroll.current.scrollTop=scroll.current.scrollHeight},[messages,snapshot?.partial?.text,active])
    function select(id){setActive(id);activeRef.current=id;setOlder([]);setSnapshot(old=>old?{...old,messages:[],partial:null}:old);setError('');draftRef.current='';setDraft('')}
    async function adoptOpen(result,previousChat=null){

      if(!alive.current)return
      clearPrivate(false);unlockToken=result.token;enteredAt.current=Date.now();setWorkspace(result.workspace);setSessionMode(result.session?.mode||'run')
      const next=await rpc('snapshot',{chatId:null}),list=await rpc('identities')
      if(!alive.current)return
      setSnapshot(next);setIdentities(list.items);setIdentityId(result.identityId);setReady(true)
      const latest=next.chats.find(c=>c.id===previousChat)||next.chats.filter(c=>!c.archived).sort((a,b)=>b.updatedAt-a.updatedAt)[0]
      if(latest)select(latest.id)
    }
    async function switchIdentity(actionName,data){
      if(switching.current||busy)throw new Error('请等待当前操作完成。')
      if(draftRef.current.trim()||filesRef.current.length||outbox.length)throw new Error('请先发送或移除草稿和附件，并处理尚未送达的消息，再切换 Orivii。')
      const previous=unlockToken
      switching.current=true;setBusy(true);setError('')
      try{const result=await rpc(actionName,data);await adoptOpen(result)}catch(e){
        // A wrong password belongs to the target identity; keep the current one open.
        if(e.code==='locked'){const current=await rpc('identities');if(current.current)e.code='identity-password'}
        if(previous!==unlockToken)fail(e)
        throw e
      }finally{switching.current=false;if(alive.current)setBusy(false)}
    }
    async function openVault(){await action(async()=>{
      const detected=await rpc('status',{workspace:workspace.trim()})
      if(detected.state==='incomplete')throw new Error('此目录已有未完成或不兼容的 Orivii 数据，请选择其他目录或恢复原记忆库。')
      if((detected.state==='new')!==creating){adoptInspection(detected);return}
      if(creating&&!plaintext&&password!==confirm)throw new Error('两次密码不一致。')
      const result=await rpc(creating?'setup':'unlock',{workspace:detected.workspace,password,sessionMode,...(creating?{settings:{name:companionName.trim()||'Orivii'},profile:preferredName.trim()?{preferredName:preferredName.trim()}:{},plaintext,...(plaintext?{plaintextAcknowledgement:'明文没有密码保护'}:{})}:{})})
      await adoptOpen(result)
    })}
    async function newChat(){await action(async()=>{const chat=await rpc('createChat',{title:'新的聊天'});select(chat.id);await refresh(chat.id)})}
    async function ensureChat(){if(activeRef.current)return activeRef.current;const chat=await rpc('createChat',{title:'新的聊天'});select(chat.id);await refresh(chat.id);return chat.id}
    async function startMedia(){await action(async()=>{const result=await rpc('mediaStart',{chatId:await ensureChat(),url:mediaUrl,mode:mediaMode});setMediaState(result);setDrawer(null)})}
    function send(){
      const attachments=filesRef.current.filter(f=>f.status==='ready').map(({id,name,mediaType,size,kind})=>({id,name,mediaType,size,kind}))
      const text=draftRef.current.trim()||(attachments.length?'分享了'+attachments.length+'个附件':'');if(!text||!ready||switching.current||filesRef.current.some(f=>f.status==='uploading'))return
      const request={text,attachments,chatId:activeRef.current,id:crypto.randomUUID(),time:Date.now(),status:'sending'}
      sendTransition.current.capture(request.id,composer.current);changeFiles([])
      draftRef.current='';setDraft('');setError('');stickToBottom.current=true
      setOutbox(old=>[...old,request]);eyeController.current?.activity('message')
      return transmit(request)
    }
    function retrySend(message){
      setOutbox(old=>old.map(m=>m.id===message.id?{...m,status:'sending'}:m))
      return transmit({...message,status:'sending'})
    }
    async function transmit(request){
      const generation=epoch.current,credential=unlockToken
      const current=()=>alive.current&&generation===epoch.current&&credential===unlockToken
      let received=false
      try{
        let id=request.chatId
        if(!id){
          chatCreation.current??=rpc('createChat',{title:request.text.slice(0,50)})
          const creation=chatCreation.current,c=await creation
          if(credential!==unlockToken)return
          id=c.id;request.chatId=id
          if(current()){
            if(!activeRef.current){preserveDraftFor.current=id;setActive(id);activeRef.current=id}
            setOutbox(old=>old.map(m=>m.id===request.id?{...m,chatId:id}:m))
          }
          if(chatCreation.current===creation)chatCreation.current=null
        }
        // Start the request immediately. The Host persists and orders messages;
        // generating a reply never holds the composer or the next send hostage.
        const accepted=await rpc('send',{chatId:id,text:request.text,requestId:request.id,...(request.attachments?.length?{attachments:request.attachments.map(f=>f.id)}:{})})
        received=true
        if(!current())return
        setOutbox(old=>old.map(m=>m.id===request.id?{...m,chatId:id,serverId:accepted.userId,status:'sent'}:m))
        const latest=await refresh(id)
        if(latest.chats.find(c=>c.id===id)?.title==='新的聊天'){
          await rpc('editChat',{chatId:id,title:request.text.slice(0,50)});await refresh(id)
        }
      }catch(e){
        if(current()){
          if(!received)setOutbox(old=>old.map(m=>m.id===request.id?{...m,chatId:request.chatId,status:'failed'}:m))
          chatCreation.current=null;fail(e)
        }
      }
    }
    async function openSettings(){setMenu(false);setSettings({...prefs});setRename(selected?.title||'');setDrawer('settings',true);try{setModels((await rpc('models')).items)}catch(e){fail(e)}}
    function openProfile(){setMenu(false);setProfileDraft(Object.fromEntries(['preferredName','identity','preferences'].map(key=>[key,snapshot?.profile?.fields?.[key]?.value||''])));setDrawer('profile')}
    async function showMemories(next=layer){setMenu(false);setLayer(next);setDrawer('memory');setMemoryEdit(null);const generation=drawerEpoch.current;try{const result=await rpc('memories',{layer:next});if(alive.current&&generation===drawerEpoch.current)setMemories(result)}catch(e){if(generation===drawerEpoch.current)fail(e)}}
    async function showSource(id){const generation=drawerEpoch.current;try{const result=await rpc('source',{id});if(alive.current&&generation===drawerEpoch.current){setSource(result);setDrawer('source')}}catch(e){if(generation===drawerEpoch.current)fail(e)}}
    function richText(text){
      // Use DSH's Markdown renderer (including safe links, tables and code).
      // Translate only our memory links, then intercept them before navigation.
      const markdown=text.replace(/\]\(dot:\/\/chat\/[a-f0-9-]{36}\/message\/([a-f0-9-]{36})\)/g,'](https://dot.invalid/message/$1)')
      return h('div',{className:'dot-rich-text',onClickCapture:event=>{
        const href=event.target.closest?.('a')?.getAttribute('href')||''
        const source=href.match(/^https:\/\/dot\.invalid\/message\/([a-f0-9-]{36})$/)
        if(source){event.preventDefault();event.stopPropagation();showSource(source[1])}
      }},h(require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText,{text:markdown,labels:markdownLabels}))
    }
    function messageRow(m){
      m=publicBubble(m);if(!m.text.trim()&&!m.attachments?.length)return null
      return h(PacedReply,{key:m.requestId||m.id,message:m,pace:m.role==='assistant'&&!m.presentation?.artifactOnly&&m.time>=enteredAt.current,render:renderMessageRow,onProgress:()=>{if(scroll.current&&stickToBottom.current)scroll.current.scrollTop=scroll.current.scrollHeight}})
    }
    function renderMessageRow(m){
      const parts=messageBubbleParts(m),detailsIndex=parts.findLastIndex(part=>part.kind==='text'||part.kind==='files')
      const rendered=parts.map((part,i)=>{
        const delay=Math.min(i*100,400),common={key:part.key,bubble:true,delay,onError:fail}
        if(part.kind==='artifact')return h(ArtifactPreview,{...common,file:part.file})
        if(part.kind==='markup')return h(ArtifactPreview,{...common,source:part.source,format:part.format})
        return h('div',{className:'dot-bubble'+(part.kind==='image'?' dot-image-bubble':part.kind==='markup-pending'?' dot-artifact-bubble':''),key:part.key,style:{'--bubble-delay':delay+'ms'}},h('div',{className:'dot-bubble-content'},part.text?richText(part.text):null,
          part.kind==='markup-pending'?h('p',{className:'dot-artifact-status',role:'status'},'正在整理图文…'):null,
          part.attachments?.length?h('div',{className:'dot-file-list'},...part.attachments.map(file=>h(FileCard,{key:file.id,file,onError:fail}))):null,
          i===detailsIndex&&m.connection==='bilibili'?h(BiliConnection,{autoLogin:m.time>=enteredAt.current,messageId:m.id}):null,
          i===detailsIndex&&m.webSources?.length?h('details',{className:'dot-citations'},h('summary',null,'来源'),...m.webSources.filter(s=>/^https?:\/\//i.test(s.url)).map(s=>h('a',{key:s.url,href:s.url,target:'_blank',rel:'noopener noreferrer'},s.title||s.url))):null))
      })
      return h('div',{ref:node=>sendTransition.current.arrive(m.requestId||m.id,node),className:'dot-message-row '+(m.role==='user'?'dot-outgoing':'dot-incoming')+(m.live?' dot-live-reply':''),key:m.requestId||m.id,'data-dot-new':m.time>=enteredAt.current,'data-message-id':m.id},m.role==='assistant'?avatar(28):null,
        h('div',{className:'dot-message-stack'},...rendered,h('div',{className:'dot-message-meta'},h('span',null,m.status==='sending'?'发送中…':m.status==='failed'?'发送失败，可重试':m.live?'正在输入…':new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),m.incomplete?h('span',null,'回复达到长度上限'):null,m.status==='failed'?button('重试发送',()=>retrySend(m),'dot-text-button'):null)))
    }
    function thinkingBubble(){return h('div',{className:'dot-message-row dot-incoming dot-pending',key:'thinking'},avatar(28),
      h('div',{className:'dot-message-stack'},h('div',{className:'dot-bubble'},h('div',{className:'dot-typing',role:'status','aria-label':snapshot?.partial?.stage||'正在回复'},h('i'),h('i'),h('i')),h('span',{className:'dot-thinking-label'},snapshot?.partial?.stage||(sending?'正在发送…':'正在思考…')))))}
    const historyRows=React.useMemo(()=>messages.map(messageRow),[messages])
    async function importLegacy(){await action(async()=>{
      const legacy=readPreferences(localStorage,`dsh-companion:v1:${ctx.remote.$host?.home||location.host}`)
      if(!legacy.sessions.length)throw new Error('当前浏览器没有旧版 Dot 聊天索引。')
      if(!legacySession)throw new Error('DSH 旧会话服务不可用，暂时无法导入。')
      for(const old of legacy.sessions){
        const abort=new AbortController();let records
        const timeout=setTimeout(()=>abort.abort(),15000)
        try {for await(const frame of legacySession.follow({address:{kind:'session',sessionId:old.id},maxMessages:1000},abort.signal)){if(frame.type==='snapshot'){records=frame.records;break}}}
        finally{clearTimeout(timeout);abort.abort()}
        if(!records)throw new Error('读取旧版聊天失败，已导入的记录不会重复导入。')
        const bubbles=visibleMessages(records)
        await rpc('import',{legacyId:old.id,title:old.title,messages:bubbles})
      }
      await refresh();setDrawer(null)
    })}
    const errorBox=h(Motion,{show:Boolean(error)},error?h('div',{className:'dot-error',role:'alert'},h('span',null,error),button('关闭提示',()=>setError(''),'dot-icon-button',h(Icon,{name:'close'}))):null)
    if(!ready)return h('div',{className:'dot-page dot-unlock',onClickCapture:animateDisclosure,'data-testid':'dot-locked'},h('style',null,STYLE),
      h('form',{className:'dot-vault-form',onSubmit:e=>{e.preventDefault();openVault()}},avatar(64),h('h1',null,creating?'给 Orivii 一个自己的空间':'打开 Orivii 的记忆'),
        h('p',null,'在这里开始认识彼此。聊天会保存在你选择的工作空间。'),
        identities.length?h('label',null,'已保存的 Orivii',h('select',{'aria-label':'已保存的 Orivii',value:identities.find(item=>item.workspace===workspace)?.id||'',disabled:initializing||busy,onChange:e=>{const item=identities.find(item=>item.id===e.target.value);if(item){changeWorkspace(item.workspace);setSessionMode(item.mode);if(item.unlocked)action(async()=>adoptOpen(await rpc('resume',{identityId:item.id})))}}},h('option',{value:''},'选择 Orivii'),...identities.map(item=>h('option',{key:item.id,value:item.id},item.name)))):null,
        h('label',null,'工作空间',h('div',{className:'dot-workspace-path'},h('input',{value:workspace,onChange:e=>changeWorkspace(e.target.value),placeholder:'选择文件夹或输入绝对路径',required:true,disabled:initializing||busy||browseBusy,'aria-label':'Orivii 工作空间'}),button('浏览…',chooseDirectory,'dot-text-button',null,initializing||busy||browseBusy))),
        browseBusy&&!browse?h('div',{className:'dot-directory-header',role:'status'},h('span',null,'正在打开系统目录选择器…'),button('取消选择',closeBrowse)):null,
        h('p',{role:'status'},initializing||inspecting?'正在检查记忆库…':workspaceInfo?.state==='new'?'此目录还没有 Orivii 记忆库，设置后即可直接创建。':workspaceInfo?.state==='existing'?(workspaceInfo.encrypted?'已找到记忆库，输入密码即可继续。':'已找到明文记忆库，点击打开即可继续。'):workspaceInfo?.state==='incomplete'?'此目录已有未完成或不兼容的 Orivii 数据，请选择其他目录或恢复原记忆库。':'请选择工作空间目录。'),
        h(Motion,{show:Boolean(browse)},browse?h('section',{className:'dot-directory-browser','aria-label':'浏览工作空间目录'},
          h('div',{className:'dot-directory-header'},h('strong',null,'选择目录'),button('关闭目录浏览',closeBrowse,'dot-icon-button',h(Icon,{name:'close'}))),
          h('div',{className:'dot-workspace-path'},h('input',{value:browsePath,'aria-label':'浏览目录路径',placeholder:'输入此 DSH 主机上的绝对路径',onChange:e=>setBrowsePath(e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();browseDirectory(browsePath)}}}),button('前往',()=>browseDirectory(browsePath),'dot-text-button',null,browseBusy)),
          h('nav',{'aria-label':'目录位置'},button('主目录',()=>browseDirectory(),'dot-text-button',null,browseBusy),...(browse.crumbs||[]).map(c=>h('button',{type:'button',key:c.path,onClick:()=>browseDirectory(c.path),disabled:browseBusy,className:'dot-text-button'},c.name))),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:showHidden,onChange:e=>setShowHidden(e.target.checked)}),'显示隐藏文件夹'),
          browseError?h('p',{role:'alert',className:'dot-directory-error'},browseError):null,
          h('div',{className:'dot-directory-list'},browseBusy?h('p',{role:'status'},'正在读取…'):(browse.entries||[]).filter(e=>showHidden||!e.hidden).map(e=>h('button',{type:'button',key:e.path,className:'dot-directory-row',onClick:()=>browseDirectory(e.path)},h('span',{'aria-hidden':true},'▸ '),e.name)),!browseBusy&&!browse.entries?.length?h('p',null,'此目录下没有子文件夹。'):null),
          browse.truncated?h('p',null,'文件夹较多，仅显示部分结果，可输入完整路径前往。'):null,
          h('div',{className:'dot-workspace-path'},h('input',{value:folderName,'aria-label':'新文件夹名称',placeholder:'新文件夹名称',onChange:e=>setFolderName(e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();createFolder()}}}),button('新建文件夹',createFolder,'dot-text-button',null,browseBusy||!folderName.trim()||!browse.path)),
          button('使用此目录',()=>{changeWorkspace(browse.path);closeBrowse()},'dot-save',null,browseBusy||!browse.path)):null),
        creating?h(React.Fragment,null,
          h('label',null,'给 Orivii 起个名字',h('input',{'aria-label':'Orivii 的名字',value:companionName,maxLength:200,placeholder:'Orivii',onChange:e=>setCompanionName(e.target.value)})),
          h('label',null,'希望我怎么称呼你',h('input',{'aria-label':'希望 Orivii 如何称呼你',value:preferredName,maxLength:80,placeholder:'名字、昵称或你喜欢的亲昵称呼（可选）',onChange:e=>setPreferredName(e.target.value)})),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:plaintext,onChange:e=>setPlaintext(e.target.checked)}),'使用明文保存（没有密码保护）')):null,
        !plaintext?h('label',null,'记忆库密码',h('input',{type:'password',value:password,autoComplete:creating?'new-password':'current-password',onChange:e=>setPassword(e.target.value),minLength:creating?10:undefined,maxLength:1024,'aria-label':'记忆库密码'})):null,
        creating&&!plaintext?h('label',null,'再次输入密码',h('input',{type:'password',value:confirm,autoComplete:'new-password',onChange:e=>setConfirm(e.target.value),'aria-label':'确认密码'})):null,
        h('label',null,'解锁期限',h('select',{'aria-label':'解锁期限',value:sessionMode,onChange:e=>setSessionMode(e.target.value)},h('option',{value:'run'},'本次 DSH 运行'),h('option',{value:'8h'},'每 8 小时验证'),h('option',{value:'24h'},'每 24 小时验证'))),
        h('small',null,'本次解锁后，刷新或重新打开页面可直接继续。DSH 退出、电脑重启或手动锁定后需重新解锁。'),
        h('p',{className:'dot-security-note'},plaintext?'明文文件可被有目录权限的程序读取。加一个界面密码不能保护明文。':'聊天内容会加密保存，密码不会保存。解锁后，相关内容会交给你选择的模型处理。请妥善保管密码，丢失后无法恢复。'),
        errorBox,h('button',{type:'submit',className:'dot-save',disabled:busy||browseBusy||initializing||inspecting||!workspaceInfo||workspaceInfo.state==='incomplete'||Boolean(browse)},busy?'正在打开…':creating?'创建工作空间':plaintext?'打开记忆库':'解锁')))
    const sourceLinks=entry=>h('div',{className:'dot-memory-sources'},...(entry.sources||[]).map(s=>button('查看原文',()=>showSource(s.id),'dot-source-link')))
    return h('div',{className:'dot-page',style:appearanceStyle(drawer==='appearance'?{...prefs,...settings}:prefs),'data-testid':'dot-page','data-dot-working':Boolean(working),onClickCapture:animateDisclosure,onPointerDownCapture:()=>eyeController.current?.activity('pointer'),onKeyDownCapture:()=>eyeController.current?.activity('input'),onScrollCapture:()=>eyeController.current?.activity()},h('style',null,STYLE),
      h('section',{className:'dot-conversation','aria-label':'与'+prefs.name+'的对话'},
        h('header',{className:'dot-chat-header'},
          h('div',{className:'dot-contact'},h(DotEye,{name:prefs.name,phase:working?(snapshot?.partial?.phase||'responding'):lastJob?.status==='failed'?'error':null,backgroundPhase:snapshot?.backgroundPhase,input:Boolean(draft),enabled:prefs.eyeAnimation!==false,active:panelActive,chatId:active,messages,historyReady:ready&&snapshot?.chatId===active,livePresentation:working?snapshot?.partial?.presentation:null,presentationEvents:snapshot?.presentationEvents,controllerRef:eyeController}),h('strong',null,prefs.name),h('span',null,working?snapshot?.partial?.stage||(sending?'正在发送…':'正在思考…'):selected?.title||'在这里，慢慢聊')),
          h('div',{className:'dot-header-actions'},button('新建聊天',newChat,'dot-icon-button',h(Icon,{name:'edit'}),busy),running?button('停止',()=>action(()=>rpc('cancel'))):null,React.cloneElement(button('更多',()=>setMenu(!menu),'dot-icon-button',h(Icon,{name:'more'})),{'aria-expanded':menu,'aria-controls':'dot-actions-menu'}),
            h(Motion,{show:menu},h('div',{className:'dot-menu',id:'dot-actions-menu'},button('设置',openSettings,'dot-menu-item'),snapshot?.extensionAvailable?button('工作记录',()=>{setDrawer('tasks',true);setMenu(false)},'dot-menu-item'):null,button('查聊天记录',()=>{setDrawer('search',true);setMenu(false)},'dot-menu-item'),button('锁定',()=>action(async()=>{await rpc('lock');clearPrivate()}),'dot-menu-item'))))),
        h('div',{className:'dot-live-controls'},button('一起看',()=>setDrawer('companion',true),'dot-text-button'),mediaState?h('span',{role:'status'},mediaState.state==='active'?`正在${mediaState.mode==='video'?'陪看':'共读'} · ${mediaState.title||'已选页面'}`:mediaState.lastError||'正在等待页面'):null,mediaState?button('结束陪伴',()=>action(async()=>{await rpc('mediaStop');setMediaState(null)})):null),
        h('div',{className:'dot-transcript',ref:scroll,role:'log','aria-label':'聊天记录','aria-live':'polite',onScroll:event=>{const el=event.currentTarget;stickToBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80}},messages.length?h('div',{className:'dot-message-column',key:active},
          (snapshot?.totalMessages||0)>messages.length?button('加载更早的消息',()=>action(async()=>{const result=await rpc('snapshot',{chatId:active,beforeId:messages[0].id});setOlder(old=>[...result.messages,...old])})):null,
          ...historyRows,working&&snapshot?.partial?.text&&!messages.some(m=>m.id===snapshot.partial.id)?messageRow({id:snapshot.partial.id||'partial',role:'assistant',text:snapshot.partial.text,time:snapshot.partial.time||Date.now(),live:true}):null,
          h(Motion,{show:Boolean(working&&!snapshot?.partial?.text)},thinkingBubble())):working?h('div',{className:'dot-message-column'},thinkingBubble()):h('div',{className:'dot-empty-chat'},h('h2',null,`和${prefs.name}聊聊`),h('p',null,'想说什么，都可以从这里开始。'))),
        lastJob?.error?h('div',{className:'dot-error',role:'status'},lastJob.error):null,errorBox,
        h('form',{className:'dot-compose',onDragOver:e=>{if(e.dataTransfer?.types?.includes('Files'))e.preventDefault()},onDrop:e=>{if(e.dataTransfer?.files?.length){e.preventDefault();addFiles(e.dataTransfer.files)}},onSubmit:e=>{e.preventDefault();send()}},
          files.length?h('div',{className:'dot-compose-files'},...files.map(file=>h('div',{className:'dot-draft-file',key:file.localId},h('span',null,file.name+(file.status==='uploading'?' · 上传中…':'')),button('移除 '+file.name,()=>removeFile(file),'dot-icon-button',h(Icon,{name:'close',size:14}))))):null,
          h('div',{className:'dot-compose-box',ref:composer},h('input',{ref:fileInput,type:'file',multiple:true,hidden:true,'aria-label':'选择图片或文件',onChange:e=>{addFiles(e.target.files);e.target.value=''}}),button('添加图片或文件',()=>fileInput.current?.click(),'dot-attach-button',h(Icon,{name:'add',size:20}),files.length>=4),h('textarea',{value:draft,disabled:switching.current,rows:1,maxLength:16000,placeholder:`发消息给${prefs.name}…`,'aria-label':'消息',onChange:e=>{draftRef.current=e.target.value;setDraft(e.target.value)},onPaste:e=>{const pasted=e.clipboardData?.files;if(pasted?.length){e.preventDefault();addFiles(pasted)}},onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send()}}}),
          h('button',{type:'submit',className:'dot-send',disabled:busy||files.some(f=>f.status==='uploading')||(!draft.trim()&&!files.length),'aria-label':'发送消息'},h(Icon,{name:'send'}))),
          h('div',{className:'dot-compose-foot'},h('span',null,'Enter 发送 · Shift + Enter 换行'),h('span',null,'')))),
      h(Motion,{show:Boolean(drawer)},drawer?h('aside',{className:'dot-details dot-memory-details','aria-label':'Orivii 详情'},
        h('div',{className:'dot-details-header'},parentDrawer?button('返回'+DRAWER_TITLES[parentDrawer],backDrawer,'dot-back-button',h(React.Fragment,null,h(Icon,{name:'back',size:16}),'返回')):null,h('h2',{ref:drawerHeading,tabIndex:-1},DRAWER_TITLES[drawer]),button('关闭',()=>setDrawer(null),'dot-icon-button',h(Icon,{name:'close'}))),
        h('div',{className:'dot-details-body',key:drawer},drawer==='settings'?h('div',{className:'dot-settings'},
          ...[['name','名字']].map(([key,label])=>h('label',{key},h('span',null,label),h(key==='persona'?'textarea':'input',{value:settings[key]||'',onChange:e=>setSettings(s=>({...s,[key]:e.target.value}))}))),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:settings.eyeAnimation!==false,onChange:e=>setSettings(old=>({...old,eyeAnimation:e.target.checked}))}),'角色动画'),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:settings.webSearch!==false,onChange:e=>setSettings(old=>({...old,webSearch:e.target.checked}))}),'需要时联网查资料'),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:settings.visualReplies!==false,onChange:e=>setSettings(old=>({...old,visualReplies:e.target.checked}))}),'优先用图文解释'),
          h('details',{className:'dot-advanced'},h('summary',null,'连接与模型'),
          h('label',null,h('span',null,'模型'),h('select',{value:settings.provider?JSON.stringify([settings.provider,settings.model]):'',onChange:e=>{const [provider,model]=e.target.value?JSON.parse(e.target.value):['',''];setSettings(s=>({...s,provider,model}))}},h('option',{value:''},'使用 DSH 默认模型'),...models.map(m=>h('option',{key:m.provider+'/'+m.id,value:JSON.stringify([m.provider,m.id])},m.provider+' / '+m.name)))),
          (!snapshot?.extensionAvailable||snapshot?.personaAvailable===false)?h('label',null,'自定义表达方式',h('textarea',{value:settings.persona||'',onChange:e=>setSettings(old=>({...old,persona:e.target.value}))})):null),
          button('保存设置',()=>action(async()=>{const changes=Object.fromEntries(['name','eyeAnimation','webSearch','visualReplies','provider','model',...((!snapshot?.extensionAvailable||snapshot?.personaAvailable===false)?['persona']:[])].filter(key=>settings[key]!==prefs[key]).map(key=>[key,settings[key]]));await rpc('settings',{settings:changes});await refresh();setDrawer(null)}),'dot-save'),
          button('我的 Orivii',()=>setDrawer('identities')),
          button('外观',()=>setDrawer('appearance')),
          button('陪伴与连接',()=>setDrawer('liveSettings')),
          h('hr'),
          h('details',{className:'dot-advanced dot-more-preferences',open:morePreferences,onToggle:e=>setMorePreferences(e.currentTarget.open)},h('summary',null,'更多偏好'),h('div',{className:'dot-preference-links'},
            button('关于你',openProfile),
            snapshot?.extensionAvailable?h(React.Fragment,null,snapshot?.personaAvailable!==false?button('交流方式',()=>setDrawer('persona')):null,button('消息与安静时段',()=>setDrawer('care')),button('数据与权限',()=>setDrawer('privacy'))):button('数据与权限',()=>showMemories('permanent')),button('开发者模式',()=>setDrawer('developer')))),
          selected?h('details',{className:'dot-advanced'},h('summary',null,'当前聊天'),h('label',null,h('span',null,'聊天标题'),h('input',{value:rename,onChange:e=>setRename(e.target.value)})),button('重命名',()=>action(async()=>{await rpc('editChat',{chatId:active,title:rename});await refresh()})),button(selected.archived?'恢复聊天':'归档聊天',()=>action(async()=>{await rpc('editChat',{chatId:active,archived:!selected.archived});await refresh();setDrawer(null)})),h('p',null,'归档只整理列表，不会删除共享记忆。')):null,
          h('details',{className:'dot-advanced'},h('summary',null,'存储与迁移'),h('p',null,'工作空间：'+snapshot?.workspace),h('p',null,'在“我的 Orivii”中创建或切换角色，无需重启。锁定后也可打开其他已有目录。'),button('导入旧版 Dot 聊天',importLegacy),h('p',null,'仅导入旧版聊天气泡，原有 DSH 记录保留。'))):null,
        drawer==='identities'?h(IdentitySettings,{onSwitch:switchIdentity,onError:fail}):null,
        drawer==='appearance'?h('div',{className:'dot-settings dot-appearance'},h('p',null,'选择你喜欢的配色，每个 Orivii 分别保存。气泡文字会自动选择清晰的黑色或白色。'),
          ...[['bubbleColor','我的气泡','#e2d7ff'],['replyColor','Orivii 的气泡','#d5eced'],['characterColor','Orivii 颜色','#d8a8ef']].map(([key,label,fallback])=>h('label',{key},h('span',null,label),h('div',{className:'dot-color-row'},h('input',{type:'color','aria-label':label,value:settings[key]||fallback,onChange:e=>setSettings(s=>({...s,[key]:e.target.value}))}),h('span',null,settings[key]||'跟随主题'),button('重置'+label,()=>setSettings(s=>({...s,[key]:''})))))),
          h('div',{className:'dot-color-presets'},...[['紫雾','#e2d7ff','#e4e0f0','#b39ddb'],['海盐','#ccecf0','#dae9eb','#63b8c4'],['杏桃','#ffe1cc','#f3dfd1','#e8a080'],['玫瑰','#f4d6e8','#eaddea','#d58db5']].map(([name,bubbleColor,replyColor,characterColor])=>button(name,()=>setSettings(s=>({...s,bubbleColor,replyColor,characterColor}))))),
          button('恢复主题默认',()=>setSettings(s=>({...s,...Object.fromEntries(APPEARANCE_KEYS.map(k=>[k,'']))}))),
          button('保存外观',()=>action(async()=>{await rpc('settings',{settings:Object.fromEntries(APPEARANCE_KEYS.map(k=>[k,settings[k]||'']))});await refresh();backDrawer()}),'dot-save')):null,
        drawer==='liveSettings'?h(React.Fragment,null,h(LiveSettings,{onError:fail}),h(BiliConnection)):null,
        drawer==='companion'?h('div',{className:'dot-settings'},h('p',null,'打开专用可见窗口，一起看当前视频或阅读文字。只观察你选择的站点，离开该站点会暂停。'),h('label',null,'网页地址',h('input',{value:mediaUrl,onChange:e=>setMediaUrl(e.target.value),placeholder:'https://www.bilibili.com/video/…'})),h('label',null,'一起做什么',h('select',{value:mediaMode,onChange:e=>setMediaMode(e.target.value)},h('option',{value:'video'},'看视频'),h('option',{value:'reading'},'读文章'))),button('打开陪伴窗口',startMedia,'dot-save',null,busy||!mediaUrl.trim()),button('陪伴与连接设置',()=>setDrawer('liveSettings')),h(BiliConnection)):null,
        ['persona','care','privacy','tasks'].includes(drawer)?h(CompanionSettings,{key:drawer,section:drawer,onError:fail,onSource:showSource,onMemories:()=>showMemories('permanent')}):null,
        drawer==='developer'?h(DeveloperPanel,{chatId:active,active:panelActive,onError:fail,onSource:showSource}):null,
        drawer==='profile'?h('div',{className:'dot-settings'},
          h('p',null,'告诉我你喜欢怎样相处。有不准确的地方，可以在这里改。'),
          ...[['preferredName','你喜欢的称呼',80],['identity','身份与生活背景',1200],['preferences','喜好与相处方式',2000]].map(([key,label,max])=>h('label',{key},h('span',null,label),h(key==='preferredName'?'input':'textarea',{'aria-label':label,value:profileDraft[key]||'',maxLength:max,rows:key==='preferredName'?undefined:3,onChange:e=>setProfileDraft(old=>({...old,[key]:e.target.value}))}),
            snapshot?.profile?.fields?.[key]?h('small',null,snapshot.profile.fields[key].origin==='user'?'你亲自设置的':'从聊天中记下的'):null,
            ...(snapshot?.profile?.fields?.[key]?.sourceIds||[]).map(id=>h('button',{type:'button',className:'dot-source-link',key:id,onClick:()=>showSource(id)},'查看原话')))),
          button('保存偏好',()=>action(async()=>{const changed=Object.fromEntries(Object.entries(profileDraft).filter(([key,value])=>value!==(snapshot?.profile?.fields?.[key]?.value||'')));await rpc('profile',{profile:changed});await refresh();setDrawer(null)}),'dot-save'),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:prefs.autoProfile!==false,onChange:e=>action(async()=>{await rpc('settings',{settings:{autoProfile:e.target.checked}});await refresh()})}),'从聊天中慢慢了解我'),
          h('p',null,'自动印象保留你的原话出处；你亲自修改或清空的字段不会被自动改回。')):null,
        drawer==='memory'?h('div',{className:'dot-settings'},
          h('p',null,'平时不用打理这里。如果有理解错的地方，你可以修改，或停用这条理解。原始聊天仍保留在聊天记录里。'),
          h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:prefs.autoLearn!==false,onChange:e=>action(async()=>{await rpc('settings',{settings:{autoLearn:e.target.checked}});await refresh()})}),'从交流中积累知识与共同话题'),
          h('div',{className:'dot-inbox-tabs'},...['permanent','knowledge','memes'].map((key,i)=>button(['重要的事','聊过的知识','共同话题'][i],()=>showMemories(key),'dot-text-button'+(layer===key?' is-active':'')))),
          ...memories.map(e=>h('article',{className:'dot-memory-entry',key:e.id},
            e.topic?h('strong',null,e.topic):null,
            e.status==='disputed'?h('small',null,'尚有疑问'):e.status==='superseded'?h('small',null,'已有后续修正'):null,
            h('p',null,e.text||e.summary),
            h('details',null,h('summary',null,'相关聊天'),sourceLinks(e)),
            button(e.enabled?'停用这条理解':'重新使用',()=>action(async()=>{await rpc('editMemory',{id:e.id,enabled:!e.enabled});await showMemories();await refresh()})),
            button('修改',()=>setMemoryEdit({id:e.id,text:e.text})),h(Motion,{show:memoryEdit?.id===e.id},memoryEdit?.id===e.id?h('div',{className:'dot-memory-edit'},h('textarea',{value:memoryEdit.text,onChange:event=>setMemoryEdit({...memoryEdit,text:event.target.value})}),button('保存修改',()=>action(async()=>{await rpc('editMemory',memoryEdit);await showMemories();await refresh()}))):null))),
          memories.length?null:h('p',null,'这里暂时没有需要调整的内容。')):null,
        drawer==='search'?h('div',{className:'dot-settings'},h('form',{onSubmit:e=>{e.preventDefault();action(async()=>setHits(await rpc('search',{query}))) }},h('label',null,'关键词',h('input',{value:query,onChange:e=>setQuery(e.target.value),maxLength:500})),h('button',{type:'submit',className:'dot-save'},'搜索所有聊天')),
          ...hits.map(m=>h('article',{className:'dot-memory-entry',key:m.id},h('small',null,new Date(m.time).toLocaleString()),h('p',null,m.excerpt),button('查看原文',()=>showSource(m.id),'dot-source-link')))):null,
        drawer==='source'&&source?h('div',{className:'dot-settings'},h('small',null,(source.role==='user'?'你':prefs.name)+' · '+new Date(source.time).toLocaleString()),h('div',{className:'dot-original'},source.text),button('打开这段聊天',()=>{select(source.chatId);setDrawer(null)})):null)):null))
  }
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID},DotPage))
  ctx.slots.inject('sidebar.panellist',()=>{
    let name=view.get().name
    const register=()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:11,label:name},DotSidebarIcon)
    let remove=register()
    // Re-register only when the saved name changes so DSH updates its native
    // title, collapsed tooltip and accessible label together.
    const unsubscribe=view.subscribe(()=>{
      const next=view.get().name
      if(next===name)return
      name=next;remove();remove=register()
    })
    return()=>{unsubscribe();remove()}
  })
}
