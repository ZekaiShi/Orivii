import {dotExpression,cleanReply} from './expression.js'
import {createReplyInk} from './ink.js'
import {filePreviewKind} from './visual.js'

// Only an explicit, first-line visible-reply header opts into live delivery.
// Unmarked tool narration and all reasoning continue to stay private.
export function visibleReply(text) {
  const header=text.match(/^\s*\[dot-reply:([^\]\r\n]{0,80})\]\r?\n/)
  if(!header)return null
  return cleanReply(text.slice(header[0].length),header[1])
}

// Split conversational paragraphs for display, never the stored original.
// Structured Markdown stays together so lists/tables/code keep their meaning.
export function bubbleParts(text) {
  if(/^[ \t]*(?:`{3,}|~{3,}|>|#{1,6}\s|[-+*]\s|\d+[.)]\s|\[[^\]]+\]:|<\/?[a-z])/mi.test(text)||/\|.+\|/.test(text)||/^\s*\|?\s*:?-+:?\s*\|\s*:?-+/m.test(text)||/^(?: {4}|\t)\S/m.test(text)||/\n {2,}\S/.test(text))return [text]
  const parts=text.split(/\r?\n+/).map(part=>part.trim()).filter(Boolean)
  return parts.length>16?[...parts.slice(0,15),parts.slice(15).join('\n\n')]:parts.length?parts:[text]
}

// Keep archived messages intact; give every attached image its own display
// bubble even when a model sends its caption and files in the same message.
export function messageBubbleParts(message) {
  const parts=[],body=message.presentation?.artifactOnly?'':message.text
  const addText=(text,offset)=>{if(text.trim())for(const [i,part]of (message.role==='assistant'?bubbleParts(text):[text]).entries())parts.push({key:'text:'+offset+':'+i,kind:'text',text:part})}
  let at=0,last=0
  if(message.role==='assistant'){
    const lines=body.match(/[^\n]*\n|[^\n]+$/g)||[]
    for(let i=0;i<lines.length;i++){
      const open=lines[i].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/)
      if(!open){at+=lines[i].length;continue}
      const start=at,language=open[2].trim().toLowerCase(),contentAt=at+lines[i].length;let end=i+1,position=contentAt
      for(;end<lines.length;end++){if(new RegExp('^ {0,3}'+open[1][0]+'{'+open[1].length+',}\\s*$').test(lines[end].trimEnd()))break;position+=lines[end].length}
      if(['html','svg','orivii-visual'].includes(language)){
        addText(body.slice(last,start),last)
        const complete=end<lines.length
        parts.push({key:'markup:'+start,kind:complete||!message.live?'markup':'markup-pending',format:language==='orivii-visual'?'visual':language,source:body.slice(contentAt,position),text:''})
        last=complete?position+lines[end].length:body.length
      }
      at=end<lines.length?position+lines[end].length:body.length;i=end
    }
  }
  addText(body.slice(last),last)
  const files=(message.attachments||[]).filter(file=>file.kind!=='image'&&!filePreviewKind(file))
  if(files.length){
    if(!parts.length)parts.push({key:'files',kind:'files',text:''})
    parts.at(-1).attachments=files
  }
  if(!parts.length&&(message.connection||message.webSources?.length))parts.push({key:'text:0',kind:'text',text:''})
  for(const file of message.attachments||[])if(file.kind==='image')parts.push({key:'image:'+file.id,kind:'image',text:'',attachments:[file]});else if(filePreviewKind(file))parts.push({key:'artifact:'+file.id,kind:'artifact',text:'',file})
  return parts
}

const replySegments=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null
export function nextReplyText(current,target) {
  if(!target.startsWith(current))return target
  // Four characters per beat for chat; longer answers finish in about 80 beats.
  // Segment only the next batch so emoji sequences are never cut in half.
  const step=Math.max(4,Math.ceil(target.length/80)),rest=target.slice(current.length)
  let next=current,count=0
  for(const unit of replySegments?replySegments.segment(rest):Array.from(rest)){
    next+=typeof unit==='string'?unit:unit.segment
    if(++count>=step)break
  }
  return next
}

export function createPacedReply(React) {
  return function PacedReply({message,pace,render,onProgress}) {
    const [shown,setShown]=React.useState(()=>pace?nextReplyText('',message.text):message.text)
    const root=React.useRef(null),state=React.useRef({text:shown,timer:null,sync:null}),ink=React.useRef(null)
    const latest=React.useRef(null);latest.current={text:message.text,pace,onProgress}
    React.useLayoutEffect(()=>{
      const doc=root.current.ownerDocument,win=doc.defaultView,media=win.matchMedia?.('(prefers-reduced-motion: reduce)'),s=state.current
      ink.current=createReplyInk(root.current)
      const stop=()=>{if(s.timer!==null)win.clearTimeout(s.timer);s.timer=null}
      const enabled=()=>latest.current.pace&&!doc.hidden&&!media?.matches
      const flush=()=>{stop();s.text=latest.current.text;setShown(s.text)}
      const tick=()=>{
        s.timer=null
        if(!enabled()){flush();return}
        s.text=nextReplyText(s.text,latest.current.text);setShown(s.text)
        if(s.text!==latest.current.text)s.timer=win.setTimeout(tick,100)
      }
      s.sync=()=>{
        if(!enabled()||!latest.current.text.startsWith(s.text)){flush();return}
        if(s.text!==latest.current.text&&s.timer===null)s.timer=win.setTimeout(tick,100)
      }
      doc.addEventListener('visibilitychange',s.sync);media?.addEventListener?.('change',s.sync);s.sync()
      return()=>{stop();ink.current?.dispose();ink.current=null;doc.removeEventListener('visibilitychange',s.sync);media?.removeEventListener?.('change',s.sync);s.sync=null}
    },[])
    React.useLayoutEffect(()=>{state.current.sync?.()},[message.text,pace])
    React.useLayoutEffect(()=>{ink.current?.update(pace);latest.current.onProgress?.()},[shown,message.text,pace])
    const text=pace&&message.text.startsWith(shown)?shown:message.text
    return React.cloneElement(render({...message,text,live:message.live||text!==message.text}),{ref:root})
  }
}
