export function createLiveSettings(React,{rpc}){
  const h=React.createElement,{useState,useEffect}=React
  return function LiveSettings({onError}){
    const [data,setData]=useState(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
    useEffect(()=>{let alive=true;rpc('liveSettings').then(value=>{if(alive)setData(value)}).catch(error=>{if(alive)onError(error)});return()=>{alive=false}},[])
    if(!data)return h('p',{role:'status'},'正在读取陪伴设置…')
    const s=data.settings,edit=(key,value)=>setData(old=>({...old,settings:{...old.settings,[key]:value}}))
    async function save(){if(busy)return;setBusy(true);try{setData(await rpc('liveSettings',{settings:s}));setNotice('已保存。')}catch(error){onError(error)}finally{setBusy(false)}}
    return h('fieldset',{className:'dot-settings',disabled:busy,style:{border:0,padding:0,margin:0,minWidth:0}},
      h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:s.mediaEnabled,onChange:e=>edit('mediaEnabled',e.target.checked)}),'开启陪伴窗口（预览）'),
      h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:s.commentary,onChange:e=>edit('commentary',e.target.checked)}),'暂停时偶尔说说感受'),
      h('p',null,'仅查看你打开的陪伴窗口。画面按需交给当前对话模型处理；原始截图默认不保留。'),
      h('details',{open:true},h('summary',null,'陪看连接'),h('p',null,'画面默认交给当前对话模型理解，沿用 DSH 中的模型与登录配置，无需另填视觉密钥。'),h('p',{role:'status'},data.vision?.mode==='chat'?'正在使用对话模型：'+data.vision.model:(data.vision?.reason||'模型图片能力将在陪看时检查。')),h('p',null,data.browserAvailable?'浏览器服务已连接。':'需要 @anweat/dsh-browser，并关闭 headless。'),h('p',null,data.biliAvailable?'B 站读取工具已连接。':'可安装 dsh-bili-watch 读取视频内容。')),
      h('details',null,h('summary',null,'自主探索（预览）'),h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:s.exploration,onChange:e=>edit('exploration',e.target.checked)}),'允许空闲时探索指定话题'),h('textarea',{value:s.exploreTopics.join('\n'),placeholder:'每行一个允许探索的公开话题，最多8个',onChange:e=>edit('exploreTopics',e.target.value.split('\n').filter(Boolean).slice(0,8))}),h('small',null,'默认关闭。开启后每天最多两次，只读公开资料，不发评论，不携带私人聊天。')),
      h('button',{type:'button',className:'dot-save',disabled:busy,onClick:save},busy?'保存中…':'保存'),notice?h('p',{role:'status'},notice):null)
  }
}
