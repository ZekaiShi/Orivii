const b64=bytes=>{let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text)}
export async function uploadChatFile(file,rpc,signal){
  signal?.throwIfAborted();const start=await rpc('fileBegin',{name:file.name,size:file.size,mediaType:file.type||'application/octet-stream'})
  try{
    for(let offset=0;offset<file.size;offset+=start.chunkSize){signal?.throwIfAborted();const bytes=new Uint8Array(await file.slice(offset,offset+start.chunkSize).arrayBuffer());signal?.throwIfAborted();await rpc('fileChunk',{id:start.id,offset,data:b64(bytes)})}
    signal?.throwIfAborted();const saved=await rpc('fileFinish',{id:start.id});if(signal?.aborted){await rpc('fileDiscard',{id:saved.id}).catch(()=>{});signal.throwIfAborted()}return saved
  }catch(e){if(e.code!=='stale')await rpc('fileCancel',{id:start.id}).catch(()=>{});throw e}
}
export async function downloadChatFile(file,rpc,signal){
  let offset=0;const chunks=[]
  while(offset<file.size){signal?.throwIfAborted();const part=await rpc('fileRead',{id:file.id,offset});signal?.throwIfAborted();if(part.next<=offset||part.next>file.size||part.size!==file.size)throw new Error('文件传输不完整。');const bytes=Uint8Array.from(atob(part.data),c=>c.charCodeAt(0));if(bytes.length!==part.next-offset)throw new Error('文件分片长度不一致。');chunks.push(bytes);offset=part.next}
  return new Blob(chunks,{type:file.kind==='image'?file.mediaType:'application/octet-stream'})
}
export function createFileCard(React,{rpc}){
  const h=React.createElement
  return function FileCard({file,onError=()=>{}}){
    const image=file.kind==='image',label=file.name+' · '+Math.max(1,Math.round(file.size/1024))+' KB'
    const [url,setUrl]=React.useState(''),[busy,setBusy]=React.useState(false),[failed,setFailed]=React.useState(false),guard=React.useRef(null)
    React.useEffect(()=>{const c=new AbortController();guard.current=c;let objectUrl
      if(file.kind==='image')downloadChatFile(file,rpc,c.signal).then(blob=>{if(c.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)}).catch(()=>{if(!c.signal.aborted)setFailed(true)})
      return()=>{c.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
    },[file.id])
    async function save(){setBusy(true);try{const blob=await downloadChatFile(file,rpc,guard.current.signal);if(guard.current.signal.aborted)return;const href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}catch(e){if(!guard.current?.signal.aborted)onError(e)}finally{if(!guard.current?.signal.aborted)setBusy(false)}}
    return h('div',{className:'dot-file-card'+(image?' dot-image-card':'')},
      image?h('div',{className:'dot-image-preview'},url?h('img',{src:url,alt:file.name,loading:'lazy'}):h('span',{role:failed?'note':'status'},failed?'图片预览暂不可用，可尝试下载。':'图片加载中…')):null,
      h('button',{type:'button',className:image?'dot-icon-button dot-image-download':'dot-file-download',disabled:busy,onClick:save,'aria-label':image?'下载 '+file.name:undefined,'aria-busy':busy,title:image?label+(busy?' · 下载中…':' · 下载'):undefined},image?
        h('svg',{width:20,height:20,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:'M12 4v11m-4-4 4 4 4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3'})):
        label+(busy?' · 下载中…':' · 下载')))
  }
}
