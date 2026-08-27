// lib/panel.mjs — REQ-41 被动会话发现 + 面板批量导入（Browser 侧面板数据源）
//
// lib/client.js 的侧边栏面板按「来源」下拉请求 POST /api-import/sessions；与
// scan_discover 共用同一套 discovery（lib/discovery.mjs discoverSessions +
// makeDiscoveryHost + imports registry 标注 + 30s TTL / 持久化书签），只读零副作用。
// Stage 2：source 省略（空串）时扫全部格式，供面板按工作区文件夹分组浏览。
// Stage 3：搜索 + 分页（offset/limit + total）。
// Stage 4：流式加载（后台扫描 + after 游标增量拉取）——会话按发现顺序逐条插入
// 列表，首屏不被全量扫描阻塞；刷新 / 导入后客户端 epoch 自增强制新扫描键。
//
// POST /api-import/import（面板「导入 / 多选导入」）按发现条目（source / sourcePath /
// sessionId）复用工具层同一套导入编排（幂等 / 增量 / force / 预算），不新增工具。
// IMPORT_SPECS（lib/toolkit.mjs）由 makeImportChatTool 在 apply 注册 import_chat
// 分发器时登记（带 format 的 spec），保证面板导入与会话内工具行为完全一致（同一
// 注册对象，同一转换/落盘/归组状态机）。
//
// 路由注册经 ctx.inject(['webServer']) 延迟挂载（webServer 可选且晚挂载），headless
// / CI 冒烟（无 webServer）时回调永不执行，导入工具照常可用。registerPanelRoutes
// 的 ctx 是 apply 的外层 ctx（路由 handler 闭包用它访问 fs / 预算链服务）。

import { discoverSessions } from './discovery.mjs'
import { loadImports, archivedSessionIds } from './imports.mjs'
import { resolveImportBudget } from './budget.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'
import { IMPORT_SPECS } from './toolkit.mjs'
import { importTranscript, importDirectory } from './import-core.mjs'
import { describeImportPrefs, updateImportPrefs } from './import-prefs.mjs'

// 客户端来源 id（claude-code 等 18 个）→ discovery format 短名（FORMATS）。
const SOURCE_FORMAT = {
  'claude-code': 'claude',
  codex: 'codex',
  chatgpt: 'chatgpt',
  cursor: 'cursor',
  gemini: 'gemini',
  reasonix: 'reasonix',
  opencode: 'opencode',
  mimocode: 'mimocode',
  zcode: 'zcode',
  grokbuild: 'grokbuild',
  openclaw: 'openclaw',
  pi: 'pi',
  hermes: 'hermes',
  kimi: 'kimi',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
  dsh: 'dsh',
}

// 单条发现条目导入：stat → 目录（dirSingle 判定单会话）/ 文件（alwaysBatch /
// fileBatch 判定批量）→ 对应导入函数；预算按工具同款解析链（路由层已解析一次）。
// opencode / zcode 支持 sessionIds 过滤（DB 多会话只导所选）；其余格式整源导入。
// 导出供 lib/command.mjs（REQ-42 /import 命令）复用同一套编排。
export async function importDiscoveryItem(ctx, format, sourcePath, sessionIds, { force, budget, budgetSource }) {
  const spec = IMPORT_SPECS.get(format)
  if (!spec) throw new Error('未知格式: ' + format)
  // REQ-09 分组 spec：derive/io/registry 子对象；缺省回退标准状态机（与工具层一致）
  const deriveArgs = (spec.derive && spec.derive.args) || (async () => ({}))
  const io = spec.io || {}
  const reg = spec.registry || {}
  const importSingle = io.file
    || ((c, t, a) => importTranscript(c, t, a, spec.convert, { registryDir: reg.dir, fingerprintKeys: reg.fingerprintKeys || [] }))
  const importBatch = io.dir
    || ((c, d, a) => importDirectory(c, d, a, { convert: spec.convert, sourceLabel: spec.sourceLabel, deriveArgs, collect: spec.derive && spec.derive.collect, registryDir: reg.dir, fingerprintKeys: reg.fingerprintKeys || [] }))
  const args = { path: sourcePath, force: force === true, budget, budgetSource }
  if (Array.isArray(sessionIds) && sessionIds.length > 0 && (format === 'opencode' || format === 'mimocode' || format === 'zcode')) {
    args.sessionIds = [...new Set(sessionIds)]
  }
  const target = await ctx.fs.resolve(sourcePath)
  const info = await ctx.fs.stat(target)
  const fileArgs = { ...args, ...(await deriveArgs(target)) }
  if (info && info.type === 'directory') {
    if (io.dirSingle && await io.dirSingle(ctx, target)) {
      return { mode: 'single', ...(await importSingle(ctx, target, fileArgs)) }
    }
    return { mode: 'batch', ...(await importBatch(ctx, target, args)) }
  }
  if (io.alwaysBatch || (io.fileBatch && await io.fileBatch(ctx, target))) {
    return { mode: 'batch', ...(await importSingle(ctx, target, fileArgs)) }
  }
  return { mode: 'single', ...(await importSingle(ctx, target, fileArgs)) }
}

