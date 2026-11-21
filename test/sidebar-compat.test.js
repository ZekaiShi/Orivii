import test from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {attachDotSidebar} from '../src/ui-state.js'

test('current DSH flex entry keeps its name and unpin action outside the chat subtree',()=>{
  const dom=new JSDOM('<nav><div data-entry style="display:flex"><button aria-label="小圆"><span data-icon></span><span>小圆</span></button><button data-unpin aria-label="取消固定小圆">固定</button></div><button aria-haspopup="menu">更多</button></nav>')
  const doc=dom.window.document,entry=doc.querySelector('[data-entry]'),row=entry.querySelector('button'),unpin=doc.querySelector('[data-unpin]'),more=doc.querySelector('[aria-haspopup]')
  let opened=0,unpinned=0,moreOpened=0
  unpin.addEventListener('click',()=>unpinned++);more.addEventListener('click',()=>moreOpened++)
  const attached=attachDotSidebar(doc.querySelector('[data-icon]'),()=>opened++)
  assert.ok(attached)
  assert.equal(entry.nextElementSibling,attached.mount)
  assert.equal(attached.mount.parentElement,doc.querySelector('nav'))
  assert.equal(entry.contains(attached.mount),false,'a width:100% mount must not share the native row flexbox')
  assert.equal(row.textContent,'小圆');assert.equal(row.getAttribute('aria-label'),'小圆')
  row.click();unpin.click();more.click()
  assert.equal(opened,1);assert.equal(unpinned,1);assert.equal(moreOpened,1)
  attached.setExpanded(true);assert.equal(row.getAttribute('aria-expanded'),'true')
  attached.dispose();assert.equal(doc.querySelector('.dot-sidebar-mount'),null)
  assert.equal(row.hasAttribute('aria-controls'),false);assert.equal(row.hasAttribute('aria-expanded'),false)
  dom.window.close()
})

test('More-menu icons keep native opening and pinning and never receive a chat mount',()=>{
  const dom=new JSDOM('<div role="menu"><button role="menuitem"><span data-icon></span>小圆</button><button role="menuitem" data-pin>固定到侧边栏</button></div>')
  const doc=dom.window.document;let opened=0,pinned=0,overridden=0
  doc.querySelector('button').addEventListener('click',()=>opened++)
  doc.querySelector('[data-pin]').addEventListener('click',()=>pinned++)
  assert.equal(attachDotSidebar(doc.querySelector('[data-icon]'),()=>overridden++),null)
  doc.querySelector('button').click();doc.querySelector('[data-pin]').click()
  assert.equal(opened,1);assert.equal(pinned,1);assert.equal(overridden,0)
  assert.equal(doc.querySelector('.dot-sidebar-mount'),null)
  dom.window.close()
})

test('legacy direct sidebar rows retain adjacent chat mounting and native attributes after disposal',()=>{
  const dom=new JSDOM('<nav><button aria-label="Orivii" aria-controls="legacy" aria-expanded="false"><span data-icon></span>Orivii</button></nav>')
  const doc=dom.window.document,row=doc.querySelector('button'),attached=attachDotSidebar(doc.querySelector('[data-icon]'),()=>{})
  assert.equal(row.nextElementSibling,attached.mount)
  attached.dispose()
  assert.equal(row.getAttribute('aria-controls'),'legacy');assert.equal(row.getAttribute('aria-expanded'),'false')
  dom.window.close()
})
