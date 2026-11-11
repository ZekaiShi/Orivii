import {parse,serialize} from 'parse5'
import {validateVisualSpec,filePreviewKind} from './visual.js'
import {DotError} from './vault.js'
import {createHash} from 'node:crypto'
import {runPreviewCanvas,groupBubbleBlocks,previewColorPolicy} from './canvas.js'
import {VISUAL_ICONS} from './visual-icons.js'

const previewTags=new Set('html head body title style div span p section article main header footer aside nav h1 h2 h3 h4 h5 h6 ul ol li dl dt dd pre code blockquote strong em b i u s small sub sup br hr table thead tbody tfoot tr th td caption colgroup col figure figcaption details summary svg g path circle ellipse rect line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask symbol use'.split(' '))
const previewRemove=new Set(['header','footer','h1','script','iframe','object','embed','link','meta','base','form','input','textarea','select','button','template','foreignobject','image','img','video','audio','source','animate','animatetransform','set','annotation-xml','math'])
const previewAttributes=new Set('id class style title role aria-label aria-hidden width height viewbox preserveaspectratio x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity opacity transform font-size font-family font-weight text-anchor dominant-baseline dx dy offset stop-color stop-opacity gradientunits gradienttransform clippathunits clip-path mask href xlink:href xmlns colspan rowspan scope align data-icon data-template data-ratio data-bubble data-color data-swatch data-orivii-color-sample'.split(' '))
// HTML parsers normalize line endings before checking an inline script's CSP hash.
export const PREVIEW_SCRIPT=('('+runPreviewCanvas.toString()+')('+groupBubbleBlocks.toString()+','+previewColorPolicy.toString()+')').replace(/\r\n?/g,'\n')
export const PREVIEW_SCRIPT_HASH=createHash('sha256').update(PREVIEW_SCRIPT).digest('base64')

