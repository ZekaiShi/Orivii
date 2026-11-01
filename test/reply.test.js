import test from 'node:test'
import assert from 'node:assert/strict'
import {visibleReply,bubbleParts} from '../src/reply.js'

test('only a complete first-line declaration opens the public stream; unknown expression is neutral',()=>{
  for(const privateText of ['计划：先读文件','[dot-reply:heart]','[dot-reply:hea','说明 [dot-reply:heart]\n文本'])assert.equal(visibleReply(privateText),null)
  assert.deepEqual(visibleReply('[dot-reply:heart]\n'),{expression:'heart',text:''})
  assert.deepEqual(visibleReply('[dot-reply:heart]\n你好呀\n\n第二段'),{expression:'heart',text:'你好呀\n\n第二段'})
  assert.deepEqual(visibleReply('[dot-reply:invalid]\n你好'),{expression:'neutral',text:'你好'})
  for(const invalid of ['', 'not-allowed', '任意脚本', '{"svg":true}'])assert.deepEqual(visibleReply(`[dot-reply:${invalid}]\n正文仍可见`),{expression:'neutral',text:'正文仍可见'})
})

test('ordinary line breaks become consecutive bubbles, while structured Markdown stays intact',()=>{
  assert.deepEqual(bubbleParts('主人，这会儿还行。\n不过你这么问，我有点想多问一句。'),['主人，这会儿还行。','不过你这么问，我有点想多问一句。'])
  assert.deepEqual(bubbleParts('**第一段**\n\n第二段'),['**第一段**','第二段'])
  for(const text of ['- 一\n- 二','1. 一\n2. 二','```js\nlet a=1\n```','名字 | 内容\n--- | ---\na | b','> 引用\n> 第二行','    code\n    again','# 标题\n说明','[链接][x]\n\n[x]: https://example.org'])assert.deepEqual(bubbleParts(text),[text])
})
