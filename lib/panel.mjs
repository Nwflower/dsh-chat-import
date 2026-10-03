// lib/panel.mjs — 被动会话发现 + 面板批量导入（Browser 侧面板数据源）
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
import { loadImports, archivedSessionIds, listPersistedIds, beginRegistryBatch, endRegistryBatch } from './imports.mjs'
import { resolveImportBudget } from './budget.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'
import { IMPORT_SPECS } from './toolkit.mjs'
import { withHostFormatVersion, hostSessionFormatVersion, importTranscript, importDirectory } from './import-core.mjs'
import { describeImportPrefs, readImportPrefs, updateImportPrefs, INJECT_MODES } from './import-prefs.mjs'
import { listImportHistory, purgeAllImports, purgeBySourcePath, deleteImportedSession, cleanupOrphanWorkspaces } from './purge.mjs'
import { isTransferTarget, transferDiscoveryItem } from './transfer.mjs'

// 客户端来源 id（claude-code 等）→ discovery format 短名（权威清单见 discovery 的 FORMATS）。
const SOURCE_FORMAT = {
  'claude-code': 'claude',
  codex: 'codex',
  chatgpt: 'chatgpt',
  cursor: 'cursor',
  gemini: 'gemini',
  antigravity: 'antigravity',
  reasonix: 'reasonix',
  opencode: 'opencode',
  mimocode: 'mimocode',
  teleagent: 'teleagent',
  kilocode: 'kilocode',
  zcode: 'zcode',
  grokbuild: 'grokbuild',
  openclaw: 'openclaw',
  pi: 'pi',
  hermes: 'hermes',
  kimi: 'kimi',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
  qwen: 'qwen',
  trae: 'trae',
  continue: 'continue',
  cline: 'cline',
  goose: 'goose',
  zed: 'zed',
  crush: 'crush',
  dsh: 'dsh',
  // DSH 按日志代次拆两项（与 discovery 的 FORMATS 一致）：漏掉 dsh4 会让面板请求
  // 「未知来源: dsh4」→ 列表空、默认目标也拿不到 dshVersion
  dsh4: 'dsh4',
}

