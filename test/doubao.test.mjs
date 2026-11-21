// test/doubao.test.mjs — 豆包桌面版（Doubao Desktop）转换器：本地快照 → DSH 会话
//
// 覆盖的是「本地 IndexedDB 里能拿到什么」这件事的边界：
//   • 流式快照合并（同一 taskId 的几十个快照只成一个回合，取最长的那版）；
//   • 会话正文缺失时不伪造会话（豆包历史正文在服务端，本地只缓存最近打开过的）；
//   • 块类型判别（只有 block_type 10000 是文本，其它计入 skippedBlocks）；
//   • 时间口径（秒 / 毫秒 / 带小数的秒混用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectDoubaoConversations,
  collectDoubaoTasks,
  convertDoubaoDb,
  convertDoubaoSession,
  extractDoubaoSessions,
  normalizeDoubaoTask,
  DOUBAO_PROTOCOL_KEY,
  DOUBAO_TEXT_BLOCK,
} from '../lib/convert/doubao.mjs'

// ── 夹具构造：模拟 readIndexedDb 的产物 ────────────────────────────────────────
function textBlock(text) {
  return { block_type: DOUBAO_TEXT_BLOCK, content: { text_block: { text } } }
}

function task({ conversationId = 'conv-1', prompt = '', reply = '', promptTime, replyTime } = {}) {
  const received = {}
  if (reply !== '' || replyTime !== undefined) {
    received['msg-1'] = {
      extra: {
        create_time: replyTime,
        content_blocks_v2: reply === '' ? [] : [textBlock(reply)],
      },
    }
  }
  return {
    sessionId: 'task-1',
    requestQuery: {
      syncTask: {
        client_meta: { conversation_id: conversationId },
        messages: [{ content_block: prompt === '' ? [] : [textBlock(prompt)] }],
        option: { create_time_ms: promptTime },
      },
    },
    receivedMessages: received,
  }
}

function protocolRecord(snapshots) {
  return {
    databaseId: 1,
    objectStoreId: 1,
    key: DOUBAO_PROTOCOL_KEY,
    value: snapshots[snapshots.length - 1],
    versions: snapshots,
    versionCount: snapshots.length,
  }
}

function listRecord(conversations, schema = 'conversation-list-data-overall-v2') {
  return { databaseId: 3, objectStoreId: 2, key: 'overall', value: { schema, data: { conversations } } }
}

function snapshot(tasks) {
  return { state: { mainTaskDataMap: tasks }, version: 2 }
}

// ── normalizeDoubaoTask ─────────────────────────────────────────────────────────

test('normalizeDoubaoTask：抽取提问、回答与时间', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const got = normalizeDoubaoTask('t1', task({
    conversationId: 'conv-9', prompt: '你好', reply: '你好呀',
    promptTime: 1792575407523, replyTime: 1792575409544,
  }), stats)
  assert.equal(got.conversationId, 'conv-9')
  assert.equal(got.taskId, 't1')
  assert.equal(got.prompt, '你好')
  assert.equal(got.reply, '你好呀')
  assert.equal(got.promptTime, 1792575407523)
  assert.equal(got.replyTime, 1792575409544)
  assert.equal(stats.skippedBlocks, 0)
})

test('normalizeDoubaoTask：没有 conversation_id 的任务返回 null（不猜归属）', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const noConv = task({ prompt: 'q' })
  delete noConv.requestQuery.syncTask.client_meta.conversation_id
  assert.equal(normalizeDoubaoTask('t1', noConv, stats), null)
})

test('normalizeDoubaoTask：非文本块计入 skippedBlocks，不伪造占位文本', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const withImage = {
    requestQuery: {
      syncTask: {
        client_meta: { conversation_id: 'conv-1' },
        messages: [{ content_block: [{ block_type: 10001, content: { image_block: {} } }, textBlock('看图')] }],
        option: {},
      },
    },
    receivedMessages: {},
  }
  const got = normalizeDoubaoTask('t1', withImage, stats)
  assert.equal(got.prompt, '看图')
  assert.equal(stats.skippedBlocks, 1)
})

