import {promises as fs} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

const root=fileURLToPath(new URL('../',import.meta.url))
const destination=process.argv[2]
if(!destination)throw new Error('Usage: node scripts/export-public.mjs <--check | new destination directory>')
const checkOnly=destination==='--check'
const target=checkOnly?null:path.resolve(destination)
const within=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))}
if(!checkOnly&&(within(root,target)||within(target,root)))throw new Error('Export must be separate from the source directory')

// Explicit release boundary: do not enumerate or copy the parent workspace.
const allowed=['.github','.gitignore','CONTRIBUTING.md','CHANGELOG.md','UPDATES.md','media','screenshots.json','docs','LICENSE','README.md','README.en.md','ROADMAP.md','SECURITY.md','cordis.patch.yml','index.js','package.json','package-lock.json','src','dsh','scripts','test']
const optional=new Set(['package-lock.json'])
const files=[]
const forbidden=/(^|\/)(?:node_modules|private|private-core|\.git|\.dsh-test|\.dot-memory)(\/|$)|(?:\.log|\.tgz|\.dotcard|\.map)$|(^|\/)\.env(?:\.|$)/i
const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}/,/\b[A-Z]:[\\/]+Users[\\/]+(?!test(?:[\\/]|$)|example(?:[\\/]|$))[^\s\\/]+[\\/]/i]
async function collect(relative){
  const absolute=path.join(root,relative)
  let stat
  try{stat=await fs.lstat(absolute)}catch(error){if(error.code==='ENOENT'&&optional.has(relative))return;throw error}
  if(forbidden.test(relative))throw new Error('Forbidden public path: '+relative)
  if(stat.isSymbolicLink())throw new Error('Symlinks are not accepted in public source: '+relative)
  if(stat.isDirectory()){
    for(const item of (await fs.readdir(absolute)).sort())await collect(relative+'/'+item)
    return
  }
  if(!stat.isFile())throw new Error('Non-regular public file: '+relative)
  const bytes=await fs.readFile(absolute)
  if(secretPatterns.some(pattern=>pattern.test(bytes.toString('utf8'))))throw new Error('Possible secret or personal path in '+relative+'; inspect locally before export')
  files.push({path:relative,bytes,sha256:createHash('sha256').update(bytes).digest('hex')})
}
for(const item of allowed)await collect(item)
const manifest=JSON.parse(files.find(file=>file.path==='package.json').bytes.toString('utf8'))
if(manifest.name!=='dsh-orivii'||manifest.license!=='MIT')throw new Error('Unexpected public package identity')
const runtimeAllowed=new Set(['index.js','src','dsh','cordis.patch.yml','README.md','CHANGELOG.md','UPDATES.md','ROADMAP.md','SECURITY.md','LICENSE'])
if(!manifest.files?.length||manifest.files.some(name=>!runtimeAllowed.has(name)))throw new Error('Review the npm runtime file allowlist before export')

if(checkOnly){
  console.log(JSON.stringify({package:manifest.name,version:manifest.version,files:files.length,publicBoundaryChecked:true,published:false}))
  process.exit(0)
}

// Exclusive creation prevents overwriting an existing release or user data.
await fs.mkdir(target)
for(const file of files){
  const out=path.join(target,file.path)
  await fs.mkdir(path.dirname(out),{recursive:true})
  await fs.writeFile(out,file.bytes,{flag:'wx'})
}
await fs.writeFile(path.join(target,'PUBLIC-SOURCE-MANIFEST.json'),JSON.stringify({package:manifest.name,version:manifest.version,scope:'public-source-only',files:files.map(({path,sha256,bytes})=>({path,sha256,size:bytes.length}))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({package:manifest.name,version:manifest.version,files:files.length,privateImplementationIncluded:false,published:false}))
