// test/_support/codex-compacted.mjs — Codex 压缩夹具（convert/dsh 两处用例共用，故收进 _support/）。
//
// 合成 rollout：session_meta + 压缩前的整轮 + compacted 信封 + 压缩后跨轮产物 + 新提问。
// 压缩点落在一轮工具执行中间（实测形态）：窗口首批产物属于压缩前就开着的那一轮。
export function codexCompactedRollout(over = {}) {
  const summary = 'Another language model started to solve this problem and produced a summary of its thinking process. Summary: 前一段工作已完成 X。'
  const compacted = {
    timestamp: '2026-09-07T09:10:03.113Z', type: 'compacted',
    payload: {
      message: summary,
      replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一个任务' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '确认到哪一步了？' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: summary }] },
      ],
      window_number: 2,
      ...over,
    },
  }
  const j = (o) => JSON.stringify(o)
  return [
    j({ timestamp: '2026-09-07T04:22:51.704Z', type: 'session_meta', payload: { id: 'codex-comp-1', cwd: 'D:\\demo\\codex-comp', timestamp: '2026-09-07T04:22:50.722Z' } }),
    j({ timestamp: '2026-09-07T04:23:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一个任务' }] } }),
    j({ timestamp: '2026-09-07T04:23:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '压缩前的回答' }] } }),
    j({ timestamp: '2026-09-07T04:23:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_pre' } }),
    j({ timestamp: '2026-09-07T04:23:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_pre', output: '压缩前的工具输出' } }),
    j(compacted),
    // 压缩后：先有 reasoning / assistant / 工具产物（属于跨压缩点那一轮），最后才是新提问
    j({ timestamp: '2026-09-07T09:10:04.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '**继续之前的排查**' }] } }),
    j({ timestamp: '2026-09-07T09:10:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '压缩后的回答' }] } }),
    j({ timestamp: '2026-09-07T09:10:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '{"path":"a.txt"}', call_id: 'call_post' } }),
    j({ timestamp: '2026-09-07T09:10:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_post', output: '压缩后的工具输出' } }),
    j({ timestamp: '2026-09-07T09:11:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '新提问' }] } }),
    j({ timestamp: '2026-09-07T09:11:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '新回答' }] } }),
  ].join('\n')
}
