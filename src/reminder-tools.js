const string=(description,maxLength)=>({type:'string',description,maxLength})
const quote=string('逐字引用用户本次消息中与安排有关的连续原话，不引用助手、历史或系统提示。',16000)
const dueAt=string('明确未来时刻的 ISO 8601 日期，必须含时区偏移，例如 2026-11-01T15:00:00+08:00。按当前用户时区理解相对时间；拿不准就先问，不虚构时间。',80)
export const REMINDER_TOOLS=[
  {name:'reminder_create',description:'记下用户明确要求的提醒，或本次随口说出的确定未来安排。必须先成功调用，再自然确认会提醒。原话含糊、假设或否定时先问清；不能把普通聊天或自己想做的事变成提醒。仅在 DSH 运行且 Orivii 已解锁时送达，不是系统闹钟。',parameters:{type:'object',properties:{title:string('要提醒用户做的事，简短明确，不包含实现细节。',180),dueAt,quote},required:['title','dueAt','quote'],additionalProperties:false}},
  {name:'reminder_list',description:'查询已经真实保存的提醒。用户问“你会提醒我吗”“我还有什么安排”，或要改时间、取消却没有编号时先查。用自然语言回答，不输出编号、JSON、租约、心跳或后台步骤。',parameters:{type:'object',properties:{query:string('可选事项关键词；查不到时用空字符串列出全部待办。',200),includeFinished:{type:'boolean',description:'只有需要核对已完成、已取消或已送达记录时才开启。'}},additionalProperties:false}},
  {name:'reminder_update',description:'依据用户本次明确要求取消、完成或改期一条已有提醒。id 必须来自真实记录或 reminder_list，不得猜测。操作成功后简短自然确认，不展示工具细节。',parameters:{type:'object',properties:{id:string('真实提醒编号。',80),operation:{type:'string',enum:['cancel','complete','reschedule']},dueAt,quote},required:['id','operation','quote'],additionalProperties:false}},
]
export function reminderContext(state,c,now){
  return [
    '你具备主动提醒能力，可以在这次对话中直接调用 reminder_create / reminder_list / reminder_update。不要声称只能被动回复，也不要把用户引导到 DSH 的自动化任务管理页面。',
    `当前时间 ${new Date(now).toISOString()}；用户时区 ${c.policy.timeZone}；主动提醒${c.policy.enabled?'已开启':'已关闭'}。`,
    '用户明确说“到时提醒我”时，时间清楚就先调用 reminder_create 并检查 ok 与 delivery，再用一句自然的话确认，例如“好，明天下午三点我叫你。”没有成功记录不能承诺，也不要只回复后留给后台碰运气。',
    '用户随口提及有确定时间的未来安排，也可以悄悄记下；不用主动宣布保存、建立任务、记忆评分或内部机制。用户问起或改期、取消时用查询及修改工具核实。时间缺少必要信息时自然问一句，不编造日期或自动创建重复安排。',
    '关闭提醒、锁定 Orivii 或关闭 DSH 后不能送达；按需要如实说明这项限制，不在每条普通回复里重复。你明确答应的时刻不受日常关心频率或少打扰时段限制。',
    '工具调用、编号、JSON、执行日志、心跳和设置参数是内部资料，不能复制到气泡。对用户只说自然的确认、问题或提醒正文。',
  ].join('\n')
}