// 把工具层导入结果压成面板摘要：single 透传 status/sessionId，batch 透传计数。
function summarizeImport(out) {
  const res = { mode: out.mode === 'batch' ? 'batch' : 'single' }
  if (out.mode === 'batch') {
    for (const k of ['total', 'imported', 'alreadyImported', 'appended', 'skipped', 'failed']) {
      if (typeof out[k] === 'number') res[k] = out[k]
    }
  } else {
    res.status = out.status || 'unknown'
    if (typeof out.sessionId === 'string') res.sessionId = out.sessionId
    if (typeof out.turns === 'number') res.turns = out.turns
    if (typeof out.messages === 'number') res.messages = out.messages
    if (out.alreadyImported === true) res.alreadyImported = true
    if (out.sourceShrunk === true) res.sourceShrunk = true
    if (typeof out.skipReason === 'string') res.skipReason = out.skipReason
  }
  if (typeof out.error === 'string') res.error = out.error
  return res
}

// 读请求 body 的 JSON（空 body 按 {}；畸形 JSON 抛错由路由 catch 兜底）。
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(String(chunk))
  return JSON.parse(chunks.join('') || '{}')
}

// ── 后台扫描管理器（面板流式增量拉取）───────────────────────────────────
// 键 = 来源|关键词|路径|epoch：首个请求创建并启动后台扫描，onEntry 逐条追加到
// items 缓冲（seq 递增，与发现产出顺序一致）；每次请求按 after(seq) 返回增量 +
// done 标记。扫描结束（含出错）置 done / error；完成后长时间无新请求被惰性回收
//（内存有界，扫描本身仍受 discovery 的 30s TTL / 持久化书签约束）。
const SCAN_IDLE_MS = 5 * 60_000
const scanState = new Map()

function startScan(key, run) {
  let s = scanState.get(key)
  if (!s) {
    s = { seq: 0, items: [], done: false, error: null, lastActive: Date.now() }
    scanState.set(key, s)
    s.promise = (async () => {
      try {
        await run((entry) => {
          s.items.push({ seq: ++s.seq, entry })
          s.lastActive = Date.now()
        })
      } catch (err) {
        s.error = String((err && err.message) || err)
      } finally {
        s.done = true
      }
    })()
  }
  return s
}

