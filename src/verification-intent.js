// Choose the reply flow and optionally extract a short public search phrase.
// The caller must validate that phrase again before sending it to the web.
const cancel = /(?:不用|不要|不必|无需|别|取消|停止|先不|暂不|不需要)\s*(?:你|帮我|再|去|上网|联网|网上|查证)*\s*(?:查|搜|核实|核对|验证|联网|上网)|(?:直接|只用|凭|根据)(?:你|已有的)?(?:记忆|已有资料|常识|印象)回答|\b(?:do not|don't|no need to|stop|without)\s+(?:search(?:ing)?|brows(?:e|ing)|look(?:ing)? up|check(?:ing)? online)\b/i
const referenceOnly = /^(?:请\s*)?(?:如果|假设|假如|设想|角色扮演|翻译|改写|润色|复述|写(?:一[段个篇]|个)(?:虚构|故事|小说|剧本)|在(?:小说|故事|游戏)里|suppose\b|imagine\b|translate\b|rewrite\b|proofread\b|roleplay\b)/i
const privateContext = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\b[a-z]:[\\/]|\.\.?[\\/]|~[\\/]|\/(?:home|mnt|Users)\/)|(?:API\s*key|密码|密钥|token)\s*[:：=]|(?:我的?|我们|本地|本机|内网|公司内部)\s*(?:电脑|账户|账号|邮件|邮箱|文件|附件|文档|笔记|病历|聊天|对话|记录|项目|仓库|信息|资料|订单|余额|设置|日志|服务器|工作区|历史|日程|位置|住址)|(?:这|刚才)(?:个|份|张|上传的)?(?:文件|附件|截图)|\b(?:my|our|private|internal|local)\s+(?:account|inbox|email|file|attachment|notes?|logs?|repo(?:sitory)?|chat|conversation|workspace|server|records?|balance|order|address)\b|我们(?:上次|之前|刚才)聊|\bwhat we (?:said|discussed|talked about)\b)/i
const localArtifact = /(?:查(?:一下|下|查|询)?|核实(?:一下)?|核对(?:一下)?|搜(?:一下|索)?|看(?:一下|下)?|读(?:一下|下)?|打开)\s*(?:已上传的?|上传的?|刚发的?)?\s*(?:附件|截图|聊天记录|日志)|(?:检查|查看|确认)\s*(?:当前)?(?:工作区|未提交改动|git diff\b)|\b(?:check|read|open|inspect)\s+(?:the\s+)?(?:attachment|screenshot|workspace|local logs)\b/i
const localScope = /(?:本机|本地|内网|内部|私有)(?:的|里|上的|里的|中|中的)?\s*(?:项目|系统|服务|服务器|版本|记录|资料|文档|文件|仓库|代码|数据|目录|设备)/
const chineseLead = /^(?:(?:(?:请|帮我|给我|麻烦(?:你)?|可否|可以|能否|能不能|有没有办法|你|先|再|顺便|去|上网|联网|网上|在线)\s*){1,8}(?:查(?:一查|一下|下|查|证|询)?|搜(?:一搜|一下|下|搜|索)?|核实|核对|考证)|查(?:一查|一下|下|查|证|询)|搜(?:一搜|一下|下|搜)|核实|核对|考证|(?:查|搜|搜索)\s+)(?=\s|[\p{L}\p{N}：:，,。！!？?]|$)/u
const englishLead = /^(?:(?:please|can you|could you|would you|first)\s+)*(?:search(?:\s+(?:the web|online))?(?:\s+for)?|look\s+up|verify|fact[- ]check|check\s+(?:the official|online|whether))\b/i
const question = /[?？]|什么|多少|几(?:点|号|月|日|年)|哪(?:[一几]|里|儿|天|个|家)|何时|什么时候|怎么样|如何|有没有|是否|是不是|有无|了吗|吗\s*$|\b(?:what|when|where|which|who|how|is there|are there)\b/i
const readAction = /看看|看下|看一下|打开|读取|读一下|链接|页面|网页|核实|核对|查证|总结|概括|read|open|summari[sz]e|check/i
const officialSource = /官网|官方(?:网站|公告|通知|指南|说明|文档|规定|数据|回应|说法|链接|原文)|原始出处|\bofficial\s+(?:site|website|docs|announcement|release|notice|guidelines|statement|source)\b|\bprimary source\b/i
const sourceRequest = /(?:请|帮我|能否|能不能|可以|给我|发个|发我|去|用)[^。！？\n]{0,24}(?:看|读|找|核|验证|确认|搜索|查询|官网|官方)|\b(?:find|show|give me|send|check|read|open)\b/i
const sourceLead = /^(?:(?:请|能不能|能否|可以|能|帮我)\s*){0,6}(?:给我|发我|发个|找一下|找下)/
const timeSensitiveFact = /(?:价格|报价|售价|票价|运费|库存|汇率|股价|利率|市值|成交价|版本|稳定版|更新日志|更新了什么|发布时间|发布日期|上线|发售|上架|开售|开幕|停运|恢复运营|开放时间|营业时间|什么时候开|闭馆|开馆|截止|报名时间|录取结果|赛程|比赛结果|比分|排名|新闻|公告|最新进展|进展|天气|下雨|预警|温度|实时|新规|政策|名单|换届|首相|总理|总统|ceo|主席|发布了吗|发了没|是否发布|还可用|还能用|排期|延迟了吗|中断了吗|\b(?:price|cost|release|version|deadline|schedule|opening hours|available|stock|weather|forecast|score|rankings?|news|updates?|policy|rates?)\b)/i
const current = /(?:现在|当前|今天|今晚|明天|后天|昨天|当日|本周|周末|这个月|上个月|今年|最近|近期|最新|目前|刚刚|眼下|实时|新一版|还在|还能|还可|已发布|过去\d+[天周月年])|\b(?:now|today|tonight|tomorrow|yesterday|this (?:week|month|year)|current|latest|recent|right now|at the moment|newest|live)\b/i
const intrinsicallyCurrent = /(?:多少(?:钱|元|美元|人民币)|还能用|还可用|发布了吗|发了没|截止(?:时间|日期|到)|怎么收费)|\b(?:stock price|exchange rate|release date|current version|opening hours)\b/i
const biliSource = /^https?:\/\/(?:[a-z\d-]+\.)?bilibili\.com(?:[/:?#]|$)|^https?:\/\/b23\.tv(?:[/:?#]|$)/i
const biliTopic = /(?:\bBV[a-z0-9]{10}\b|(?:哔哩哔哩|B\s*站|\bbilibili\b)[^。！？\n]{0,24}(?:视频|番剧|弹幕|字幕|搜|找|看|播放|UP\s*主)|(?:在|去|搜|找|看)(?:哔哩哔哩|B\s*站|\bbilibili\b))/i
const nonPublicSeed = /[你我]|(?:这里|这边|这款|这个|那个|附近|刚才|上次|前面|发给|上传|截图|附件|私人|账号|住址|电话|病历|订单|邮箱|帐号|姓名|手机号|申请号|快递|预约|同事|同学|亲友)|\b(?:i|my|our|your|private|internal|near me|here|that|those|this (?:model|one)|id|account|inbox|tracking)\b/i
const genericChinese = /公开资料|官方(?:资料|网站|公告|通知|文档)|官网|网上|资料|能否|是否|是不是|最近|近期|最新|现在|当前|今天|明天|今年|目前|原始出处|原文|出处|从哪里|在哪里|怎么|多少(?:度|元|块|钱|天)?|什么|截止|日期|时间|价格|售价|汇率|版本|公告|链接|说明|发布|新闻|天气|明细|哪[天个年]|有无|一下|几号|几点|下雨|下雪|[请吗呢吧呀]/g
const genericEnglish = /\b(?:please|official|release|announcement|notice|docs?|price|rates?|time|date|latest|current|recent|weather|version|updates?|deadline|schedule|opening|hours|look|up|check|find|what|which|when|is|are|it|the|of|for|information|published|publishing|source|online|today|tomorrow|now|how|much|cost|this|web|give|me)\b/gi

function unquotedText(value) {
  return value.normalize('NFKC')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n')
    .replace(/^\s*>.*$/gm, '')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/g, '')
    .trim()
}

function publicLink(value) {
  try {
    const url = new URL(value.replace(/[)\]}.!?]+$/, ''))
    if (url.username || url.password || url.port || !url.hostname.includes('.')) return null
    if (/^(?:\d+[.\d]*|localhost)$|\.(?:local|internal|test|localhost|lan)$/i.test(url.hostname)) return null
    if (/\/(?:login|signin|oauth|private|internal|invite)(?:\/|$)/i.test(url.pathname)) return null
    if ([...url.searchParams.keys()].some(key => /(?:token|session|auth|secret|key|password|invite|signature)/i.test(key))) return null
    return url.href
  } catch {
    return null
  }
}

