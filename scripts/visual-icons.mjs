import fs from 'node:fs/promises'
const root=new URL('../',import.meta.url),catalog=JSON.parse(await fs.readFile(new URL('node_modules/lucide-static/icon-nodes.json',root),'utf8')),license=await fs.readFile(new URL('node_modules/lucide-static/LICENSE',root),'utf8')
const names=['book-open','columns-2','chart-column','chart-line','list-ordered','sliders-horizontal','lightbulb','sparkles','check','circle-check','arrow-right','arrow-down','download','maximize-2','minimize-2','copy','chevron-right','info','search','clock','calendar','code-xml','flask-conical','layout-grid']
const selected={};for(const name of names){if(!catalog[name])throw Error('Missing Lucide icon: '+name);selected[name]=catalog[name]}
const text='// Generated from lucide-static 1.70.0. Run node scripts/visual-icons.mjs.\n'+license.trim().split('\n').map(line=>line?'// '+line:'//').join('\n')+'\nexport const VISUAL_ICONS='+JSON.stringify(selected)+'\n'
const target=new URL('src/visual-icons.js',root)
if(process.argv.includes('--check')){if(await fs.readFile(target,'utf8')!==text)throw Error('Visual icons are out of date')}
else await fs.writeFile(target,text)
