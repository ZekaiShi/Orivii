import test from 'node:test'
import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {atomicWrite} from '../src/vault.js'

test('Windows atomic replacement survives a transient sharing denial and preserves the previous file on permanent failure',{skip:process.platform!=='win32'},async t=>{
  const base=fileURLToPath(new URL('../.dsh-test/',import.meta.url))
  await fs.mkdir(base,{recursive:true})
  const dir=await fs.mkdtemp(path.join(base,'dot-atomic-')),target=path.join(dir,'HEAD')
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  await fs.writeFile(target,'previous')
  const rename=fs.rename;let denied=2,calls=0
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===target){calls++;assert.equal(await fs.readFile(target,'utf8'),'previous');if(denied-->0)throw Object.assign(new Error('sharing denial'),{code:'EPERM'})}
    return rename(from,to)
  })
  await atomicWrite(target,'next')
  assert.equal(calls,3);assert.equal(await fs.readFile(target,'utf8'),'next')
  assert.deepEqual(await fs.readdir(dir),['HEAD'])
  t.mock.restoreAll()
  t.mock.method(fs,'rename',async(from,to)=>{if(to===target)throw Object.assign(new Error('denied'),{code:'EPERM'});return rename(from,to)})
  await assert.rejects(atomicWrite(target,'never-committed'),{code:'EPERM'})
  assert.equal(await fs.readFile(target,'utf8'),'next');assert.deepEqual(await fs.readdir(dir),['HEAD'])
})
