import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
const root=new URL('../',import.meta.url)
const allowed=new Map([['/','preview.html'],['/preview.html','preview.html'],['/dsh/client.js','dsh/client.js']])
createServer(async(req,res)=>{
  const file=allowed.get(new URL(req.url,'http://localhost').pathname)
  if(!file){res.writeHead(404);res.end();return}
  try{const data=await readFile(new URL(file,root));res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});res.end(data)}catch{res.writeHead(500);res.end('Build the plugin first.')}
}).listen(3187,'127.0.0.1',()=>console.log('Companion simulated preview: http://127.0.0.1:3187'))
