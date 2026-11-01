import path from 'node:path'
import {promises as fs} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {DotError} from './vault.js'
import * as community from './assistant.js'

// Owner-installed server-side extensions are never part of the browser bundle.
// The location is host configuration, never a path supplied by a chat/template.
export async function loadExtension(pointer){
  const entry=path.join(path.dirname(pointer),'private-core','index.mjs')
  try{await fs.access(entry)}catch(e){if(e.code==='ENOENT')return community;throw e}
  const extension=await import(pathToFileURL(entry).href)
  if(extension.apiVersion!==1||typeof extension.createExtension!=='function')throw new DotError('本地扩展版本不兼容，请更新扩展后重试。')
  return extension
}
