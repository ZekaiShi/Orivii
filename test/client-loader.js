import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {JSDOM} from 'jsdom'
import React from 'react'
import {z} from 'zod'
import {MarkdownText} from './markdown-stub.js'

// Use DSH's package-name based module table, not a stub that discards bundle IDs.
export async function loadClientBundle(source, id) {
  const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>')
  try {
    let bootstrap
    const context=vm.createContext({
      window:{__ModuleLoader__:{load({factory}){bootstrap=factory()}}},
      document:dom.window.document,URL,AbortController,crypto,setTimeout,clearTimeout,setInterval,clearInterval,console,
    })
    const loaderSource=await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-modules/client')),'utf8')
    vm.runInContext(loaderSource,context)
    const registrationTarget={mode:'queue',pendingQueue:[]}
    context.window.__ModuleLoader__=registrationTarget
    const url=`plugins/${id}/client.js?rev=test`
    const manifest=bootstrap.parseBootManifest({
      rev:'test',release:{version:'test'},
      entries:[{id,url,rev:'test',inject:[],external:[],immediately:true}],
      batches:[{phase:'application',url,rev:'test',entries:[id]}],
    })
    const modules=new bootstrap.ClientModuleSystem({
      manifest,registrationTarget,
      staticModules:{react:React,zod:{z},'@deepseek-ai/dsh-client-ui-primitives':{MarkdownText}},
      bootstrapModule:{id:'@deepseek-ai/dsh-client-modules',exports:bootstrap},
      loadBundle:async()=>{vm.runInContext(source,context)},
    })
    return await modules.import(id)
  } finally {dom.window.close()}
}
