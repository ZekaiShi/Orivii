import {promises as fs} from 'node:fs'
import path from 'node:path'
import {randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv} from 'node:crypto'
import {promisify} from 'node:util'

const derive = promisify(scrypt)
const ID = /^[a-f0-9-]{36}$/
export const LAYERS = ['short', 'medium', 'long', 'permanent']
export class DotError extends Error {
  constructor(message, code = 'invalid') { super(message); this.code = code }
}
export function validId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new DotError('无效的记录编号。')
  return id
}
export async function atomicWrite(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(tmp, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  try {
    for(let attempt=0;;attempt++) {
      try { await fs.rename(tmp,file);break } catch(e) {
        // Windows readers/indexers can briefly deny replacement. Keep the old
        // HEAD intact and retry the same atomic rename; never unlink the target.
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=5)throw e
        await new Promise(resolve=>setTimeout(resolve,20*(attempt+1)))
      }
    }
  } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e }
}
export const initialState = settings => ({
  catalog: {version: 2, revision: 0, companionProfileVersion:1, companionBrandVersion:1, settings, chats: [], messages: [], jobs: [], imports: []},
  short: {messages: []}, medium: {entries: []}, long: {entries: []}, permanent: {entries: []},
})

export class Vault {
  constructor(workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new DotError('请选择绝对路径作为 Orivii 工作空间。')
    this.workspace = path.resolve(workspace)
    this.root = path.join(this.workspace, '.dot-memory')
    this.key = null
    this.meta = null
    this.queue = Promise.resolve()
  }
  async exists() { try { await fs.access(path.join(this.root, 'vault.json')); return true } catch(e) { if(e.code==='ENOENT')return false; throw e } }
  async initialize(password, settings, plaintext = false) {
    if (!plaintext && (typeof password !== 'string' || password.length < 10 || password.length > 1024)) throw new DotError('加密密码请使用 10–1024 个字符。')
    await fs.mkdir(this.workspace, {recursive: true})
    try { await fs.mkdir(this.root, {mode: 0o700}) } catch(e) { if(e.code==='EEXIST')throw new DotError('此位置已有 Orivii 数据，请解锁现有工作空间。'); throw e }
    const meta = {version: 2, id: randomUUID(), encrypted: !plaintext, salt: randomBytes(32).toString('base64'), kdf: 'scrypt-N131072-r8-p1'}
    this.meta = meta
    if (!plaintext) this.key = await derive(password, Buffer.from(meta.salt, 'base64'), 32, {N:131072,r:8,p:1,maxmem:256*1024*1024})
    try {
      await fs.mkdir(path.join(this.root, 'archive'), {mode: 0o700})
      await fs.mkdir(path.join(this.root, 'generations'), {mode: 0o700})
      meta.check = this.encode({check: 'dot-vault-v2'}, 'check')
      await atomicWrite(path.join(this.root, 'vault.json'), JSON.stringify(meta))
      await this.commit(initialState(settings))
    } catch(e) { this.close(); throw e }
  }
  async unlock(password) {
    const meta = JSON.parse(await fs.readFile(path.join(this.root, 'vault.json'), 'utf8'))
    if (meta.version !== 2 || !ID.test(meta.id) || meta.kdf !== 'scrypt-N131072-r8-p1') throw new DotError('此记忆库格式不受支持。')
    this.meta = meta
    if (meta.encrypted) {
      if (typeof password !== 'string' || password.length > 1024) throw new DotError('请输入正确的记忆库密码。')
      this.key = await derive(password, Buffer.from(meta.salt, 'base64'), 32, {N:131072,r:8,p:1,maxmem:256*1024*1024})
    }
    try {
      if (this.decode(meta.check, 'check').check !== 'dot-vault-v2') throw new Error('check')
      await this.read()
    } catch(e) { this.close(); throw new DotError('密码错误，或记忆文件已损坏。', 'locked') }
  }
  requireOpen() { if (!this.meta || (this.meta.encrypted && !this.key)) throw new DotError('记忆库已锁定，请先解锁。', 'locked') }
  encode(value, label) {
    this.requireOpen()
    if (!this.meta.encrypted) return JSON.stringify(value)
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`${this.meta.id}/${label}`))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()])
    return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')})
  }
  decode(text, label) {
    this.requireOpen()
    if (!this.meta.encrypted) return JSON.parse(text)
    const value = JSON.parse(text)
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv,'base64'))
    cipher.setAAD(Buffer.from(`${this.meta.id}/${label}`))
    cipher.setAuthTag(Buffer.from(value.tag,'base64'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString('utf8'))
  }
  ext() { this.requireOpen();return this.meta.encrypted ? '.json.enc' : '.json' }
  async head(){
    // Some host filesystems (including Windows mounts accessed through WSL)
    // briefly report ENOENT during replacement. Retry reads, never recreate
    // HEAD or select an uncommitted generation.
    for(let attempt=0;;attempt++){
      this.requireOpen()
      try{return validId((await fs.readFile(path.join(this.root,'HEAD'),'utf8')).trim())}
      catch(error){if(error.code!=='ENOENT'||attempt>=4)throw error;await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)))}
    }
  }
  async read(attempt=0) {
    this.requireOpen()
    const id = await this.head()
    const state = {}
    try {
      await Promise.all(['catalog',...LAYERS].map(async name=>{
        const text=await fs.readFile(path.join(this.root,'generations',id,name+this.ext()),'utf8')
        state[name]=this.decode(text,`${id}/${name}`)
      }))
    } catch(e) {
      if(e.code==='ENOENT'&&attempt<3&&await this.head()!==id)return this.read(attempt+1)
      throw e
    }
    return state
  }
  async commit(state) {
    this.requireOpen()
    const id = randomUUID(), dir = path.join(this.root, 'generations', id)
    await fs.mkdir(dir, {mode: 0o700})
    state.catalog.revision++
    for (const name of ['catalog',...LAYERS]) await atomicWrite(path.join(dir,name+this.ext()), this.encode(state[name], `${id}/${name}`))
    // HEAD is the transaction commit. Incomplete generations never become visible.
    let previous
    try { previous = (await fs.readFile(path.join(this.root,'HEAD'),'utf8')).trim() } catch(e) { if(e.code!=='ENOENT')throw e }
    await atomicWrite(path.join(this.root,'HEAD'), id)
    // Only prune this vault's generated snapshots; immutable originals are never pruned.
    for (const entry of await fs.readdir(path.join(this.root,'generations'),{withFileTypes:true})) {
      if (entry.isDirectory() && ID.test(entry.name) && entry.name!==id && entry.name!==previous) {
        await fs.rm(path.join(this.root,'generations',entry.name),{recursive:true,force:true}).catch(()=>{})
      }
    }
  }
  async acquire() {
    const lock = path.join(this.root,'writer.lock')
    for(let n=0;n<100;n++) {
      try {
        const handle = await fs.open(lock,'wx',0o600)
        await handle.writeFile(JSON.stringify({pid:process.pid}))
        return async()=>{await handle.close();await fs.unlink(lock).catch(()=>{})}
      } catch(e) {
        if(e.code!=='EEXIST')throw e
        try {
          const owner=JSON.parse(await fs.readFile(lock,'utf8'))
          if(Number.isInteger(owner.pid) && owner.pid>0) {
            try { process.kill(owner.pid,0) } catch(error) { if(error.code==='ESRCH')await fs.unlink(lock).catch(()=>{}) }
          }
        } catch {}
        await new Promise(r=>setTimeout(r,50))
      }
    }
    throw new DotError('记忆库正在写入，请稍后重试。','busy')
  }
  transaction(fn) {
    const work = this.queue.then(async()=>{
      this.requireOpen()
      const release=await this.acquire()
      try { const state=await this.read();const result=await fn(state);await this.commit(state);return result }
      finally { await release() }
    })
    this.queue=work.catch(()=>{})
    return work
  }
  async putMessage(message) {
    validId(message.id)
    const handle=await fs.open(path.join(this.root,'archive',message.id+this.ext()),'wx',0o600)
    try { await handle.writeFile(this.encode(message,`message/${message.id}`));await handle.sync() } finally { await handle.close() }
  }
  async message(id) {
    validId(id)
    return this.decode(await fs.readFile(path.join(this.root,'archive',id+this.ext()),'utf8'),`message/${id}`)
  }
  close() { this.key?.fill(0);this.key=null;this.meta=null;this.searchIndex=null }
}