export function previewDocument(body){
  const csp="default-src 'none'; script-src 'sha256-"+PREVIEW_SCRIPT_HASH+"'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const css='/*ORIVII_PREVIEW_THEME*/html,body{color:var(--preview-ink,#171717);background:transparent!important;font:14px/1.7 system-ui,sans-serif;color-scheme:light dark;margin:0!important;padding:0!important;width:100%!important;height:auto!important;overflow:hidden!important}#orivii-preview-content{display:flow-root;width:100%;overflow-wrap:anywhere;padding:0 2px 2px;box-sizing:border-box}#orivii-preview-content *{box-sizing:border-box;box-shadow:none!important;animation:none!important;transition:none!important}#orivii-preview-content :not(svg,svg *):not([data-orivii-color-sample]){background:transparent!important}#orivii-preview-content svg{background:transparent!important}#orivii-preview-content :not(svg,svg *){opacity:1!important;filter:none!important;mix-blend-mode:normal!important;-webkit-text-fill-color:currentColor!important;min-width:0!important;max-width:100%!important;height:auto!important;max-height:none!important;overflow:visible!important;position:static!important;transform:none!important;zoom:1!important;font-family:inherit!important}#orivii-preview-content p,#orivii-preview-content li,#orivii-preview-content td,#orivii-preview-content th,#orivii-preview-content span,#orivii-preview-content div{font-size:14px!important;line-height:1.7!important}#orivii-preview-content h1{font-size:26px!important}#orivii-preview-content h2{font-size:16px!important}#orivii-preview-content h3{font-size:16px!important}#orivii-preview-content h4{font-size:16px!important}#orivii-preview-content h1,#orivii-preview-content h2,#orivii-preview-content h3,#orivii-preview-content h4{line-height:1.4!important;margin:12px 0 8px}p{margin:0 0 12px}svg{max-width:100%;height:auto}table{border-collapse:collapse;table-layout:fixed;width:100%}td,th{padding:8px 10px;border-bottom:1px solid #8884;text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}section,article{margin:0 0 16px}.orivii-icon{display:inline-block;vertical-align:-3px;margin-right:7px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:16px}.card{padding:14px;border:0;border-radius:0}'
  const flowCss='#orivii-preview-content{width:100%!important;max-width:100%!important;min-width:0!important;height:auto!important;max-height:none!important;min-height:0!important;position:relative!important;display:flow-root!important;overflow:visible!important;zoom:1!important}#orivii-preview-content :not(svg,svg *){min-height:0!important;clip-path:none!important;mask:none!important;float:none!important}'
  const bubbleCss='#orivii-preview-content section,#orivii-preview-content article,#orivii-preview-content main,#orivii-preview-content .card{border:0!important;border-radius:0!important;padding:0!important;box-shadow:none!important}#orivii-preview-content h2,#orivii-preview-content h3,#orivii-preview-content h4,#orivii-preview-content h5,#orivii-preview-content h6{font-size:14px!important;font-weight:600!important;line-height:1.7!important;margin:0 0 8px!important}#orivii-preview-content> :first-child{margin-top:0}#orivii-preview-content> :last-child{margin-bottom:0}'
  const colorCss='#orivii-preview-content [data-orivii-color-sample]{min-height:18px!important}#orivii-preview-content text,#orivii-preview-content tspan{opacity:1!important;fill-opacity:1!important;filter:none!important}'
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="referrer" content="no-referrer"><style>'+css+flowCss+bubbleCss+colorCss+'</style></head><body><main id="orivii-preview-content">'+body+'</main><script>'+PREVIEW_SCRIPT+'</script></body></html>'
}
export function sanitizeMarkup(source){
  if(typeof source!=='string'||!source.trim()||source.length>100000)throw new DotError('预览内容为空或超过限制。')
  const document=parse(source),counter={nodes:0}
  const textOf=node=>node.nodeName==='#text'?node.value:['style','script','svg'].includes(node.tagName)?'':(node.childNodes||[]).map(textOf).join(' ')
  function visit(parent,depth){
    if(depth>32)throw new DotError('预览层级过深。')
    const kept=[]
    for(const node of parent.childNodes||[]){
      if(++counter.nodes>5000)throw new DotError('预览内容过于复杂。')
      if(node.nodeName==='#text'){kept.push(node);continue}
      const tag=String(node.tagName||'').toLowerCase()
      if(!tag||previewRemove.has(tag)||(node.attrs||[]).some(a=>a.name==='role'&&['banner','contentinfo'].includes(a.value)||a.name==='class'&&a.value.split(/\s+/).some(name=>/^(?:page[-_])?(?:header|footer|title|subtitle)$/.test(name))))continue
      visit(node,depth+1)
      if(!previewTags.has(tag)){for(const child of node.childNodes||[]){child.parentNode=parent;kept.push(child)}continue}
      node.attrs=(node.attrs||[]).filter(attribute=>{
        const name=attribute.name.toLowerCase(),value=attribute.value
        if(!previewAttributes.has(name)||name.startsWith('on')||value.length>20000)return false
        if(name==='href'||name==='xlink:href')return /^#[a-zA-Z][\w.-]*$/.test(value)
        if(['fill','stroke','clip-path','mask'].includes(name)&&/url\(/i.test(value))return /^url\(#[a-zA-Z][\w.-]*\)$/.test(value)
        return true
      })
      const displayStyle=value=>value.replace(/!\s*important/gi,'').replace(/display\s*:\s*none/gi,'display:block').replace(/visibility\s*:\s*(?:hidden|collapse)/gi,'visibility:visible')
      for(const attribute of node.attrs)if(attribute.name==='style')attribute.value=displayStyle(attribute.value)
      if(tag==='style')for(const child of node.childNodes||[])if(child.nodeName==='#text')child.value=displayStyle(child.value)
      const plain=['div','section','span','li','td','code'].includes(tag)?textOf(node).trim():'',classes=node.attrs.find(a=>a.name==='class')?.value||''
      if(node.attrs.some(a=>['data-color','data-swatch'].includes(a.name))||classes.split(/\s+/).some(name=>/(?:^|[-_])(?:swatch|color-sample|color-chip)(?:$|[-_])/.test(name))||plain.length<=120&&/^#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3})\b/i.test(plain)&&(plain.match(/#[\da-f]{3,8}\b/gi)||[]).length===1)node.attrs.push({name:'data-orivii-color-sample',value:''})
      if(tag==='details')node.attrs.push({name:'open',value:''})
      const icon=node.attrs.find(attribute=>attribute.name==='data-icon')?.value
      if(icon&&Object.hasOwn(VISUAL_ICONS,icon)){
        const escaped=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
        const markup='<svg class="orivii-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+VISUAL_ICONS[icon].map(([name,attrs])=>'<'+name+' '+Object.entries(attrs).map(([key,value])=>key+'="'+escaped(value)+'"').join(' ')+' />').join('')+'</svg>'
        const iconDoc=parse(markup),iconNode=iconDoc.childNodes.find(child=>child.tagName==='html')?.childNodes.find(child=>child.tagName==='body')?.childNodes[0]
        if(iconNode){iconNode.parentNode=node;node.childNodes=[iconNode]}
      }
      kept.push(node)
    }
    parent.childNodes=kept
  }
  visit(document,0)
  const html=document.childNodes.find(node=>node.tagName==='html'),head=html?.childNodes.find(node=>node.tagName==='head'),body=html?.childNodes.find(node=>node.tagName==='body')
  const styles=(head?.childNodes||[]).filter(node=>node.tagName==='style').map(node=>'<style>'+serialize(node)+'</style>').join('')
  return previewDocument(styles+(body?serialize(body):serialize(document)))
}
export async function filePreview(files,id){
  const {file,bytes}=await files.bytes(id),kind=filePreviewKind(file)
  if(!kind||bytes.length>300000)throw new DotError('此文件暂不支持内嵌预览。')
  const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  if(kind==='visual')return {kind,spec:validateVisualSpec(JSON.parse(source))}
  return {kind,html:sanitizeMarkup(source)}
}