test('normalizeDoubaoTask：空提问空回答返回 null', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  assert.equal(normalizeDoubaoTask('t1', task({ prompt: '', reply: '' }), stats), null)
})

// ── collectDoubaoTasks：流式快照合并 ───────────────────────────────────────────

test('collectDoubaoTasks：同一 taskId 的流式快照合并成一个回合，取最长回答', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const record = protocolRecord([
    snapshot({ t1: task({ prompt: '问', reply: '答' }) }),
    snapshot({ t1: task({ prompt: '问', reply: '答：完整回答' }) }),
    snapshot({}), // 生成结束后被清空的快照
  ])
  const { turns } = collectDoubaoTasks([record], stats)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].prompt, '问')
  assert.equal(turns[0].reply, '答：完整回答')
})

test('collectDoubaoTasks：只看最后一版会丢正文——历史版本必须一并扫', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  // 最后一版被清空；正文只在前面几版里
  const record = protocolRecord([
    snapshot({ t1: task({ prompt: '哈夫曼编码是？', reply: '完整回答' }) }),
    snapshot({}),
  ])
  assert.ok(record.value.state.mainTaskDataMap && Object.keys(record.value.state.mainTaskDataMap).length === 0)
  const { turns } = collectDoubaoTasks([record], stats)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].reply, '完整回答')
})

test('collectDoubaoTasks：不同 taskId 是不同回合', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const record = protocolRecord([
    snapshot({
      a: task({ prompt: '第一问', reply: '第一答' }),
      b: task({ prompt: '第二问', reply: '第二答' }),
    }),
  ])
  const { turns } = collectDoubaoTasks([record], stats)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map((t) => t.prompt).sort(), ['第一问', '第二问'])
})

test('collectDoubaoTasks：同一 taskId 的重答（内容不续接）计入 restarted', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const record = protocolRecord([
    snapshot({ t1: task({ prompt: '问', reply: '旧回答' }) }),
    snapshot({ t1: task({ prompt: '问', reply: '完全不同的新回答' }) }),
  ])
  const { turns, restarted } = collectDoubaoTasks([record], stats)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].reply, '完全不同的新回答')
  assert.equal(restarted, 1)
})

// ── collectDoubaoConversations：列表元数据合并 ──────────────────────────────────

test('collectDoubaoConversations：同一会话在多个 schema 变体里出现时逐字段合并', () => {
  const records = [
    listRecord([{ conversation_id: 'conv-1', name: '标题 A', create_time: '1792570946' }], 'conversation-list-data-non-device-v1'),
    listRecord([{ conversation_id: 'conv-1', name: '', create_time: '', update_time: '1792575407.552' }], 'conversation-list-data-overall-v2'),
  ]
  const conversations = collectDoubaoConversations(records)
  const got = conversations.get('conv-1')
  assert.equal(got.title, '标题 A')
  assert.equal(got.createdAt, 1792570946000)
  assert.equal(got.updatedAt, 1792575407552)
})

test('collectDoubaoConversations：非 conversation-list schema 的记录不参与', () => {
  const records = [listRecord([{ conversation_id: 'x' }], 'something-else')]
  assert.equal(collectDoubaoConversations(records).size, 0)
})

// ── extractDoubaoSessions ──────────────────────────────────────────────────────

test('extractDoubaoSessions：只产出有正文的会话，缺正文的计入 emptyConversations', () => {
  const db = {
    records: [
      listRecord([
        { conversation_id: 'with-body', name: '有正文' },
        { conversation_id: 'no-body', name: '只有标题' },
      ]),
      protocolRecord([snapshot({ t1: task({ conversationId: 'with-body', prompt: '问', reply: '答' }) })]),
    ],
  }
  const { sessions, stats } = extractDoubaoSessions(db)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'with-body')
  assert.equal(sessions[0].title, '有正文')
  assert.equal(sessions[0].turns.length, 1)
  assert.equal(stats.emptyConversations, 0)
})

