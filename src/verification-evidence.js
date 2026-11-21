import {isIP} from 'node:net'
import {publicUrl, readWeb, searchWeb} from './web.js'

const MAX_EXCERPT = 6500

function candidateUrl(value) {
  const url = publicUrl(value)
  if (!url) return null
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  // DSH also enforces its network policy after resolving each address.
  if (!hostname.includes('.') || isIP(hostname) || /\.(?:localhost|local|internal|lan)$/.test(hostname)) return null
  return url
}

function searchExcerpt(search, sources) {
  const data = {notice: search.notice, retrievedAt: search.retrievedAt, sources: []}
  for (const source of sources) {
    data.sources.push({...source, snippet: source.snippet.slice(0, 500)})
    if (JSON.stringify(data).length > MAX_EXCERPT) {
      data.sources.pop()
      break
    }
  }
  return {tool: 'web_search', excerpt: JSON.stringify(data)}
}

function pageExcerpt(page, title) {
  const data = {...page, title}
  let excerpt = JSON.stringify(data)
  while (excerpt.length > MAX_EXCERPT && data.content.length) {
    data.content = data.content.slice(0, Math.floor(data.content.length * 0.65))
    data.truncated = true
    excerpt = JSON.stringify(data)
  }
  return {tool: 'web_read', excerpt}
}

async function readCandidate(web, source, deadline) {
  if (deadline.aborted) return null
  let onAbort
  const stopped = new Promise(resolve => {
    onAbort = () => resolve(null)
    deadline.addEventListener('abort', onAbort, {once: true})
  })
  try {
    const page = await Promise.race([readWeb(web, source.url, deadline), stopped])
    if (!page || page.statusCode < 200 || page.statusCode >= 300 || !page.content.trim() || !candidateUrl(page.url)) return null
    return {source, page}
  } catch {
    return null
  } finally {
    deadline.removeEventListener('abort', onAbort)
  }
}

// Fetch evidence through the host's existing web service. A search result or
// a successfully opened page is evidence for the replying model to assess.
export async function lookupVerification(web, query, signal) {
  signal?.throwIfAborted()
  const empty = {status: 'failed', findings: '', evidence: [], sources: [], assets: []}
  let search
  try {
    search = await searchWeb(web, query, signal)
  } catch {
    signal?.throwIfAborted()
    return {...empty, unresolved: '联网查询未完成，这次没能核对到来源。', retrievedAt: new Date().toISOString()}
  }
  signal?.throwIfAborted()

  const candidates = search.sources.filter(source => candidateUrl(source.url))
  const hints = candidates.filter(source => source.snippet.trim())
  const sources = new Map(hints.map(({snippet, ...source}) => [source.url, {...source, retrievedAt: search.retrievedAt}]))
  const evidence = hints.length ? [searchExcerpt(search, hints)] : []
  const timeout = AbortSignal.timeout(8000)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  const reads = await Promise.all(candidates.slice(0, 2).map(source => readCandidate(web, source, deadline)))
  signal?.throwIfAborted()
  for (const item of reads) {
    if (!item) continue
    const {source, page} = item
    if (page.url !== source.url) sources.delete(source.url)
    const {snippet, ...metadata} = source
    sources.set(page.url, {...metadata, url: page.url, retrievedAt: page.retrievedAt})
    evidence.push(pageExcerpt(page, source.title))
  }

  const status = reads.some(Boolean) ? 'complete' : hints.length ? 'partial' : 'failed'
  const unresolved = status === 'complete' ? '' : status === 'partial'
    ? '只取得了搜索摘要，未能直接核对网页原文。'
    : '搜索已完成，未找到可用于核对的公开资料。'
  return {...empty, status, evidence, sources: [...sources.values()], unresolved, retrievedAt: search.retrievedAt}
}
