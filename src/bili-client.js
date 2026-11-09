// Reuse the installed plugin's authenticated same-origin API. Cookies never
// pass through Orivii's model, archive, settings or workspace.
export async function biliRequest(route,body,signal,fetcher=fetch,provider='watch'){
  if(!['/login/qr','/login/poll','/status'].includes(route))throw new Error('不支持的 B 站登录操作。')
  if(!['watch','scroll'].includes(provider))throw new Error('当前插件未提供扫码接口。')
  const url=provider==='scroll'?'/api/bili-duty'+(route==='/login/qr'?'/login/start':route):'/api/bili-watch'+route
  const response=await fetcher(url,{method:route==='/status'?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},...(route==='/status'?{}:{body:JSON.stringify(body||{})}),signal})
  if(!response.ok)throw new Error('扫码服务未就绪，请在当前 DSH 插件页检查 B站插件。')
  const text=await response.text();if(text.length>200000)throw new Error('扫码响应无效。')
  let result
  try{result=JSON.parse(text)}catch{throw new Error('B 站插件返回了无法识别的登录状态。')}
  if(route==='/status')return {ok:result.ok,credentialPresent:result.data?.credential?.exists===true,dependencies:(result.data?.deps||[]).map(d=>({id:d.id,ok:d.ok===true}))}
  // Keep credential, filesystem and other provider fields out of UI state.
  if(route==='/login/poll')return {ok:result.ok,state:result.state}
  return {ok:result.ok,data:provider==='scroll'?{key:result.key,png:result.qr}:{key:result.data?.key,svg:result.data?.svg}}
}
export function qrImage(data,Parser=globalThis.DOMParser){
  if(data?.svg)return qrSource(data.svg,Parser)
  if(typeof data?.png==='string'&&data.png.length<160000&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(data.png))return data.png
  throw new Error('插件未返回二维码图片，请先在原插件中检查运行依赖。')
}
export function qrSource(svg,Parser=globalThis.DOMParser){
  if(typeof svg!=='string'||svg.length>80000||/<!DOCTYPE|<!ENTITY/i.test(svg))throw new Error('二维码格式无效。')
  const document=new Parser().parseFromString(svg,'image/svg+xml'),root=document.documentElement
  if(root.localName!=='svg'||root.namespaceURI!=='http://www.w3.org/2000/svg'||document.querySelector('parsererror'))throw new Error('二维码格式无效。')
  const allowed=new Set(['svg','path','rect']),attrs=new Set(['xmlns','viewBox','width','height','fill','stroke','stroke-width','d','x','y','shape-rendering'])
  for(const el of [root,...root.querySelectorAll('*')]){
    if(!allowed.has(el.localName))throw new Error('二维码包含不支持的内容。')
    for(const attr of [...el.attributes])if(!attrs.has(attr.name)||/url\(|javascript:|data:/i.test(attr.value))throw new Error('二维码属性无效。')
  }
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(root.outerHTML)
}
export function createBiliConnection(React,{rpc,fetcher=globalThis.fetch}){
  const h=React.createElement
  const attempted=new Set()
  return function BiliConnection({autoLogin=false,messageId}={}){
    const [info,setInfo]=React.useState(null),[qr,setQr]=React.useState(null),[status,setStatus]=React.useState(''),[busy,setBusy]=React.useState(false)
    const session=React.useRef(null),mounted=React.useRef(false)
    const stop=()=>{session.current?.abort();session.current=null}
    async function check(){
      try{
        let next=await rpc('biliConnection')
        if(next.loginProvider==='watch'){
          const status=await biliRequest('/status',{},AbortSignal.timeout(12000),fetcher,'watch')
          if(status.ok)next={...next,state:status.credentialPresent?'unknown':'needs_login',credentialPresent:status.credentialPresent,dependencies:status.dependencies}
        }
        if(!mounted.current)return;setInfo(next);setStatus('');return next
      }
      catch{if(mounted.current)setStatus('连接检查暂未完成，可以重新检测。')}
    }
    React.useEffect(()=>{
      mounted.current=true
      check().then(next=>{
        if(mounted.current&&autoLogin&&messageId&&!attempted.has(messageId)&&next?.state==='needs_login'&&next.loginProvider&&!globalThis.document?.hidden){
          attempted.add(messageId);if(attempted.size>100)attempted.delete(attempted.values().next().value)
          login(next.loginProvider)
        }
      })
      return()=>{mounted.current=false;stop()}
    },[])
    React.useEffect(()=>{if(typeof document==='undefined')return;const hidden=()=>{if(document.hidden){stop();setQr(null);setBusy(false);setStatus('登录已暂停，需要时重新生成二维码。')}};document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden)},[])
    async function login(provider=info?.loginProvider){
      stop();const controller=new AbortController();session.current=controller;const signal=controller.signal
      setBusy(true);setQr(null);setStatus('正在生成二维码…')
      const timeout=setTimeout(()=>controller.abort(),180000)
      try{
        const result=await biliRequest('/login/qr',{},AbortSignal.any([signal,AbortSignal.timeout(12000)]),fetcher,provider)
        if(signal.aborted)return
        if(!result.ok||typeof result.data?.key!=='string'||result.data.key.length>256)throw new Error('未能生成二维码，请在原插件中重试。')
        setQr(qrImage(result.data));setStatus('用哔哩哔哩 App 扫码，并在手机上确认。')
        while(!signal.aborted){
          await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve()},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('cancelled'))},timer=setTimeout(done,2500);signal.addEventListener('abort',abort,{once:true})})
          const next=await biliRequest('/login/poll',{key:result.data.key},AbortSignal.any([signal,AbortSignal.timeout(12000)]),fetcher,provider)
          if(signal.aborted)return
          if(next.state==='ok'){setStatus('登录成功，后续读取沿用这个插件的登录。');setInfo(old=>({...old,state:'connected',credentialPresent:true}));setQr(null);break}
          if(next.state==='scanned'){setStatus('已扫码，请在手机上确认。');continue}
          if(next.state==='expired')throw new Error('二维码已过期，请重新扫码。')
          if(next.state!=='waiting')throw new Error('登录未完成，请重新扫码或前往原插件检查。')
        }
      }catch(e){if(session.current===controller){setQr(null);setStatus(signal.aborted?'二维码已过期或登录已取消。':e.message)}}
      finally{clearTimeout(timeout);if(session.current===controller){setBusy(false);session.current=null}}
    }
    const summary=!info?'正在检查插件与登录…':info.state==='connected'?'已沿用原插件的登录，可以继续读取。':info.state==='needs_login'?'已连接 B站插件，请扫码登录。':info.state==='plugin_missing'?'当前环境尚未加载 B站插件。Web 与 Desktop 分别管理插件。':info.credentialPresent?'已有登录配置，本次验证暂未完成。可以先尝试读取，再按实际结果处理。':'暂未确认登录状态，可以重新检测或使用原插件的登录入口。'
    return h('section',{className:'dot-bili-connection','aria-label':'B 站连接'},h('strong',null,'B 站内容'),
      h('p',null,summary),
      info?.dependencies?.some(d=>['asr','model'].includes(d.id)&&!d.ok)?h('small',null,'本地转写环境或模型尚未就绪；无字幕视频暂不能依靠音轨转写。请在 bili-watch 依赖面板完成配置。'):null,
      info?.state==='plugin_missing'?h(React.Fragment,null,h('code',null,'dsh.cmd plugin --profile web add dsh-bili-watch'),h('small',null,'Windows Web 版安装命令。Linux 使用 dsh；Desktop 在插件市场安装。字幕、本地转写与 OCR 的依赖和登录在原插件中管理。')):null,
      info?.loginProvider?h('button',{type:'button',disabled:busy,onClick:()=>login()},info.state==='connected'?'切换 B站账号':'扫码登录'):null,
      h('button',{type:'button',disabled:busy,onClick:check},'重新检测'),
      busy?h('button',{type:'button',onClick:()=>{stop();setBusy(false);setQr(null);setStatus('登录已取消。')}},'取消扫码'):null,
      qr?h('img',{className:'dot-login-qr',src:qr,alt:'使用哔哩哔哩 App 扫码登录',referrerPolicy:'no-referrer'}):null,
      status?h('p',{role:'status'},status):null,
      h('small',null,'二维码只在当前页面显示。登录由原插件保存，后续读取继续复用。'))
  }
}
