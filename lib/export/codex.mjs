// lib/export/codex.mjs — DSH 会话事件 → Codex rollout JSONL（纯函数）
//
// 写出最小可被 convertCodexJsonl 再导入的子集：session_meta + response_item
//（user / assistant / function_call / function_call_output）。不做完整 Codex
// event_msg 镜像——目标是「Grok/Claude/DSH 续聊后，Codex 能看见同一段对话」。

import { randomUUID } from 'node:crypto'
import { toolResultOf } from '../convert/shape.mjs'
import { imageBlockFromSource } from '../convert/image.mjs'
import { eventIso, hasSurfaceEvents, jsonlResult, verifyJsonlRecords } from './common.mjs'

// DSH 内容块 → Codex ContentItem 数组（文本 + 图片）。图片块（导出前已解引用成 base64）
// 写成 `{type:'input_image', image_url:'data:…'}`（源转录里的原生形态）；拿不到字节的
// 图片块计入 skipped。textType 决定文本项的类型名（user/output 两侧不同）。
function partsOf(blocks, textType) {
  if (typeof blocks === 'string') return { parts: [{ type: textType, text: blocks }], images: 0, skipped: 0 }
  if (!Array.isArray(blocks)) return { parts: [], images: 0, skipped: 0 }
  const parts = []
  let images = 0
  let skipped = 0
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: textType, text: b.text })
      continue
    }
    if (b && b.type === 'image') {
      const img = imageBlockFromSource(b)
      if (img && typeof img.data === 'string' && img.data) {
        const mediaType = typeof img.mediaType === 'string' && img.mediaType ? img.mediaType : 'image/png'
        parts.push({ type: 'input_image', image_url: 'data:' + mediaType + ';base64,' + img.data })
        images++
        continue
      }
      skipped++
      continue
    }
    skipped++
  }
  return { parts, images, skipped }
}

function envelope(type, payload, timestamp) {
  return { timestamp, type, payload }
}

export function serializeCodexRecords(events, { meta, sessionUuid, cwd, emitHeader = true }) {
  const list = Array.isArray(events) ? events : []
  const sessionId = String(sessionUuid)
  const records = []
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let droppedToolResults = 0
  const pendingCalls = new Set()

  if (emitHeader) {
    records.push(envelope('session_meta', {
      id: sessionId,
      session_id: sessionId,
      timestamp: eventIso({ time: meta && meta.createdAt }, meta),
      cwd: cwd || (meta && meta.cwd) || '',
      originator: 'dsh-chat-import',
      source: 'dsh',
    }, eventIso({ time: meta && meta.createdAt }, meta)))
  }

  for (const ev of list) {
    if (!ev) continue
    const ts = eventIso(ev, meta)
    const data = ev.data || {}
    if (ev.type === 'user/message') {
      if (!data.source || data.source.kind !== 'user') { skippedInjections++; continue }
      const { parts, images, skipped } = partsOf(data.content, 'input_text')
      skippedBlocks += skipped
      const text = parts.filter((p) => p.type === 'input_text').map((p) => p.text).join('\n')
      if (!text && images === 0) continue
      records.push(envelope('response_item', {
        type: 'message',
        role: 'user',
        // 无图时保持既有形状（单 input_text），有图才用 ContentItem 数组
        content: images > 0 ? parts : [{ type: 'input_text', text }],
      }, ts))
    } else if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const { parts, images, skipped } = partsOf(msg.content, 'output_text')
      skippedBlocks += skipped
      const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text).join('\n')
      if (text || images > 0) {
        records.push(envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: images > 0 ? parts : [{ type: 'output_text', text }],
        }, ts))
      }
    } else if (ev.type === 'tool/call') {
      const callId = data.callId || randomUUID()
      records.push(envelope('response_item', {
        type: 'function_call',
        call_id: callId,
        name: data.name || 'unknown',
        arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
      }, ts))
      pendingCalls.add(callId)
      toolCalls++
    } else if (ev.type === 'tool/result') {
      // 形状无关读取（V3 wrapper / V4 一级 tool 消息），否则 V4 宿主上工具结果会整批丢
      const result = toolResultOf(ev)
      const callId = result && result.callId
      if (!callId) { droppedToolResults++; continue }
      const { parts, images, skipped } = partsOf(result.blocks, 'input_text')
      skippedBlocks += skipped
      // 有图：output 用 ContentItem 数组（源转录里的原生形态）；无图：既有纯字符串
      const output = images > 0 ? parts : parts.map((p) => p.text).join('\n')
      records.push(envelope('response_item', {
        type: 'function_call_output',
        call_id: callId,
        output,
      }, ts))
      pendingCalls.delete(callId)
      toolResults++
    }
  }

  for (const callId of pendingCalls) {
    records.push(envelope('response_item', {
      type: 'function_call_output',
      call_id: callId,
      output: '',
    }, eventIso({}, meta)))
    toolResults++
  }

  return { records, toolCalls, toolResults, droppedToolResults, skippedInjections, skippedBlocks }
}

export function serializeCodexJsonl({ meta, events, sessionUuid, cwd }) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  return jsonlResult(serializeCodexRecords(events, { meta, sessionUuid, cwd, emitHeader: true }))
}

export function verifyCodexJsonl(jsonl) {
  return verifyJsonlRecords(jsonl, {
    isHeader: (rec) => !!rec && rec.type === 'session_meta',
    headerMissing: '缺少 session_meta',
  })
}