test('extractDoubaoSessions：正文在协议存储里但列表没有元数据时仍成会话（orphan）', () => {
  const db = {
    records: [protocolRecord([snapshot({ t1: task({ conversationId: 'orphan-1', prompt: '问', reply: '答' }) })])],
  }
  const { sessions, stats } = extractDoubaoSessions(db)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'orphan-1')
  assert.equal(sessions[0].title, '')
  assert.equal(stats.orphanConversations, 1)
})

test('extractDoubaoSessions：回合按提问时间升序', () => {
  const db = {
    records: [protocolRecord([
      snapshot({
        late: task({ prompt: '后问', reply: '后答', promptTime: 2000 }),
        early: task({ prompt: '先问', reply: '先答', promptTime: 1000 }),
      }),
    ])],
  }
  const { sessions } = extractDoubaoSessions(db)
  assert.deepEqual(sessions[0].turns.map((t) => t.prompt), ['先问', '后问'])
})

// ── convertDoubaoSession ───────────────────────────────────────────────────────

test('convertDoubaoSession：一問一答成一轮，回答进同一步', () => {
  const session = {
    id: 'conv-1',
    title: '哈夫曼编码',
    createdAt: 1792575400000,
    updatedAt: 1792575500000,
    turns: [{ taskId: 't1', prompt: '哈夫曼编码是？', reply: '是一种无损压缩编码', promptTime: 1792575401000, replyTime: 1792575402000 }],
  }
  const out = convertDoubaoSession(session, {})
  assert.equal(out.meta.sourceId, 'conv-1')
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '哈夫曼编码是？')
  assert.equal(out.turns[0].steps.length, 1)
  assert.equal(out.turns[0].steps[0].content[0].type, 'text')
  assert.equal(out.turns[0].steps[0].content[0].text, '是一种无损压缩编码')
  assert.equal(out.messages, 2)
  assert.ok(out.events.length > 0)
  // 来源标签落在 assistant/message 的 source 上（会话事件里 provider 的唯一载体）
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(assistant.data.message.source.provider, 'doubao')
})

test('convertDoubaoSession：只有提问没有回答时仍成轮（不伪造回答）', () => {
  const session = { id: 'conv-2', title: '', createdAt: 1, turns: [{ taskId: 't1', prompt: '只有提问', reply: '' }] }
  const out = convertDoubaoSession(session, {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '只有提问')
  assert.equal(out.turns[0].steps.length, 0)
  assert.equal(out.messages, 1)
})

test('convertDoubaoSession：会话标题取源标题；没有标题时回退首问', () => {
  const withTitle = convertDoubaoSession({
    id: 'c1', title: '源标题', createdAt: 1,
    turns: [{ taskId: 't', prompt: '首问', reply: '答' }],
  }, {})
  assert.equal(withTitle.title, '源标题')
  const noTitle = convertDoubaoSession({
    id: 'c2', title: '', createdAt: 1,
    turns: [{ taskId: 't', prompt: '首问', reply: '答' }],
  }, {})
  assert.equal(noTitle.title, '首问')
})

test('convertDoubaoSession：没有回合时是跳过（不是空会话）', () => {
  const out = convertDoubaoSession({ id: 'c3', title: '空', turns: [] }, {})
  assert.equal(out.skipped, 1)
  assert.ok(out.skipReason)
})

test('convertDoubaoSession：sessionId 可由 args 指定', () => {
  const out = convertDoubaoSession({
    id: 'c4', title: 't', createdAt: 1,
    turns: [{ taskId: 't', prompt: '问', reply: '答' }],
  }, { sessionId: 'my-session' })
  assert.equal(out.meta.id, 'my-session')
})

// ── convertDoubaoDb：端到端 ────────────────────────────────────────────────────

test('convertDoubaoDb：多会话库 → 每个有正文的会话一条', () => {
  const db = {
    records: [
      listRecord([
        { conversation_id: 'a', name: '会话 A' },
        { conversation_id: 'b', name: '会话 B' },
        { conversation_id: 'c', name: '只有标题' },
      ]),
      protocolRecord([
        snapshot({
          ta: task({ conversationId: 'a', prompt: 'A 问', reply: 'A 答' }),
          tb: task({ conversationId: 'b', prompt: 'B 问', reply: 'B 答' }),
        }),
      ]),
    ],
  }
  const { items } = convertDoubaoDb(db)
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.session.id).sort(), ['a', 'b'])
  for (const item of items) {
    assert.ok(item.converted.events.length > 0)
    const assistant = item.converted.events.find((e) => e.type === 'assistant/message')
    assert.equal(assistant.data.message.source.provider, 'doubao')
  }
})

