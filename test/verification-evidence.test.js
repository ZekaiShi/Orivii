import test from 'node:test'
import assert from 'node:assert/strict'
import {lookupVerification} from '../src/verification-evidence.js'

test('verification reads at most two search-returned public pages in parallel', async () => {
  const official = 'https://example.org/official'
  const unreadable = 'https://example.net/notice'
  const reads = []
  let release
  const bothStarted = new Promise(resolve => { release = resolve })
  const web = {
    async search({query}) {
      assert.equal(query, 'Node.js official release')
      return {sources: [
        {url: 'http://127.0.0.1:3080/', snippet: 'local'},
        {url: official, title: 'Release notes'},
        {url: unreadable, title: 'Search hint', snippet: 'A result preview'},
        {url: 'https://example.org/third', title: 'Third result', snippet: 'Another preview'},
      ]}
    },
    async fetch({url}) {
      reads.push(url)
      if (reads.length === 2) release()
      await bothStarted
      return url === official
        ? {url, statusCode: 200, body: {kind: 'html', content: '<h1>Release evidence</h1><p>' + '段落'.repeat(5000) + '</p>'}}
        : {url, statusCode: 404, body: {kind: 'text', content: 'Not usable page evidence'}}
    },
  }
  const result = await lookupVerification(web, 'Node.js official release')
  assert.deepEqual(reads, [official, unreadable])
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.evidence.map(item => item.tool), ['web_search', 'web_read'])
  assert.ok(result.evidence.every(item => item.excerpt.length <= 6500))
  const page = JSON.parse(result.evidence[1].excerpt)
  assert.equal(page.url, official)
  assert.equal(page.truncated, true)
  assert.match(page.content, /Release evidence/)
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|Not usable page evidence/)
})

test('snippets, absent sources, and an unavailable service have distinct results', async () => {
  const url = 'https://example.org/notice'
  const partial = await lookupVerification({
    search: async () => ({sources: [{url, snippet: 'A result preview'}]}),
    fetch: async () => ({url, statusCode: 200, body: {kind: 'text', content: '   '}}),
  }, 'public notice')
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.evidence.map(item => item.tool), ['web_search'])
  assert.match(partial.unresolved, /仅|只取得/)

  const none = await lookupVerification({search: async () => ({sources: [], content: 'Uncited summary'})}, 'public notice')
  assert.equal(none.status, 'failed')
  assert.deepEqual(none.evidence, [])
  assert.match(none.unresolved, /未找到/)

  const offline = await lookupVerification({search: async () => { throw new Error('host details') }}, 'public notice')
  assert.equal(offline.status, 'failed')
  assert.match(offline.unresolved, /未完成/)
  assert.doesNotMatch(JSON.stringify(offline), /host details/)
})

test('cancelling during page reads prevents a late verification result', async () => {
  const controller = new AbortController()
  let started
  const reading = new Promise(resolve => { started = resolve })
  const web = {
    search: async () => ({sources: [{url: 'https://example.org/notice', snippet: 'A result preview'}]}),
    fetch: async () => { started(); await new Promise(() => {}) },
  }
  const request = lookupVerification(web, 'public notice', controller.signal)
  await reading
  controller.abort(new Error('user cancellation'))
  await assert.rejects(request, /user cancellation/)
})
