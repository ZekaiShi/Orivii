import {randomUUID} from 'node:crypto'

// A fresh native DSH session receives only explicitly delegated user text.
// No Dot history, personality, analysis, credential or memory object enters here.
export function workspaceBridge(agents){
  return {
    async start({sessionId,cwd,text,selection,onMessage,signal}){
      let reason='interrupted',handle,cancel
      try{
        handle=await agents.create({sessionId,meta:{cwd},agentOptions:selection,signal,setup:(ctx)=>{
          ctx.on('session/event',(session,event)=>{
            if(session.id!==sessionId)return
            if(event.type==='turn/end')reason=event.data?.reason?.kind||'interrupted'
            if(event.type!=='assistant/message'||event.surfaceOp!=='append')return
            const m=event.data?.message
            if(m?.role!=='assistant'||m.source?.kind!=='model')return
            const text=m.content?.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n')
            if(text)onMessage({role:'assistant',text:text.slice(0,100000),time:Date.now()})
          })
        }})
        cancel=()=>handle.agent.cancel({kind:'disposed'})
        signal.addEventListener('abort',cancel,{once:true})
        if(signal.aborted)throw new Error('cancelled')
        handle.agent.followup({id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text}]})
        const promise=handle.agent.whenIdle().then(()=>({status:reason==='completed'?'done':reason==='cancelled'?'cancelled':'interrupted'})).finally(async()=>{signal.removeEventListener('abort',cancel);await handle.dispose()})
        return {promise,cancel}
      }catch(e){if(cancel)signal.removeEventListener('abort',cancel);if(handle)await handle.dispose().catch(()=>{});throw e}
    },
  }
}