// Automatic searches use only a short, single-topic question with an explicit
// public facet and a distinguishable subject. Other requests are left for the
// model to formulate locally. The caller still applies its privacy checks.
function publicSeed(text) {
  const query = text.replace(chineseLead, '').replace(englishLead, '').replace(sourceLead, '')
    .replace(/^[\s：:]+|[?？。.!！；;]+\s*$/g, '').trim()
  if (query.length < 4 || query.length > 96 || !/^[\p{L}\p{N} .'+·_-]+$/u.test(query)) return undefined
  if (/\.(?:\s|$)/.test(query)) return undefined
  if (nonPublicSeed.test(query) || (!officialSource.test(query) && !timeSensitiveFact.test(query) && !intrinsicallyCurrent.test(query))) return undefined
  const subject = query.replace(genericChinese, '').replace(genericEnglish, '')
    .replace(/[^\p{L}\p{N}]/gu, '').replace(/^[的为]+|[的是为啥了在会]+$/g, '')
  if (subject.length < 2) return undefined
  return query
}

export function verificationIntent(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null
  const text = unquotedText(value)
  if (!text || cancel.test(text) || referenceOnly.test(text) || privateContext.test(text) || localArtifact.test(text) || localScope.test(text)) return null

  const links = [...text.matchAll(/https?:\/\/[^\s<>"'“”「」『』`，。！？；,]+/gi)].map(([link]) => publicLink(link))
  if (links.some(url => !url)) return null
  const explicit = text.split(/[，,。；;！？!?\n]/).some(clause => chineseLead.test(clause.trim()) || englishLead.test(clause.trim()))
  const asks = question.test(text)
  const official = officialSource.test(text) && (asks || sourceRequest.test(text))
  const linked = links.length > 0 && (readAction.test(text) || asks || explicit)
  const freshness = asks && (intrinsicallyCurrent.test(text) || (timeSensitiveFact.test(text) && current.test(text)))
  const reason = linked || official ? 'source' : explicit ? 'explicit' : freshness ? 'freshness' : null
  if (!reason) return null

  const domain = links.some(url => biliSource.test(url)) || biliTopic.test(text) ? 'bilibili' : 'web'
  const query = domain === 'web' && !links.length ? publicSeed(text) : undefined
  return {domain, reason, acknowledgement: reason === 'explicit' ? '好，我看看。' : '我查一下。', ...(query ? {query} : {})}
}