test('convertDoubaoDb：空库不产出任何会话（调用方据此报告原因）', () => {
  const { items, sessions, stats } = convertDoubaoDb({ records: [] })
  assert.equal(items.length, 0)
  assert.equal(sessions.length, 0)
  assert.equal(stats.restarted, 0)
})

// ── 时间口径 ──────────────────────────────────────────────────────────────────

test('时间：秒 / 毫秒 / 带小数的秒都归一到毫秒', () => {
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const seconds = normalizeDoubaoTask('t', task({ prompt: 'q', promptTime: 1792570946 }), stats)
  assert.equal(seconds.promptTime, 1792570946000)
  const millis = normalizeDoubaoTask('t', task({ prompt: 'q', promptTime: 1792575407523 }), stats)
  assert.equal(millis.promptTime, 1792575407523)
  const fractional = normalizeDoubaoTask('t', task({ prompt: 'q', reply: 'a', replyTime: 1792575407.552 }), stats)
  assert.equal(fractional.replyTime, 1792575407552)
})

// ── 2.35+/2.37+ 的真实库漂移（本机 2.35.12 → 2.37.8 逐层实测，见 PR 正文）────────

test('2.35+：协议主键带账户前缀（im-sdk:user:<uid>:）也能提取', () => {
  const proto = protocolRecord([snapshot({ t1: task({ conversationId: 'conv-9', prompt: '问', reply: '答' }) })])
  const prefixed = { ...proto, key: 'im-sdk:user:2091696589113404:' + DOUBAO_PROTOCOL_KEY }
  const { sessions, stats } = extractDoubaoSessions({ records: [prefixed] })
  assert.equal(sessions.length, 1, `sessions=${JSON.stringify(sessions.map((s) => s.id))}`)
  assert.equal(sessions[0].turns.length, 1)
  assert.equal(sessions[0].turns[0].prompt, '问')
  assert.equal(sessions[0].turns[0].reply, '答')
  assert.equal(stats.orphanConversations, 1)
})

test('2.37+：client_meta.conversation_id 空串时从 receivedMessages 的 extra 兜底', () => {
  const t = task({ conversationId: 'conv-real', prompt: 'q', reply: 'a' })
  t.requestQuery.syncTask.client_meta.conversation_id = ''
  t.receivedMessages['msg-1'].extra.conversation_id = 'conv-real'
  const stats = { skippedBlocks: 0, emptyBlocks: 0 }
  const normalized = normalizeDoubaoTask('t1', t, stats)
  assert.ok(normalized, 'normalize 不应返回 null')
  assert.equal(normalized.conversationId, 'conv-real')
  const { sessions } = extractDoubaoSessions({ records: [protocolRecord([snapshot({ t1: t })])] })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'conv-real')
})

test('裸键与带前缀键并存时只取协议记录，无关键不误收', () => {
  const proto = protocolRecord([snapshot({ t1: task({ conversationId: 'conv-9', prompt: 'q', reply: 'a' }) })])
  const decoy = { ...proto, key: 'some-other:default-chat-im-protocol-store', value: { state: { mainTaskDataMap: {} }, version: 1 } }
  const { sessions } = extractDoubaoSessions({ records: [proto, decoy] })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].turns.length, 1)
})
