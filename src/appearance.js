export const APPEARANCE_KEYS=['bubbleColor','replyColor','characterColor']
export const validColor=value=>value===''||typeof value==='string'&&/^#[\da-f]{6}$/i.test(value)
export function inkFor(color){
  const rgb=color.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
  const l=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722
  return (l+.05)/.05>=1.05/(l+.05)?'#000000':'#ffffff'
}
export function appearanceStyle(settings={}){
  const style={}
  for(const [key,name] of [['bubbleColor','outgoing'],['replyColor','incoming']])if(settings[key]&&validColor(settings[key])){
    style['--dot-'+name]=settings[key];style['--dot-'+name+'-ink']=inkFor(settings[key])
  }
  if(settings.characterColor&&validColor(settings.characterColor))style['--dot-character']=settings.characterColor
  return style
}
