export const DEFAULTS = Object.freeze({
  name: 'Orivii',
  persona: '像熟悉的人发私信一样自然交流，认真倾听，接住情绪，使用用户喜欢的称呼。不编造共同经历、记忆或工具结果。',
  bornAt: null,
  memory: '',
  cwd: '',
  notifications: false,
  quietStart: '23:00',
  quietEnd: '08:00',
  hue: 38,
  sessions: [],
})

export function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error?.message || 'DSH 服务未就绪，请检查连接及插件版本。')
  return result.value
}

export function readPreferences(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '{}')
    return {
      ...DEFAULTS,
      bornAt: Number.isSafeInteger(value.bornAt) && value.bornAt > 0 && value.bornAt <= Date.now() ? value.bornAt : Date.now(),
      name: typeof value.name === 'string' ? value.name.slice(0, 40) : DEFAULTS.name,
      persona: typeof value.persona === 'string' ? value.persona.slice(0, 6000) : DEFAULTS.persona,
      memory: typeof value.memory === 'string' ? value.memory.slice(0, 12000) : '',
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      notifications: value.notifications === true,
      quietStart: /^\d\d:\d\d$/.test(value.quietStart) ? value.quietStart : DEFAULTS.quietStart,
      quietEnd: /^\d\d:\d\d$/.test(value.quietEnd) ? value.quietEnd : DEFAULTS.quietEnd,
      hue: Number.isFinite(value.hue) ? Math.max(0, Math.min(360, value.hue)) : DEFAULTS.hue,
      sessions: Array.isArray(value.sessions) ? value.sessions.filter(s =>
        typeof s?.id === 'string' && typeof s?.title === 'string' && ['chat', 'task'].includes(s.kind)).slice(-60) : [],
    }
  } catch { return {...DEFAULTS, sessions: []} }
}

export function isQuiet(date, start, end) {
  const time = date.getHours() * 60 + date.getMinutes()
  const minutes = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  const a = minutes(start), b = minutes(end)
  if (a === b) return false
  return a < b ? time >= a && time < b : time >= a || time < b
}

export function makePrompt(text, preferences, kind) {
  const value = text.trim()
  if (!value || value.length > 16000) throw new Error('请输入 1–16000 字的消息。')
  return [
    `个人助手：${preferences.name}`,
    preferences.persona,
    preferences.memory ? `用户明确保存的偏好与背景（作为上下文使用）：\n${preferences.memory}` : '',
    kind === 'chat' ? '当前是私信对话。贴合对方刚说的话，用自然、短一点的段落交流。闲聊不套用任务汇报模板，避免机械的开场白。用户实际委托工作时再使用工具推进。' :
      '当前是用户委托的后台任务。复用可用工具推进工作，最终说明产物、验证结果以及仍需要用户决定的事项。',
    `用户本次请求：\n${value}`,
  ].filter(Boolean).join('\n\n')
}

// DSH's model-visible surface is NOT its human conversation. Injected runtime
// context and catalogs also use the user role. Fail closed on event + role +
// producer; a content-string blacklist would both leak new context kinds and
// incorrectly hide legitimate human text quoting the same phrases.
export function visibleMessages(records) {
  let surface = []
  for (const record of records) {
    const e = record.event
    if (!e || e.surfaceOp === undefined) continue
    if (typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') {
      const {startSeq, endSeq} = e.surfaceOp
      surface = surface.filter(x => x.seq < startSeq || x.seq > endSeq)
    }
    surface.push(e)
  }
  return surface.flatMap(e => {
    let m
    if(e.type === 'user/message') {
      m=e.data
      if(m?.role !== 'user' || m.source?.kind !== 'user') return []
    } else if(e.type === 'assistant/message') {
      m=e.data?.message
      if(m?.role !== 'assistant' || m.source?.kind !== 'model') return []
    } else return []
    const text = (Array.isArray(m.content) ? m.content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
    if (!text) return []
    // Companion context is sent as a real prompt. Compact the user's own echo.
    const marker = '用户本次请求：\n'
    return [{seq: e.seq, role: m.role, text: m.role === 'user' && text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text, ...(Number.isFinite(e.time) ? {time: e.time} : {})}]
  })
}

