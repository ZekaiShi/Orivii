import test from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {createReplyInk,replyInkColor} from '../src/ink.js'

test('fresh Markdown text fades through pink/gold without changing DOM, replaying old text or retaining animations',()=>{
  const dom=new JSDOM('<div id="root" style="color:rgb(250,250,250)"><div class="dot-rich-text">旧文字 <strong>粗体</strong><a href="https://example.com">链接</a><pre>代码保持配色</pre></div></div>',{pretendToBeVisual:true})
  const win=dom.window,doc=win.document,root=doc.getElementById('root'),body=root.firstElementChild,registry=new Map(),frames=new Map()
  let now=0,id=0,hidden=false,reduced=false,mediaChange
  Object.defineProperty(win,'CSS',{value:{highlights:registry}})
  win.Highlight=class extends Set{constructor(...ranges){super(ranges)}}
  win.performance.now=()=>now
  win.requestAnimationFrame=fn=>{frames.set(++id,fn);return id};win.cancelAnimationFrame=id=>frames.delete(id)
  Object.defineProperty(doc,'hidden',{get:()=>hidden})
  win.matchMedia=()=>({get matches(){return reduced},addEventListener(_event,fn){mediaChange=fn},removeEventListener(){}})
  const ink=createReplyInk(root),texts=()=>[...registry.values()].map(ranges=>[...ranges].map(range=>range.toString()).join(''))
  const advance=ms=>{now+=ms;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn()}
  try{
    ink.update(false);assert.equal(registry.size,0)
    const strong=body.querySelector('strong'),fresh=doc.createTextNode('新文字');body.append(fresh)
    const markup=root.innerHTML
    ink.update(true)
    assert.deepEqual(texts(),['新文字']);assert.equal(root.innerHTML,markup);assert.equal(body.querySelector('strong'),strong)
    assert.match(doc.querySelector('style[data-dot-reply-ink]').textContent,/244,157,216/)
    advance(100)
    const em=doc.createElement('em');em.textContent='接着说';body.append(em);ink.update(true)
    assert.deepEqual(texts(),['新文字','接着说']);assert.equal(frames.size,1)
    advance(200);assert.doesNotMatch(doc.querySelector('style[data-dot-reply-ink]').textContent,/0\.120/)
    advance(500);assert.equal(registry.size,0);assert.equal(frames.size,0);assert.equal(doc.querySelector('style[data-dot-reply-ink]'),null)
    ink.update(true);assert.equal(registry.size,0,'unchanged rendered text never replays')
    body.append(doc.createTextNode('下一批'));ink.update(true);assert.equal(registry.size,1)
    hidden=true;doc.dispatchEvent(new win.Event('visibilitychange'));assert.equal(registry.size,0);assert.equal(frames.size,0)
    hidden=false;doc.dispatchEvent(new win.Event('visibilitychange'));ink.update(true);assert.equal(registry.size,0)
    body.append(doc.createTextNode('减少动态'));ink.update(true)
    reduced=true;mediaChange();assert.equal(registry.size,0);assert.equal(frames.size,0)
    reduced=false;body.append(doc.createTextNode('卸载'));ink.update(true);assert.equal(registry.size,1)
    ink.dispose();assert.equal(registry.size,0);assert.equal(frames.size,0);assert.equal(doc.querySelector('style[data-dot-reply-ink]'),null)
  }finally{ink.dispose();dom.window.close()}
})

test('ink ends at theme foreground and unsupported browsers keep normal readable text',()=>{
  assert.equal(replyInkColor(1,[250,250,250]),'rgba(250,250,250,1.000)')
  assert.equal(replyInkColor(1,[23,23,23]),'rgba(23,23,23,1.000)')
  assert.equal(replyInkColor(.45),'rgba(252,216,142,1.000)')
  const dom=new JSDOM('<div id="root"><p class="dot-rich-text">正常正文</p></div>'),root=dom.window.document.getElementById('root'),before=root.innerHTML
  const ink=createReplyInk(root);ink.update(true);ink.dispose();assert.equal(root.innerHTML,before);dom.window.close()
})