export function registerPanelRoutes(ctx, ws, registryDir) {
  // REQ-41 被动发现路由：POST /api-import/sessions（Browser 面板数据源，不新增工具）。
  // body: { source?, query?, path?, epoch?, after? }——source 是客户端来源 id
  // （SOURCE_FORMAT 映射到 discovery format；省略/空串 = 扫全部格式，面板「全部来源」
  // 视图按工作区分组）；query 按标题/项目/路径过滤；path 可选（客户端不发，调用方可
  // 钉扫描根，缺省扫该格式默认数据根）。两种模式：
  //   * 流式（body 带 after）：后台扫描按「来源|关键词|路径|epoch」键启动（epoch 由
  //     客户端每次刷新 / 导入后自增 → 新扫描键强制重扫），onEntry 逐条追加到缓冲；
  //     每次请求返回 after(seq) 之后的增量 { sessions, cursor, done, total }——done
  //     前客户端按 cursor 轮询、会话逐条插入列表，首屏不被全量扫描阻塞。
  //   * 旧契约（无 after，offset/limit 分页）：全量扫描后切片返回 { sessions, total,
  //     offset, limit }——面板已切流式，保留兼容既有调用方。
  // 错误返回 {ok:false, error}。ws 由 ctx.inject 保证已挂载（web 环境）。
  ws.register({
    kind: 'exact',
    path: '/api-import/sessions',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const source = typeof body.source === 'string' && body.source ? body.source : ''
        const format = source ? SOURCE_FORMAT[source] : undefined
        if (source && !format) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '未知来源: ' + source }))
          return
        }
        const query = typeof body.query === 'string' ? body.query : ''
        const path = typeof body.path === 'string' && body.path ? body.path : undefined
        if (Number.isFinite(body.after)) {
          // 流式：后台扫描 + 增量拉取（see 上方 Stage 4 注释）
          const epoch = Number.isFinite(body.epoch) ? Math.trunc(body.epoch) : 0
          const after = Math.max(0, Math.trunc(body.after))
          // 惰性回收：扫描完成且长时间无新请求的键移除（内存有界）
          const now = Date.now()
          for (const [k, s] of scanState) {
            if (s.done && now - s.lastActive > SCAN_IDLE_MS) scanState.delete(k)
          }
          const key = source + '|' + query + '|' + String(path || '') + '|' + epoch
          let s = scanState.get(key)
          if (!s) {
            // registry 只在创建扫描时读一次（epoch 变化 → 新键 → 重读最新导入状态）
            const registry = await loadImports(registryDir)
            s = startScan(key, (onEntry) => discoverSessions({
              path, format, query,
              host: makeDiscoveryHost(ctx),
              imports: registry.imports,
              cacheDir: registryDir,
              archivedIds: archivedSessionIds(ctx),
              onEntry,
            }))
          }
          const sessions = []
          for (const it of s.items) if (it.seq > after) sessions.push(it.entry)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: true, sessions, cursor: s.seq, done: s.done,
            total: s.done ? s.items.length : null,
            ...(s.error ? { error: s.error } : {}),
          }))
          return
        }
        // 旧契约：一次请求全量扫描 + offset/limit 分页（面板已切流式，兼容保留）
        const offset = Number.isFinite(body.offset) ? Math.max(0, Math.trunc(body.offset)) : 0
        const limit = Number.isFinite(body.limit) && body.limit > 0 ? Math.trunc(body.limit) : undefined
        const registry = await loadImports(registryDir)
        const found = await discoverSessions({
          path, format, query,
          host: makeDiscoveryHost(ctx),
          imports: registry.imports,
          cacheDir: registryDir,
          archivedIds: archivedSessionIds(ctx),
        })
        const all = found.sessions
        const sessions = limit === undefined ? all : all.slice(offset, offset + limit)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessions, total: found.total, offset, limit: limit ?? all.length }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
  // REQ-41 Stage 2 导入路由：POST /api-import/import（面板「导入 / 多选导入」）。
  // body: { items: [{ source, sourcePath, sessionId? }], force? }——items 来自
  // /api-import/sessions 的发现条目；按 sourcePath 去重聚合（同一文件/库只导一次，
  // opencode/zcode 聚合所选 sessionIds 只导所选会话）；预算按工具同款解析链
  // resolveImportBudget 一次（批内共享，registry 记录同口径，预算变化 → budgetChanged
  // 跳过语义与 import_* 工具一致）。逐条错误不拖垮整批：条目级 {status:'failed',
  // error}。返回 { ok: true, results: [{ sourcePath, format, mode, ...摘要 }] }。
  ws.register({
    kind: 'exact',
    path: '/api-import/import',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const items = Array.isArray(body.items) ? body.items : []
        if (items.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'items 为空：请选择要导入的会话' }))
          return
        }
        const budgetInfo = await resolveImportBudget(ctx, body)
        const byPath = new Map()
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const source = typeof item.source === 'string' && item.source ? item.source : ''
          const format = SOURCE_FORMAT[source]
          if (!format) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '未知来源: ' + source }))
            return
          }
          const sourcePath = typeof item.sourcePath === 'string' && item.sourcePath ? item.sourcePath : ''
          if (!sourcePath) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '条目缺少 sourcePath' }))
            return
          }
          let group = byPath.get(sourcePath)
          if (!group) {
            group = { format, sourcePath, sessionIds: [] }
            byPath.set(sourcePath, group)
          }
          if ((format === 'opencode' || format === 'mimocode' || format === 'zcode') && typeof item.sessionId === 'string' && item.sessionId) {
            group.sessionIds.push(item.sessionId)
          }
        }
        const results = []
        for (const group of byPath.values()) {
          try {
            const out = await importDiscoveryItem(ctx, group.format, group.sourcePath, group.sessionIds, {
              force: body.force === true,
              budget: budgetInfo.budget,
              budgetSource: budgetInfo.source,
            })
            results.push({ sourcePath: group.sourcePath, format: group.format, ...summarizeImport(out) })
          } catch (err) {
            results.push({ sourcePath: group.sourcePath, format: group.format, status: 'failed', error: String((err && err.message) || err) })
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, results }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
  // 设置偏好 fenced 路由：POST /api-import/prefs——面板设置分区客户端的读写通道。
  // 契约：DSH 配置客户端（settingsScope）只能访问 api-proxy 暴露白名单内的命名空间，
  // 插件自有 'chat-import' 不在其列；客户端经本路由（与 /api-import/* 同一信任围栏）
  // 进程内读写设置 seam（describe / update），对齐 dsh-better-sidebar 的
  // settingsGet / settingsUpdate 模式。body {} → 读 { value, revision, available }；
  // body { importSystemPrompt, revision? } → 写（expectedRevision 冲突保护，冲突返回
  // code: 'settings-conflict' 由客户端重读）。settings 服务缺席时读返回默认、
  // 写原样返回（不持久化），available:false 供客户端降级。
  ws.register({
    kind: 'exact',
    path: '/api-import/prefs',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (body.importSystemPrompt === undefined) {
          const view = describeImportPrefs(ctx)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, available: view.available }))
          return
        }
        const expected = typeof body.revision === 'number' ? body.revision : undefined
        let view
        try {
          view = await updateImportPrefs(ctx, { importSystemPrompt: body.importSystemPrompt === true }, expected)
        } catch (err) {
          // 命名空间被并发移动时 settings 服务抛 SettingsConflictError（类名 + 消息），
          // 转成友好码由客户端重读权威值
          const label = String((err && err.name ? err.name + ': ' : '') + (err && err.message) || '')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            code: /conflict/i.test(label) ? 'settings-conflict' : undefined,
            error: label,
          }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, available: view.available }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
}
