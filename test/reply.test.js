import test from 'node:test'
import assert from 'node:assert/strict'
import {visibleReply,finalReply,bubbleParts,messageBubbleParts} from '../src/reply.js'

test('only a complete first-line declaration opens the public stream; unknown expression is neutral',()=>{
  for(const privateText of ['计划：先读文件','[dot-reply:heart]','[dot-reply:hea','说明 [dot-reply:heart]\n文本'])assert.equal(visibleReply(privateText),null)
  assert.deepEqual(visibleReply('[dot-reply:heart]\n'),{expression:'heart',text:''})
  assert.deepEqual(visibleReply('[dot-reply:heart]\n你好呀\n\n第二段'),{expression:'heart',text:'你好呀\n\n第二段'})
  assert.deepEqual(visibleReply('[dot-reply:invalid]\n你好'),{expression:'neutral',text:'你好'})
  for(const invalid of ['', 'not-allowed', '任意脚本', '{"svg":true}'])assert.deepEqual(visibleReply(`[dot-reply:${invalid}]\n正文仍可见`),{expression:'neutral',text:'正文仍可见'})
})

test('completed replies recover metadata separators without relaxing the live declaration',()=>{
  for(const input of ['[dot-reply:happy]正文','[dot-reply:happy]\n正文','[dot-reply:happy]\r\n正文',' [dot-reply: happy ]正文','`[dot-reply:happy]`正文'])assert.deepEqual(finalReply(input),{expression:'happy',text:'正文'},input)
  for(const input of ['[dot-reply:invalid]正文','[dot-reply:]正文','[dot-reply:{"svg":true}]正文','[dot-reply:'+ 'x'.repeat(100)+']正文'])assert.deepEqual(finalReply(input),{expression:'neutral',text:'正文'},input)
  assert.deepEqual(finalReply('[dot-reply:heart]'),{expression:'heart',text:''})
  assert.equal(visibleReply('[dot-reply:happy]正文'),null)
  assert.equal(visibleReply('[dot-reply:happy]'),null)
})

test('malformed completed metadata drops only its leading line and keeps the real body',()=>{
  for(const input of ['[dot-reply:happy\n正文','[dot-reply:invalid\r\n正文','[dot-reply:\n正文',' [ DOT-REPLY: happy\n正文'])assert.deepEqual(finalReply(input),{expression:'neutral',text:'正文'},input)
  for(const input of ['[dot-reply:ha','[dot-reply:','[dot-re','[dot-reply:happy\n'])assert.deepEqual(finalReply(input),{expression:'neutral',text:''},input)
  assert.deepEqual(finalReply('[dot-reply:happy 正文'),{expression:'neutral',text:''})
})

test('completed plain text and structured body content keep their formatting',()=>{
  for(const input of ['普通正文。','    code\n\n正文','[dot-product] 是向量点积。','[dot-replying] 是一个普通名称。','**强调**\n\n- 第一项\n- 第二项','```js\nconst x = [1, 2];\n```','<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>'])assert.deepEqual(finalReply(input),{expression:'neutral',text:input},input)
  const body='**重点**\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'
  assert.deepEqual(finalReply('[dot-reply:curious]'+body),{expression:'curious',text:body})
  assert.deepEqual(finalReply('正文\n[dot-reply:invalid]\n结尾'),{expression:'neutral',text:'正文\n\n结尾'})
})

test('ordinary line breaks become consecutive bubbles, while structured Markdown stays intact',()=>{
  assert.deepEqual(bubbleParts('主人，这会儿还行。\n不过你这么问，我有点想多问一句。'),['主人，这会儿还行。','不过你这么问，我有点想多问一句。'])
  assert.deepEqual(bubbleParts('**第一段**\n\n第二段'),['**第一段**','第二段'])
  for(const text of ['- 一\n- 二','1. 一\n2. 二','```js\nlet a=1\n```','名字 | 内容\n--- | ---\na | b','> 引用\n> 第二行','    code\n    again','# 标题\n说明','[链接][x]\n\n[x]: https://example.org'])assert.deepEqual(bubbleParts(text),[text])
})

test('captions and each image display separately without rewriting archived messages or losing documents',()=>{
  for(const role of ['assistant','user']){
    const message={role,text:'这是图片说明。\n还有一张。',attachments:[{id:'first',kind:'image'},{id:'notes',kind:'text'},{id:'second',kind:'image'}]},original=JSON.stringify(message)
    const parts=messageBubbleParts(message),images=parts.filter(part=>part.kind==='image')
    assert.equal(images.length,2)
    for(const image of images){assert.equal(image.text,'');assert.equal(image.attachments.length,1);assert.equal(image.attachments[0].kind,'image')}
    assert.deepEqual(parts.flatMap(part=>part.attachments||[]).map(file=>file.id).sort(),['first','notes','second'])
    assert.equal(parts.filter(part=>part.text).map(part=>part.text).join('\n'),message.text)
    assert.equal(JSON.stringify(message),original)
    assert.deepEqual(images.map(part=>part.key),messageBubbleParts({...message,text:'说明增加后。\n第二段。\n第三段。'}).filter(part=>part.kind==='image').map(part=>part.key))
  }
  const onlyImage=messageBubbleParts({role:'assistant',text:'',attachments:[{id:'only',kind:'image'}]})
  assert.equal(onlyImage.length,1);assert.equal(onlyImage[0].kind,'image','image-only messages have no empty text bubble')
})
