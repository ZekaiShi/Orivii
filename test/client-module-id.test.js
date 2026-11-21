import test from 'node:test'
import assert from 'node:assert/strict'
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import vm from 'node:vm'

test('browser builds register the preview or public package identity without alias collisions', async()=>{
  const root = new URL('../', import.meta.url)
  const fixture = await mkdtemp(path.join(tmpdir(), 'orivii-module-id-'))
  try {
    await mkdir(path.join(fixture, 'scripts'))
    await cp(new URL('scripts/build.mjs', root), path.join(fixture, 'scripts/build.mjs'))
    await cp(new URL('src/', root), path.join(fixture, 'src'), {recursive:true})
    const modules = new Map()
    for (const name of ['dsh-companion', 'dsh-orivii']) {
      await writeFile(path.join(fixture, 'package.json'), JSON.stringify({name, type:'module'}))
      execFileSync(process.execPath, ['scripts/build.mjs'], {cwd:fixture, windowsHide:true})
      let registration
      vm.runInNewContext(await readFile(path.join(fixture, 'dsh/client.js'), 'utf8'), {
        window:{__ModuleLoader__:{load(value){
          assert.equal(value.id, name)
          assert.ok(!modules.has(value.id), 'distinct packages must not register the same factory')
          registration=value
          modules.set(value.id, value.factory)
        }}},
      })
      assert.equal(typeof registration.factory, 'function')
    }
    assert.equal(modules.size, 2)
  } finally {
    assert.equal(path.dirname(fixture), tmpdir())
    await rm(fixture, {recursive:true, force:true})
  }
})
