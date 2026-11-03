import {readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url))
for(const file of ['index.js',...readdirSync(new URL('../src/',import.meta.url)).filter(f=>f.endsWith('.js')).map(f=>'src/'+f),'dsh/client.js']){
  const result=spawnSync(process.execPath,['--check',file],{cwd:root,stdio:'inherit'})
  if(result.error)throw result.error
  if(result.status!==0)process.exit(result.status||1)
}
