// Diagnostics use a fixed synthetic prompt, never a user's conversation.
export function modelFailure(failure){
  if(!failure)return null
  const message=String(failure.message||'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[redacted]')
    .replace(/(?:api[_-]?key|authorization|cookie|token)\s*[:=]\s*[^\s,;]+/gi,'[credential redacted]')
    .replace(/https?:\/\/[^\s)]+/g,'[provider URL]').slice(0,1000)
  return {code:String(failure.code||'MODEL_ERROR').slice(0,80),message,...(Number.isInteger(failure.status)?{status:failure.status}:{})}
}
