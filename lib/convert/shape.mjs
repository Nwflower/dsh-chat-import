// lib/convert/shape.mjs — 会话事件的**读侧形状无关契约**与写侧形状分流。
//
// 宿主对工具结果的 message 形状是互斥校验的（V3 要求 content[0] 是 {type:'tool-result'}
// 包装，V4 要求 message.toolCallId 且禁止 wrapper），所以：
//   * toolResultOf(ev) 是唯一的读取入口（导出 / 校验 / Markdown 都走它），不关心事件来自哪版；
//   * shapeToolResults(events, version) 是唯一的写侧分流点（双向幂等）；
//   * isEnvInjectionEvent 认两种形状——V3 的 source.kind='plugin' 与 V4 改写成生产者自有
//     kind 的 'plugin:chat-import'（重导自己的导入会话时要能跳过注入声明）。
// 环境变更声明的 user/message 事件 id（'import:<会话 id>:env'）。
export const ENV_INJECTION_EVENT_ID_SUFFIX = ':env'

// 判定「环境变更声明」注入事件：source.kind='plugin' 且 id 以 :env 结尾。识别不按
// 事件类型做（user/message 也承载真实提问），id 形状是写入侧与读取侧（tailSessionEvents
// 续写时跳过、validateSessionEvents 定位注入位）共用的契约。
export function isEnvInjectionEvent(ev) {
  if (!ev || ev.type !== 'user/message') return false
  const data = ev.data
  if (!data || !data.source || typeof data.source !== 'object') return false
  // V3 写 source.kind='plugin'；V4 把 kind 改写成生产者自有 kind（'plugin:chat-import'），
  // 所以两种形状都要认——否则 V4 日志里的注入声明会被当成真实提问。
  const kind = typeof data.source.kind === 'string' ? data.source.kind : ''
  const plugin = typeof data.source.plugin === 'string' ? data.source.plugin : ''
  if (kind !== 'plugin' && kind !== 'plugin:chat-import' && plugin !== 'chat-import') return false
  return typeof data.id === 'string' && data.id.endsWith(ENV_INJECTION_EVENT_ID_SUFFIX)
}


// 从一次完整转换中截取「第 fromTurn 轮及之后」的事件尾部，seq 从 fromSeq 重新编号
// （供增量续写：重导把源文件新增轮次 append 进同一 DSH 会话）。
//
// 轮次边界由 turn/start 事件的 data.turn 决定（不是每个事件都带 data.turn）。
// 末尾的 session/title 事件（无 turn）默认剥离（dropSessionEvents=true）——标题只在
// 全量导入时写一次，续写轮次不重复钉标题。历史日志头部的 session/imported 标记
//（无 turn 包裹）同样不进尾部（append-only 纪律；标记自 0.8.3 起不再写入，读取侧
// 对旧日志仍兼容）。环境变更声明（isEnvInjectionEvent）恒不入选——它现在位于首个
// turn 内，若按轮次入选会在续写尾部中间再插一条注入（issue #66）；前段已有一条，
// 不重复。工具结果事件
// 的 sourceEventSeqs 重映射到尾部新 seq；指向尾部之外的引用（跨轮异步工具：调用在
// 已导入前段、结果在新增尾部）原样保留——前段 seq 未变，旧值仍指向真实调用——并
// 计入 droppedBoundaryResults。被保留的事件除 seq 外原样保留（surfaceOp:'append'
// 等随事件走，续写不重写、不附加标题）。
// 工具结果的两种宿主形状（跨格式版本的唯一硬差异）：
//   V3（≤0.1.5-rc.2）：tool/result 的 message 是 role:'user'，内容里塞一个
//                      {type:'tool-result', toolCallId, content[, isError]} wrapper，
//                      callId 同时出现在 wrapper 与 source.callId 上。
//   V4（≥0.1.7-alpha.1）：message 是 role:'tool'，toolCallId / content / isError **直接挂在
//                      message 上**，wrapper 退役（V4 原生准入见到 wrapper 即拒）。
// 两种形状都被宿主核心 Session 严格校验（V3 要求 wrapper、V4 要求一级字段），产出必须跟随
// 宿主版本——不能只吐一种。幂等：任一输入形状都接受，输出恒为目标形状；无法关联 callId 的
// 畸形节点原样返回，交由 validateSessionEvents / 宿主各自报错（不静默吞）。
// 工具结果的**读**侧访问器：不管事件是 V3（wrapper）还是 V4（一级 tool 消息）形状，
// 都取出 { callId, blocks, isError }。导出层与诊断层（verify_session）用它读取宿主会话
// 事件——宿主升到 V4 后事件是 V4 形状，仍按 wrapper 找会静默丢工具结果 / 误报孤儿结果。
// 取不到（非 tool/result、缺 callId、content 非数组）返回 null，由调用方决定如何计数上报。
export function toolResultOf(ev) {
  const r = readToolResult(ev)
  return r && { callId: r.callId, blocks: r.blocks, isError: r.isError }
}

// 两种形状共用的拆解：V3 取 wrapper（callId 与内容在 content[0]），V4 取一级字段；callId
// 依次回退 wrapper.toolCallId → message.toolCallId → source.callId。拿不到 callId 或内容
// 不是数组时返回 null。
function readToolResult(ev) {
  if (!ev || ev.type !== 'tool/result') return null
  const data = ev.data && typeof ev.data === 'object' ? ev.data : null
  const message = data && data.message && typeof data.message === 'object' ? data.message : null
  if (!message) return null
  const source = message.source && typeof message.source === 'object' ? message.source : null
  const content = Array.isArray(message.content) ? message.content : null
  const wrapper = content && content.length === 1 && content[0] && typeof content[0] === 'object'
    && content[0].type === 'tool-result' ? content[0] : undefined
  const callId = (wrapper && typeof wrapper.toolCallId === 'string' && wrapper.toolCallId)
    || (typeof message.toolCallId === 'string' && message.toolCallId)
    || (source && typeof source.callId === 'string' && source.callId)
    || null
  if (!callId) return null
  const blocks = wrapper ? wrapper.content : content
  if (!Array.isArray(blocks)) return null
  const isError = (wrapper ? wrapper.isError : message.isError) === true
  return { data, message, source, callId, blocks, isError }
}

export function shapeToolResults(events, version) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return list
  const wantV4 = version >= 4
  return list.map((ev) => {
    const r = readToolResult(ev)
    if (!r) return ev
    const { data, message, source, callId, blocks, isError } = r
    const nextMessage = {
      ...message,
      source: { ...(source || {}), kind: 'tool', callId },
    }
    delete nextMessage.plugin
    if (wantV4) {
      nextMessage.role = 'tool'
      nextMessage.toolCallId = callId
      nextMessage.content = blocks
      if (isError) nextMessage.isError = true
      else delete nextMessage.isError
    } else {
      nextMessage.role = 'user'
      nextMessage.content = [{
        type: 'tool-result',
        toolCallId: callId,
        content: blocks,
        ...(isError ? { isError: true } : {}),
      }]
      delete nextMessage.toolCallId
      delete nextMessage.isError
    }
    return { ...ev, data: { ...data, message: nextMessage } }
  })
}
