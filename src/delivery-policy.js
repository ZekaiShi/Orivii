// Delivery is chosen from the user's own request, never from model plans,
// retrieved pages, attachment contents or the research worker's objective.
const format='(?:HTML?|SVG|CSV|TSV|JSON|Markdown|PDF|PPTX?|DOCX?|XLSX?|Excel|Word|PowerPoint|Python|JavaScript|TypeScript|SQL)'
const target=`(?:文件|附件|网页|网站|脚本|程序|代码|文档|幻灯片|演示文稿|${format}|[\\w.-]+\\.(?:html?|svg|csv|tsv|json|md|txt|py|js|ts|css|sql)\\b)`
const create='(?:生成|创建|制作|做(?:成)?|写|编写|导出|保存|下载|交付|打包|修改|编辑|更新|开发|搭建)'
const request=new RegExp(`${create}[^，,。；;！？!?\\n]{0,80}${target}|${target}[^，,。；;！？!?\\n]{0,24}(?:给我|发我|导出|下载|保存|改成|修改)|(?:给我|来)(?:一[个份张段]|个|份)?(?:可下载的|完整的|独立的)?\\s*${target}`,'i')
const cancel=new RegExp(`(?:不用|不要|不想|无需|别|取消|停止|先不|暂不|不必)[^，,。；;！？!?\\n]{0,20}${target}|(?:直接|只要|只用|仅用)(?:在聊天里|在这里|用)?(?:文字|一句话|纯文本|口头|说|回答|聊天)|(?:回到|继续)(?:正常)?(?:聊天|闲聊)`,'i')
const question=/^(?:请)?(?:解释|介绍|讲讲|说说|如何|怎么|为什么|什么是|能否说明)|^(?:what\b|why\b|how\b|explain\b|describe\b)/i
const narration=/^(?:(?:你|模型|agent|它|他|她)(?:总是|一直|经常|每次|通常|老是|总|默认|曾经|上次|刚才)|我(?:喜欢|经常|曾经|以前|刚才|每天)|他说|她说|文中说)/i
const followup=/^(?:继续|接着|再来一份|再做一份|再生成一份)[吧呢呀啊。.!！~～\s]*$|^(?:(?:把|将)?(?:它|这个|那个|刚才的|上一份|上面的|这一份|原来的)?)\s*(?:改成|改为|换成|改一下|再加|加上|添加|删掉|删除|补充|调整|优化|修复)|^(?:continue|make it|change (?:it|the)|add |remove |fix )/i
const englishRequest=/\b(?:create|make|write|build|generate|export|save|download|edit|update)\b[^.!?;\n]{0,80}\b(?:files?|attachments?|websites?|webpages?|scripts?|code|documents?|html?|svg|csv|json|pdf|pptx?|docx?|xlsx?)\b/i
const englishCancel=/\b(?:no|without)\s+(?:files?|attachments?|html)\b|\b(?:don't|do not|stop)\s+(?:creating|writing|generating|saving|create|write|generate|save)\b|\b(?:just|only)\s+(?:chat|text|answer|reply)\b/i

function instructions(value){
  // Quoted examples and code are reference material, not delivery requests.
  return String(value||'').slice(0,20000).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .replace(/^\s*>.*$/gm,'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g,quoted=>/^.[^\s/\\<>:"“”「」『』]+\.(?:html?|svg|csv|json|md|txt|py|js|ts).$/i.test(quoted)?quoted.slice(1,-1):'')
}

export function deliveryIntent(value){
  let intent=null
  for(const clause of instructions(value).split(/[，,。；;！？!?\n]+/)){
    const text=clause.trim();if(!text)continue
    if(cancel.test(text)||englishCancel.test(text)){intent='chat';continue}
    if(question.test(text)||narration.test(text))continue
    if(request.test(text)||englishRequest.test(text)){intent='file';continue}
    if(followup.test(text))intent??='followup'
  }
  return intent
}

export function deliveryPolicy(messages,{chatId,userId,background=false,initial}={}){
  const users=messages.filter(m=>m.role==='user'&&m.chatId===chatId),index=users.findIndex(m=>m.id===userId)
  let allowFileCreation=false,intent=null
  if(index>=0)for(const message of users.slice(Math.max(0,index-12),index+1)){
    intent=deliveryIntent(message.text)
    allowFileCreation=intent==='file'||intent==='followup'&&allowFileCreation
  }
  // Background work keeps the delivery requested when it was dispatched.
  // Subsequent casual chat cannot turn a lookup into a file-writing task.
  if(background&&typeof initial?.allowFileCreation==='boolean')allowFileCreation=initial.allowFileCreation
  if(background&&index>=0&&users.slice(index+1).some(m=>deliveryIntent(m.text)==='chat')){
    allowFileCreation=false;intent='chat'
  }
  return {allowFileCreation,intent}
}
