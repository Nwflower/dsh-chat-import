// Synthetic Copilot CLI session-state events; no user transcript or provider connection.
export const COPILOT_CLI_TIME = 1786100000000
export const COPILOT_CLI_SESSION = '11111111-2222-3333-4444-555555555555'

const iso = (ms) => new Date(ms).toISOString()

export function copilotCliEvent(id, parentId, offset, type, data) {
  return { id, parentId, timestamp: iso(COPILOT_CLI_TIME + offset), type, data }
}

export function copilotCliJsonl(events, extraLines = []) {
  return events.map((e) => JSON.stringify(e)).concat(extraLines).join('\n') + '\n'
}

// Two turns: one tool-mediated reply, one plain reply. hook.shutdown bookkeeping
// events ride along and must stay out of the conversation.
export function copilotCliConversation() {
  return [
    copilotCliEvent('e-start', null, 0, 'session.start', {
      sessionId: COPILOT_CLI_SESSION, version: 1, producer: 'copilot-agent',
      copilotVersion: '1.0.67', startTime: iso(COPILOT_CLI_TIME),
      selectedModel: 'example-model',
      context: { cwd: '/home/example/project', gitRoot: '/home/example/project', branch: 'main', hostType: 'cli' },
    }),
    copilotCliEvent('e-user1', 'e-start', 1000, 'user.message', {
      content: 'Inspect the example', messageId: 'm1', interactionId: 'i1', turnId: 't1',
      attachments: [{ name: 'example.txt' }],
    }),
    copilotCliEvent('e-asst1', 'e-user1', 2000, 'assistant.message', {
      messageId: 'm2', originatingMessageId: 'm1', content: 'Here is the plan.',
      reasoningText: 'Reading the example.', model: 'example-model', turnId: 't1',
      toolRequests: [{ toolCallId: 'c1', name: 'read_file', arguments: { path: 'example.txt' } }],
    }),
    copilotCliEvent('e-exec1', 'e-asst1', 3000, 'tool.execution_start', {
      toolCallId: 'c1', toolName: 'read_file', arguments: { path: 'example.txt' },
    }),
    copilotCliEvent('e-exec2', 'e-exec1', 3500, 'tool.execution_complete', {
      toolCallId: 'c1', success: true, result: { content: 'example output' },
    }),
    copilotCliEvent('e-asst2', 'e-exec2', 4000, 'assistant.message', {
      messageId: 'm3', originatingMessageId: 'm1', content: 'Done.', turnId: 't1',
    }),
    copilotCliEvent('e-hook', 'e-asst2', 4500, 'hook.start', { hookType: 'postToolUse' }),
    copilotCliEvent('e-user2', 'e-hook', 5000, 'user.message', {
      content: 'Explain the result', messageId: 'm4', interactionId: 'i2', turnId: 't2',
    }),
    copilotCliEvent('e-asst3', 'e-user2', 6000, 'assistant.message', {
      messageId: 'm5', originatingMessageId: 'm4', content: 'Explanation.', turnId: 't2',
    }),
    copilotCliEvent('e-end', 'e-asst3', 7000, 'session.shutdown', { shutdownType: 'routine' }),
  ]
}