// 单条发现条目导入：stat → 目录（dirSingle 判定单会话）/ 文件（alwaysBatch /
// fileBatch 判定批量）→ 对应导入函数；预算按工具同款解析链（路由层已解析一次）。
// opencode / zcode 支持 sessionIds 过滤（DB 多会话只导所选）；其余格式整源导入。
// 导出供 lib/command.mjs（/import 命令）复用同一套编排。
export async function importDiscoveryItem(ctx, format, sourcePath, sessionIds, { force, replace, budget, budgetSource, storeImages }) {
  const spec = IMPORT_SPECS.get(format)
  if (!spec) throw new Error('未知格式: ' + format)
  // 分组 spec：derive/io/registry 子对象；缺省回退标准状态机（与工具层一致）
  const deriveArgs = (spec.derive && spec.derive.args) || (async () => ({}))
  const io = spec.io || {}
  const reg = spec.registry || {}
  // readText 必须与工具层同口径透传：DSH 源（spec.readText = readDshText）落盘是
  // session.vN.jsonl.zstd，fs.readText 不解压——漏传会让面板/命令导入把 zstd 当二进制
  // 读，转换出 0 轮后按 skipped 收场（「导入并归档」于是只剩归档）。
  const importSingle = io.file
    || ((c, t, a) => importTranscript(c, t, a, spec.convert, { registryDir: reg.dir, fingerprintKeys: reg.fingerprintKeys || [], readText: spec.readText, sourceLabel: spec.sourceLabel, importFormat: spec.format }))
  const importBatch = io.dir
    || ((c, d, a) => importDirectory(c, d, a, { convert: spec.convert, sourceLabel: spec.sourceLabel, importFormat: spec.format, deriveArgs, collect: spec.derive && spec.derive.collect, registryDir: reg.dir, fingerprintKeys: reg.fingerprintKeys || [], readText: spec.readText }))
  // importSystemPrompt 取设置分区开关（readImportPrefs 缺服务时回退默认 true）：
  // 面板导入与工具层同源遵循同一偏好，不再只对 import_chat 生效。
  const args = { path: sourcePath, force: force === true, replace: replace === true, budget, budgetSource, importSystemPrompt: readImportPrefs(ctx).importSystemPrompt }
  // storeImages 由调用方显式给出（转投对导不出图片的目标传 false，见 lib/transfer.mjs）；
  // 缺省 undefined → 走 import-core 的默认（落图片，除非环境变量关闭）
  if (storeImages !== undefined) args.storeImages = storeImages
  if (Array.isArray(sessionIds) && sessionIds.length > 0 && (format === 'opencode' || format === 'mimocode' || format === 'teleagent' || format === 'zcode')) {
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
// 归组字段（workspace / workspaceCreated / ungrouped[Reason]）一并透传：未归组的会话
// 仍在，只是落在侧栏「未分组」——不在摘要里报出来，用户就只会觉得「没导入」。
function summarizeImport(out) {
  const res = { mode: out.mode === 'batch' ? 'batch' : 'single' }
  if (out.mode === 'batch') {
    for (const k of ['total', 'imported', 'alreadyImported', 'appended', 'reimported', 'skipped', 'failed', 'images', 'imagesDegraded', 'ungrouped']) {
      if (typeof out[k] === 'number') res[k] = out[k]
    }
  } else {
    res.status = out.status || 'unknown'
    if (typeof out.sessionId === 'string') res.sessionId = out.sessionId
    if (typeof out.turns === 'number') res.turns = out.turns
    if (typeof out.messages === 'number') res.messages = out.messages
    // 图片：落成附件（images）与降级占位（imagesDegraded）分开报，面板据此提示
    if (typeof out.images === 'number' && out.images > 0) res.images = out.images
    if (typeof out.imagesDegraded === 'number' && out.imagesDegraded > 0) res.imagesDegraded = out.imagesDegraded
    if (out.alreadyImported === true) res.alreadyImported = true
    if (out.sourceShrunk === true) res.sourceShrunk = true
    if (out.storedShrunk === true) res.storedShrunk = true
    // 重导另铸副本：面板据此提示「已建新会话，原会话保留」
    if (out.reimported && typeof out.reimported === 'object') res.reimported = out.reimported
    if (typeof out.skipReason === 'string') res.skipReason = out.skipReason
  }
  if (typeof out.workspace === 'string' && out.workspace) res.workspace = out.workspace
  if (out.workspaceCreated === true) res.workspaceCreated = true
  if (typeof out.ungrouped === 'number' && out.ungrouped > 0) res.ungrouped = out.ungrouped
  if (typeof out.ungroupedReason === 'string' && out.ungroupedReason) res.ungroupedReason = out.ungroupedReason
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
// 单响应交付上限：超大库逐块灌入。值需同时满足「块内同步解析/渲染开销小到不冻
// 浏览器主线程（~10ms 级）」与「排干总时长可接受」——500 条 ≈ 150KB JSON，
// 单块解析数毫秒；块间由客户端显式让出宏任务绘制（见 client.js 轮询循环）。
const STREAM_CHUNK = 500
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
  // 被动发现路由：POST /api-import/sessions（Browser 面板数据源，不新增工具）。
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
            const persistedIds = await listPersistedIds(ctx)
            s = startScan(key, (onEntry) => discoverSessions({
              path, format, query,
              host: makeDiscoveryHost(ctx),
              imports: registry.imports,
              cacheDir: registryDir,
              archivedIds: archivedSessionIds(ctx),
              persistedIds,
              onEntry,
            }))
          }
          const sessions = []
          // 分块交付：最多返回 STREAM_CHUNK 条；cursor 推进到实际交付的最后一条
          // seq（客户端从这继续轮询补齐），done 仅当扫描完成且全部条目已交付。
          let cursor = after
          for (const it of s.items) {
            if (sessions.length >= STREAM_CHUNK) break
            if (it.seq > after) {
              sessions.push(it.entry)
              cursor = it.seq
            }
          }
          const drained = cursor >= s.seq
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: true, sessions, cursor, done: s.done && drained, dshVersion: await hostSessionFormatVersion(ctx),
            total: s.done ? s.items.length : null,
            ...(s.error ? { error: s.error } : {}),
          }))
          return
        }
        // 旧契约：一次请求全量扫描 + offset/limit 分页（面板已切流式，兼容保留）
        const offset = Number.isFinite(body.offset) ? Math.max(0, Math.trunc(body.offset)) : 0
        const limit = Number.isFinite(body.limit) && body.limit > 0 ? Math.trunc(body.limit) : undefined
        const registry = await loadImports(registryDir)
        const persistedIds = await listPersistedIds(ctx)
        const found = await discoverSessions({
          path, format, query,
          host: makeDiscoveryHost(ctx),
          imports: registry.imports,
          cacheDir: registryDir,
          archivedIds: archivedSessionIds(ctx),
          persistedIds,
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
  // Stage 2 导入路由：POST /api-import/import（面板「导入 / 多选导入」）。
  // body: { items: [{ source, sourcePath, sessionId?, cwd? }], force?, target? }——items 来自
  // /api-import/sessions 的发现条目；按 sourcePath 去重聚合（同一文件/库只导一次，
  // opencode/zcode 聚合所选 sessionIds 只导所选会话）；预算按工具同款解析链
  // resolveImportBudget 一次（批内共享，registry 记录同口径，预算变化 → budgetChanged
  // 跳过语义与 import_* 工具一致）。逐条错误不拖垮整批：条目级 {status:'failed',
  // error}。返回 { ok: true, results: [{ sourcePath, format, mode, ...摘要 }] }。
  // target（面板「导入到」下拉）：缺省 / 'dsh' = 照常建可继续的 DSH 会话；其余值
  //（claude / codex / kimi / opencode）= 转投——转换成该工具自己的格式落盘，不建
  //（也不留下）DSH 会话，见 lib/transfer.mjs。
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
        const target = typeof body.target === 'string' && body.target ? body.target : 'dsh'
        // dsh / dsh3 / dsh4 = 建 DSH 会话（dsh3/dsh4 显式指定会话日志代次；dsh = 宿主当前版本）；
        // 其余必须是转投目标（claude / codex / kimi / opencode）
        const dshVersion = target === 'dsh3' ? 3 : target === 'dsh4' ? 4 : undefined
        if (target !== 'dsh' && dshVersion === undefined && !isTransferTarget(target)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '未知导入目标: ' + target }))
          return
        }
        const budgetInfo = await resolveImportBudget(ctx, body)
        const byPath = new Map()
        let transferCwd = ''
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
          if (!transferCwd && typeof item.cwd === 'string' && item.cwd) transferCwd = item.cwd
          let group = byPath.get(sourcePath)
          if (!group) {
            group = { format, sourcePath, sessionIds: [] }
            byPath.set(sourcePath, group)
          }
          if ((format === 'opencode' || format === 'mimocode' || format === 'teleagent' || format === 'zcode') && typeof item.sessionId === 'string' && item.sessionId) {
            group.sessionIds.push(item.sessionId)
          }
        }
        const results = []
        // 批处理通道：多选 N 组的 registry 记录合并为批末一次提交（此前每组一次
        // 读-改-写 + fsync）。finally 保证中途失败也提交已落盘部分的记录。
        beginRegistryBatch(registryDir)
        try {
          for (const group of byPath.values()) {
            try {
              if (target !== 'dsh' && dshVersion === undefined) {
                const out = await transferDiscoveryItem(ctx, { ...group, target, cwd: transferCwd }, {
                  registryDir,
                  importItem: importDiscoveryItem,
                  force: body.force === true,
                  replace: body.replace === true,
                  budget: budgetInfo.budget,
                  budgetSource: budgetInfo.source,
                })
                results.push({
                  sourcePath: group.sourcePath, format: group.format, target,
                  mode: out.mode, status: out.status,
                  transferred: out.transferred, purged: out.purged, kept: out.kept, failed: out.failed,
                  ...(out.hint ? { hint: out.hint } : {}),
                  files: out.files,
                })
                continue
              }
              const runImport = () => importDiscoveryItem(ctx, group.format, group.sourcePath, group.sessionIds, {
                force: body.force === true,
                replace: body.replace === true,
                budget: budgetInfo.budget,
                budgetSource: budgetInfo.source,
              })
              // dsh3 / dsh4：显式代次——header.version 与事件形状都按它产出（宿主 create(header)
              // 认 header.version，所以能真写出一条 V3 generation）。dsh 不覆盖，跟宿主当前版本。
              const out = dshVersion === undefined ? await runImport() : await withHostFormatVersion(ctx, dshVersion, runImport)
              results.push({ sourcePath: group.sourcePath, format: group.format, ...summarizeImport(out) })
            } catch (err) {
              results.push({ sourcePath: group.sourcePath, format: group.format, status: 'failed', error: String((err && err.message) || err) })
            }
          }
        } finally {
          await endRegistryBatch()
        }
        // 归档旧会话（面板「导入所选并归档旧会话」）：显式选了 DSH 来源 + 另一代次的 DSH
        // 目标时，导入完成后把**源会话**在宿主里归档。插件只消费公开服务，所以按能力探测：
        // workspaceRegistry 暴露 archiveSession/archive 才调用，否则如实回报 archiveUnsupported
        //（不假装归档成功——导入本身已经完成）。
        // 归档是不可逆的隐藏动作（平台无取消归档面）：只有**导入确实成功**的条目才归档——
        // 跳过 / 失败的条目也归档会让用户两头落空（旧会话被藏起来、新会话没建出来）。
        // 未归档条数经 archiveSkipped 如实上报（失败要大声）。
        let archived
        let archiveUnsupported = false
        let archiveSkipped = 0
        if (body.archiveSources === true) {
          const wr = ctx.get('workspaceRegistry')
          const archiveFn = wr && (typeof wr.archiveSession === 'function' ? (id) => wr.archiveSession(id)
            : typeof wr.archive === 'function' ? (id) => wr.archive(id) : null)
          if (!archiveFn) archiveUnsupported = true
          else {
            archived = 0
            // 成功口径 = 目标会话确实存在（新建 / 替换 / 续写 / 已存在）；批量条目按
            // 新增 + 续写 + 已存在计数（三者皆为 0 表示整批没落下一个会话）。
            const okPaths = new Set()
            for (const r of results) {
              if (!r || typeof r.sourcePath !== 'string') continue
              const ok = r.mode === 'batch'
                ? (r.imported || 0) + (r.appended || 0) + (r.alreadyImported || 0) > 0
                : (r.status === 'imported' || r.status === 'replaced' || r.status === 'appended' || r.status === 'already-imported')
              if (ok) okPaths.add(r.sourcePath)
            }
            const seen = new Set()
            for (const item of items) {
              const source = typeof item?.source === 'string' ? item.source : ''
              const id = typeof item?.sessionId === 'string' ? item.sessionId : ''
              if (!id || seen.has(id) || !(source === 'dsh' || source === 'dsh4')) continue
              seen.add(id)
              const sourcePath = typeof item?.sourcePath === 'string' ? item.sourcePath : ''
              if (!okPaths.has(sourcePath)) { archiveSkipped++; continue }
              try { await archiveFn(id); archived++ } catch (err) {
                console.warn('[dsh-chat-import] 归档源会话失败（' + id + '）：' + String((err && err.message) || err))
                archiveSkipped++
              }
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true, target, results,
          ...(typeof archived === 'number' ? { archived } : {}),
          ...(archiveSkipped > 0 ? { archiveSkipped } : {}),
          ...(archiveUnsupported ? { archiveUnsupported: true } : {}),
        }))
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
  // settingsGet / settingsUpdate 模式。body 无写入键（importSystemPrompt / injectTools
  // 均非 boolean）→ 读 { value, revision, available }；body 含任一写入键 → 写
  // （expectedRevision 冲突保护，冲突返回 code: 'settings-conflict' 由客户端重读）。
  // settings 服务缺席时读返回默认、写原样返回（不持久化），available:false 供客户端降级。
  // 导入历史：读 imports registry 展平为可浏览列表（sourcePath / sessionId / 计数 / 时间）。
  ws.register({
    kind: 'exact',
    path: '/api-import/history',
    handler: async (_req, res) => {
      try {
        const out = await listImportHistory(ctx, registryDir)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...out }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
  // 撤回导入：删除本插件创建的会话工件 + 解挂工作区 + 清 registry（需 confirm:true）。
  // body: { confirm, all?: true } | { confirm, sourcePath } | { confirm, sessionId }
  ws.register({
    kind: 'exact',
    path: '/api-import/purge',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (body.confirm !== true) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '批量删除需要 confirm:true' }))
          return
        }
        let result
        if (body.all === true) {
          result = await purgeAllImports(ctx, registryDir, { confirm: true })
        } else if (typeof body.sourcePath === 'string' && body.sourcePath) {
          result = await purgeBySourcePath(ctx, registryDir, body.sourcePath, { confirm: true })
        } else if (typeof body.sessionId === 'string' && body.sessionId) {
          result = await deleteImportedSession(ctx, registryDir, body.sessionId)
        } else {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: '需要 all / sourcePath / sessionId 之一' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
  // 维护路由：清理本插件创建且成员为 0 的工作区登记（专用导入工作区 + 旧实现为源
  // transcript 目录误建的空工作区）。只删工作区登记，目录与会话日志保留；幂等。
  ws.register({
    kind: 'exact',
    path: '/api-import/workspaces/cleanup',
    handler: async (_req, res) => {
      try {
        const removed = await cleanupOrphanWorkspaces(ctx)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, count: removed.length, removed }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
  ws.register({
    kind: 'exact',
    path: '/api-import/prefs',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        // 任一写入键命中即视为写请求；无写入键 → 读当前值。injectTools 接受三档
        // 字符串（off/minimal/full）与历史 boolean（读侧 normalizeInjectTools 归一）。
        const patch = {}
        if (typeof body.importSystemPrompt === 'boolean') patch.importSystemPrompt = body.importSystemPrompt
        if (typeof body.injectTools === 'boolean' || INJECT_MODES.includes(body.injectTools)) patch.injectTools = body.injectTools
        if (typeof body.sidebarButton === 'boolean') patch.sidebarButton = body.sidebarButton
        if (Object.keys(patch).length === 0) {
          const view = describeImportPrefs(ctx)
          res.writeHead(200, { 'content-type': 'application/json' })
          // probe 是只读自检：宿主设置服务的关键事实（0.1.5 / 0.1.7 模型差异排障用），
          // 出问题时看这一个响应就能定位（见 docs/SETTINGS-MIGRATION.md）。
          res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, available: view.available, probe: view.probe }))
          return
        }
        const expected = typeof body.revision === 'number' ? body.revision : undefined
        let view
        try {
          view = await updateImportPrefs(ctx, patch, expected)
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
        res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, available: view.available, probe: view.probe }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  })
}
