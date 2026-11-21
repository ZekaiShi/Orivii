import test from 'node:test'
import assert from 'node:assert/strict'
import {verificationIntent} from '../src/verification-intent.js'

test('public verification requests get a short acknowledgement and an optional search phrase', () => {
  const explicit = verificationIntent('帮我查一下 Python 3.14 的发布日期。')
  assert.deepEqual(explicit, {
    domain: 'web', reason: 'explicit', acknowledgement: '好，我看看。', query: 'Python 3.14 的发布日期',
  })
  for (const text of [
    'Python 最新版本是什么？', '北京今天会下雨吗？', '现在 iPhone 17 多少钱？',
    '福州博物馆明天的开放时间是什么？', 'What is the latest Node.js release?',
  ]) {
    const intent = verificationIntent(text)
    assert.equal(intent?.reason, 'freshness', text)
    assert.equal(intent?.domain, 'web', text)
    assert.equal(intent?.acknowledgement, '我查一下。', text)
    assert.ok(intent?.query, text)
  }
  const official = verificationIntent('能发我杭州博物馆的官网链接吗？')
  assert.equal(official?.reason, 'source')
  assert.equal(official?.domain, 'web')
  assert.ok(official?.query)
  assert.deepEqual(verificationIntent('Could you look up the Python release date?'), {
    domain: 'web', reason: 'explicit', acknowledgement: '好，我看看。', query: 'the Python release date',
  })
})

test('ambiguous follow-up queries and user-provided pages require context instead of automatic search terms', () => {
  const ambiguous = [
    '请查公开资料', '帮我查下最新版是什么', '你能不能去核实刚才那个说法？',
    '帮我查一下苹果官网新的价格，这次只看学生折扣。', '帮我核实一下「示例论文」的发布日期。',
    '查一下官网公告', '查一下这款相机现在多少钱。',
  ]
  for (const text of ambiguous) {
    const intent = verificationIntent(text)
    assert.equal(intent?.domain, 'web', text)
    assert.equal(intent?.query, undefined, text)
  }
  assert.deepEqual(verificationIntent('请读一下 https://www.python.org/downloads/ 这个页面'), {
    domain: 'web', reason: 'source', acknowledgement: '我查一下。',
  })
})

test('direct Bilibili requests use the scoped video route', () => {
  for (const text of [
    '帮我查一下 B 站关于《桃花源记》的视频',
    '能不能看下 https://www.bilibili.com/video/BV1AbCDeFgH2 里的字幕？',
    '帮我核对 BV1AbCDeFgH2 讲了什么？',
  ]) {
    const intent = verificationIntent(text)
    assert.equal(intent?.domain, 'bilibili', text)
    assert.equal(intent?.query, undefined, text)
  }
})

test('casual chat, quotations, local data, private URLs, and opting out do not route automatically', () => {
  for (const text of [
    '我都行。', '今天有点冷。', '我喜欢逛 B 站。', '我今晚吃什么好呢？',
    '你现在几点？', '查理昨天回家了。', '搜狗输入法的界面真好看。',
    'DSH 刚更新，我用得挺顺手。', '最新版的主题挺好看。',
    '他说：“请查一下现行政策。”', '翻译一下：查一下 iPhone 的售价。',
    '假设一下，最新的公告会怎样？', '写一个故事，帮我查一下它的结局。',
    '> 请查一下 Python 最新版\n这句写顺了吗？', '```text\n查一下 Python 的最新版本\n```',
    '请查一下我的订单今天到哪了？', '请帮我核对我的项目的最新版本。',
    '查一下本地的项目最新版本。', '内网里的部署系统版本是多少？', '请查一下公司内部的项目是否发布。',
    '查一下这份附件的发布日期。', '查一下附件用的 Python 版本。', '帮我查一下日志里的版本。',
    '查一下 C:\\Users\\test\\draft.md 的修改时间。',
    '请核对我们上次聊的消息。', 'Could you verify my account details?',
    '查一下 http://127.0.0.1:8080 设置页。', '能帮我打开 https://example.com/private/notes 吗？',
    '查看 https://example.com/download?access_token=fake',
    'Python 最新版本？不用你查。', '不要联网，根据常识回答苹果今天的股价。',
    "Don't search online. What is the newest Node release?",
  ]) assert.equal(verificationIntent(text), null, text)
})
