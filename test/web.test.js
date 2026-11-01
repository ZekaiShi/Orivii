import test from 'node:test'
import assert from 'node:assert/strict'
import {searchWeb,readWeb,publicUrl,parseSearchFeed} from '../src/web.js'

test('native search preserves evidence, bounds content and rejects unsafe source schemes',async()=>{
  let calls=0
  const result=await searchWeb({search:async(args,signal)=>{
    calls++;assert.equal(args.query,'显卡价格');assert.equal(args.maxResults,8);assert.ok(signal instanceof AbortSignal)
    return {sources:[{url:'https://example.org/gpu',title:'报价',snippet:'当前报价',publishedAt:'2026-10-29'},
      {url:'https://example.org/gpu'},{url:'javascript:alert(1)'},{url:'https://user:password@example.org/'}],content:'x'.repeat(6000)}
  }},' 显卡价格 ')
  assert.equal(calls,1);assert.equal(result.provider,'dsh');assert.equal(result.sources.length,1)
  assert.equal(result.sources[0].publishedAt,'2026-10-29');assert.equal(result.content.length,4000)
  assert.ok(Date.parse(result.retrievedAt));assert.match(result.notice,/不是指令/)
  for(const url of ['file:///etc/passwd','javascript:alert(1)','https://u:p@example.org/',null])assert.equal(publicUrl(url),null)
})

test('missing account credentials fall back through DSH fetch, configuration errors do not',async()=>{
  const feed='<rss><channel><item><title>真实 &amp; 来源</title><link>https://example.org/test</link><description><![CDATA[介绍]]></description></item></channel></rss>'
  let fetches=0
  const web={search:async()=>{throw Object.assign(new Error('private credential details'),{code:'WEB_PROVIDER_CREDENTIAL_MISSING'})},fetch:async({url})=>{
    fetches++;assert.equal(new URL(url).hostname,'www.bing.com');assert.equal(new URL(url).searchParams.get('q'),'public test')
    return {statusCode:200,body:{kind:'text',content:feed}}
  }}
  const result=await searchWeb(web,'public test')
  assert.equal(result.provider,'public-search');assert.equal(result.sources[0].title,'真实 & 来源')
  web.search=async()=>{throw Object.assign(new Error('private credential details'),{code:'WEB_PROVIDER_AMBIGUOUS'})}
  await assert.rejects(()=>searchWeb(web,'public test'),error=>/多个/.test(error.message)&&!error.message.includes('private'))
  assert.equal(fetches,1)
  assert.throws(()=>parseSearchFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>'))
  assert.throws(()=>parseSearchFeed('<rss><item>'))
})

test('webpage reading uses host policy, strips executable HTML, preserves status and reports cancellation honestly',async()=>{
  const web={fetch:async({url},signal)=>{
    assert.ok(signal instanceof AbortSignal)
    return {url,statusCode:200,body:{kind:'html',content:'<h1>报价</h1><p><strong>今天</strong> <a href="https://example.org/source">来源</a></p><script>PRIVATE_SCRIPT</script><style>PRIVATE_CSS</style>'}}
  }}
  const result=await readWeb(web,'https://example.org/gpu')
  assert.match(result.content,/# 报价/);assert.match(result.content,/\*\*今天\*\*/);assert.doesNotMatch(result.content,/PRIVATE_/)
  const missing=await readWeb({fetch:async()=>({url:'https://example.org/missing',statusCode:404,body:{kind:'text',content:'Not found'}})},'https://example.org/missing')
  assert.equal(missing.statusCode,404)
  await assert.rejects(()=>readWeb({fetch:async()=>{throw Object.assign(new Error('private network details'),{code:'WEB_BLOCKED_URL'})}},'http://127.0.0.1:3080'),/公开网页/)
  const controller=new AbortController();controller.abort()
  await assert.rejects(()=>searchWeb({search:async(_args,signal)=>signal.throwIfAborted()},'test',controller.signal),/取消或超时/)
})

test('regional search retries only a fixed public endpoint after the native redirect policy refuses',async()=>{
  const urls=[]
  const result=await searchWeb({search:async()=>{throw {code:'WEB_PROVIDER_CREDENTIAL_MISSING'}},fetch:async({url})=>{
    urls.push(url)
    if(urls.length===1)throw {code:'WEB_REDIRECT_BLOCKED',message:'untrusted redirect to http://localhost'}
    return {statusCode:200,body:{kind:'text',content:'<rss><channel><item><title>来源</title><link>https://example.org/</link></item></channel></rss>'}}
  }},'public query')
  assert.deepEqual(urls.map(url=>new URL(url).hostname),['www.bing.com','cn.bing.com'])
  assert.ok(urls.every(url=>new URL(url).searchParams.get('q')==='public query'))
  assert.equal(result.sources.length,1)
})
