import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DotHost} from '../src/host.js'
import {appendBubble} from '../src/memory.js'

const question = '请查一下 Node.js 最新 LTS 版本'
const acknowledgement = '好，我看看。'
const plainReply = '就按你方便的来。'
const verifiedReply = '我核对了发布页，这份测试资料标注的是 24.2.0。'

async function until(read, label) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${label}`)
}

function gate() {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  return {waiting, release}
}

async function fixture(t, web, {webSearch = true} = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'orivii-verification-'))
  const requests = []
  const services = {
    web,
    defaultModel: {currentSelection: () => ({provider: 'fixture', model: 'fixture'})},
    llm: {async prepareCall(config) {
      return {config, context: {contextWindow: 128000}, async *stream(options) {
        requests.push(options)
        const text = options.purpose ? '{}' : options.system.includes('[BACKGROUND_RESULT_DELIVERY]')
          ? '[dot-reply:relieved]\n' + verifiedReply
          : plainReply
        yield {type: 'block-end', index: 0, block: {type: 'text', text}}
        yield {type: 'finish', reason: {kind: 'stop'}}
      }}
    }},
  }
  const host = new DotHost(services, {pointer: path.join(root, 'pointer.json')})
  t.after(async () => { await host.dispose(); await fs.rm(root, {recursive: true, force: true}) })
  const opened = await host.command({
    action: 'setup', workspace: path.join(root, 'workspace'), plaintext: true,
    plaintextAcknowledgement: '明文没有密码保护',
    settings: {webSearch, autoPermanent: false, autoProfile: false, autoLearn: false},
  })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  async function call(action, args = {}) {
    const result = await host.command({action, token: opened.value.token, ...args})
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  await call('extension', {request: {operation: 'savePolicy', policy: {analysisEnabled: false}}})
  const chat = await call('createChat')
  const snapshot = (chatId = chat.id) => call('snapshot', {chatId})
  const send = (text, chatId = chat.id) => call('send', {chatId, text, requestId: randomUUID()})
  return {host, requests, call, chat, snapshot, send}
}

test('the short reply is persisted before public lookup and grounded results arrive while other chats stay usable', async t => {
  const blockedSearch = gate()
  const searches = [], reads = []
  const source = 'https://example.org/public-release'
  const f = await fixture(t, {
    async search(request) {
      searches.push(request.query)
      await blockedSearch.waiting
      return {sources: [{url: source, title: '测试发布页', snippet: 'SYNTHETIC_SEARCH_EXCERPT'}]}
    },
    async fetch({url}) {
      reads.push(url)
      return {url, statusCode: 200, body: {kind: 'text', content: 'SYNTHETIC_PAGE_EVIDENCE: 24.2.0'}}
    },
  })
  const earlier = await f.call('createChat')
  await f.host.vault.transaction(state => appendBubble(f.host.vault, state, earlier.id, 'user', 'SYNTHETIC_PRIVATE_CONTEXT'))
  try {
    const job = await f.send(question)
    await until(() => searches.length > 0, 'search began')
    const pending = await f.snapshot()
    assert.deepEqual(searches, ['Node.js 最新 LTS 版本'])
    assert.equal(f.requests.length, 0, 'initial acknowledgement does not need the model')
    assert.deepEqual(pending.messages.map(message => message.text), [question, acknowledgement])
    assert.equal(pending.jobs.find(row => row.id === job.id)?.status, 'done')
    assert.equal(pending.backgroundPhase, 'searching')

    await f.send('我都行', earlier.id)
    await until(async () => (await f.snapshot(earlier.id)).messages.at(-1)?.text === plainReply, 'ordinary reply during search')
    assert.equal(f.requests.length, 1)
    assert.equal(searches.length, 1)
  } finally {
    blockedSearch.release()
  }
  const finished = await until(async () => {
    const view = await f.snapshot()
    return view.messages.at(-1)?.text === verifiedReply && view
  }, 'verified result')

  assert.deepEqual(finished.messages.map(message => message.text), [question, acknowledgement, verifiedReply])
  assert.equal(finished.messages.at(-1).presentation.expression, 'relieved')
  assert.deepEqual(reads, [source])
  assert.equal(f.requests.length, 2, 'only ordinary chat and the final synthesis reach the model')
  assert.match(f.requests[1].system, /\[BACKGROUND_RESULT_DELIVERY\]/)
  assert.match(JSON.stringify(f.requests[1].messages), /SYNTHETIC_PAGE_EVIDENCE/)
  assert.doesNotMatch(JSON.stringify(finished), /SYNTHETIC_(?:SEARCH_EXCERPT|PAGE_EVIDENCE|PRIVATE_CONTEXT)|internalSteps|\bdot-reply\b/)
})

test('disabled web leaves a lookup request in the regular reply flow', async t => {
  let searches = 0
  const f = await fixture(t, {async search() { searches++; return {sources: []} }}, {webSearch: false})
  await f.send(question)
  const finished = await until(async () => {
    const view = await f.snapshot()
    return view.messages.at(-1)?.text === plainReply && view
  }, 'offline reply')
  assert.equal(searches, 0)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(finished.messages.map(message => message.text), [question, plainReply])
  assert.equal(finished.backgroundPhase, null)
})

for (const [label, search, expected] of [
  ['empty results', async () => ({sources: []}), /未找到|没找到|没有找到/],
  ['network failure', async () => { throw new Error('SYNTHETIC_TRANSPORT_ERROR') }, /联网查询未完成|没能核对|暂时无法/],
]) {
  test(`${label} produces an honest follow-up without a model inventing a result`, async t => {
    let searches = 0
    const f = await fixture(t, {async search(request) { searches++; return search(request) }})
    await f.send(question)
    const finished = await until(async () => {
      const view = await f.snapshot()
      return view.messages.length >= 3 && view
    }, label)
    assert.equal(searches, 1)
    assert.equal(f.requests.length, 0)
    assert.equal(finished.messages[1].text, acknowledgement)
    assert.equal(finished.messages[2].presentation.expression, 'uncertain')
    assert.match(finished.messages[2].text, expected)
    assert.doesNotMatch(JSON.stringify(finished), /SYNTHETIC_TRANSPORT_ERROR|internalSteps/)
  })
}
