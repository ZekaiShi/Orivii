export function createIdentitySettings(React,{rpc}){
  const h=React.createElement,{useState,useEffect,useRef}=React
  return function IdentitySettings({onSwitch,onError}){
    const [data,setData]=useState(null),[busy,setBusy]=useState(false),[selected,setSelected]=useState(''),[password,setPassword]=useState('')
    const [name,setName]=useState(''),[persona,setPersona]=useState(''),[newPassword,setNewPassword]=useState(''),[confirm,setConfirm]=useState(''),[plaintext,setPlaintext]=useState(false),[notice,setNotice]=useState('')
    const alive=useRef(true)
    async function load(){const result=await rpc('identities');if(alive.current)setData(result)}
    useEffect(()=>{alive.current=true;load().catch(onError);return()=>{alive.current=false}},[])
    async function act(fn){if(busy)return;setBusy(true);setNotice('');try{await fn()}catch(e){if(alive.current)onError(e)}finally{if(alive.current)setBusy(false)}}
    if(!data)return h('p',{role:'status'},'正在读取 Orivii 列表…')
    const target=data.items.find(item=>item.id===selected)
    const button=(label,fn,disabled=false)=>h('button',{type:'button','aria-label':label,disabled:busy||disabled,className:'dot-text-button',onClick:()=>act(fn)},label)
    return h('div',{className:'dot-settings','aria-label':'我的 Orivii'},
      h('p',null,'每个 Orivii 有自己的性格、聊天与记忆。已解锁的角色可以直接切换，后台文字任务仍属于原角色。'),
      h('label',null,'切换 Orivii',h('select',{'aria-label':'切换 Orivii',value:selected,disabled:busy,onChange:e=>{setSelected(e.target.value);setPassword('')}},h('option',{value:''},'选择一个 Orivii'),...data.items.map(item=>h('option',{key:item.id,value:item.id,disabled:item.active},item.name+(item.active?' · 当前':item.unlocked?' · 已解锁':' · 待解锁'))))),
      target?.encrypted&&!target.unlocked?h('label',null,'这个 Orivii 的密码',h('input',{type:'password',autoComplete:'current-password',value:password,maxLength:1024,disabled:busy,onChange:e=>setPassword(e.target.value)})):null,
      button('切换到这个 Orivii',async()=>{await onSwitch('identitySwitch',{identityId:selected,...(password?{password}:{})});if(alive.current)setPassword('')},!target||target.active||target.encrypted&&!target.unlocked&&!password),
      h('details',null,h('summary',null,'创建另一个 Orivii'),
        h('label',null,'名字',h('input',{'aria-label':'新 Orivii 名字',value:name,maxLength:200,disabled:busy,onChange:e=>setName(e.target.value)})),
        h('label',null,'最初的相处方式',h('textarea',{'aria-label':'新 Orivii 相处方式',value:persona,maxLength:2000,rows:4,disabled:busy,placeholder:'例如：温柔耐心，话不多；或者活泼爱玩梗，偶尔和我斗嘴。',onChange:e=>setPersona(e.target.value)})),
        h('label',{className:'dot-check'},h('input',{type:'checkbox',checked:plaintext,disabled:busy,onChange:e=>{setPlaintext(e.target.checked);setNewPassword('');setConfirm('')}}),'使用明文保存（没有密码保护）'),
        plaintext?h('small',null,'明文资料可被拥有该目录读取权限的程序访问。'):h(React.Fragment,null,
          h('label',null,'新 Orivii 解锁密码',h('input',{type:'password',autoComplete:'new-password',value:newPassword,minLength:10,maxLength:1024,disabled:busy,onChange:e=>setNewPassword(e.target.value)})),
          h('label',null,'再次输入密码',h('input',{type:'password',autoComplete:'new-password',value:confirm,maxLength:1024,disabled:busy,onChange:e=>setConfirm(e.target.value)}))),
        h('small',null,'自动建立独立资料目录；原角色的聊天、记忆和密钥不会复制过去。'),
        button('创建并切换',async()=>{if(!plaintext&&newPassword!==confirm)throw new Error('两次密码不一致。');await onSwitch('identityCreate',{name:name.trim(),persona,...(plaintext?{plaintext:true,plaintextAcknowledgement:'明文没有密码保护'}:{password:newPassword})});if(alive.current){setNewPassword('');setConfirm('')}},!name.trim()||!plaintext&&(newPassword.length<10||!confirm))),
      h('hr'),h('label',null,'当前 Orivii 的解锁期限',h('select',{'aria-label':'解锁期限',value:data.session?.mode||'run',disabled:busy,onChange:e=>{const mode=e.target.value;act(async()=>{await rpc('sessionPolicy',{mode});await load();if(alive.current)setNotice('已保存。延长期限需下次输入密码后生效。')})}},h('option',{value:'run'},'本次 DSH 运行'),h('option',{value:'8h'},'每 8 小时验证'),h('option',{value:'24h'},'每 24 小时验证'))),
      h('small',null,'刷新或关闭页面后可恢复。手动锁定会锁住全部 Orivii；DSH 退出、电脑重启后需重新输入密码。'),
      data.session?.expiresAt?h('p',null,'下次验证：'+new Date(data.session.expiresAt).toLocaleString()):null,
      notice?h('p',{role:'status'},notice):null)
  }
}
