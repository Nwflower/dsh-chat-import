// lib/panel.mjs — 面板路由（浏览器侧面板的数据源与操作入口，全部 POST /api-import/*）
//
//   /sessions            被动会话发现：与 scan_discover 共用 lib/discovery.mjs（imports registry
//                        标注 + 30s TTL / 持久化书签），只读零副作用；流式（after 游标增量拉取）
//                        与旧分页（offset/limit）两种契约
//   /import              按发现条目导入（或转投到其它工具的格式），复用 import_chat 同一套分发
//                        （lib/toolkit.mjs 的 importDiscoveryItem：幂等 / 增量 / force / 预算）
//   /history /purge /workspaces/cleanup   导入历史浏览、撤回删除、空工作区清理
//   /file /upload/* /uploads              从文件导入（本机路径或上传件）与上传暂存维护
//   /prefs               设置偏好的 fenced 读写通道
//
// 路由经 ctx.inject(['webServer']) 延迟挂载（webServer 可选且晚挂载），headless / CI 冒烟
// （无 webServer）时回调永不执行，导入工具照常可用。registerPanelRoutes 的 ctx 是 apply 的
// 外层 ctx（handler 闭包用它访问 fs / 预算链服务）。所有路由同一 JSON 出口：handler 返回
// [状态码, 载荷]，抛错统一 500 + { ok: false, error }。

import { discoverSessions, FORMATS } from './discovery.mjs'
import { loadImports, archivedSessionIds, listPersistedIds, beginRegistryBatch, endRegistryBatch } from './imports.mjs'
import { resolveImportBudget } from './budget.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'
import { IMPORT_SPECS, importDiscoveryItem } from './toolkit.mjs'
import { withHostFormatVersion, hostSessionFormatVersion } from './import-core.mjs'
import { describeImportPrefs, readImportPrefs, updateImportPrefs, INJECT_MODES } from './import-prefs.mjs'
import { listImportHistory, purgeAllImports, purgeBySourcePath, deleteImportedSession, cleanupOrphanWorkspaces } from './purge.mjs'
import { isTransferTarget, transferDiscoveryItem } from './transfer.mjs'
import { previewFileTarget, importFileTarget } from './file-import.mjs'
import {
  uploadInit, uploadChunk, uploadComplete, uploadResolvedPath, uploadsStats, cleanupStaging, gcUploads,
} from './upload.mjs'

// 客户端来源 id → discovery format：与 discovery 的 FORMATS 一一对应（由它派生，新来源自动
// 可用），只有 claude 在面板里叫 claude-code。
const SOURCE_FORMAT = Object.fromEntries(FORMATS.map((f) => [f === 'claude' ? 'claude-code' : f, f]))

const JSON_HEADERS = { 'content-type': 'application/json' }

const errorText = (err) => String((err && err.message) || err)

// 一条 JSON 路由：handle(req) 返回 [状态码, 载荷]；抛错（含畸形 body）统一 500。
function jsonRoute(path, handle) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let status
      let payload
      try {
        [status, payload] = await handle(req)
      } catch (err) {
        status = 500
        payload = { ok: false, error: errorText(err) }
      }
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    },
  }
}

const badRequest = (error) => [400, { ok: false, error }]
// 执行体自带 ok 字段（上传 / 文件导入）：ok:false 映射 400
const byOk = (out) => [out.ok === false ? 400 : 200, out]

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
  // 被动发现：POST /api-import/sessions。
  // body: { source?, query?, path?, epoch?, after? }——source 是客户端来源 id（SOURCE_FORMAT
  // 映射到 discovery format；省略/空串 = 扫全部格式，面板「全部来源」视图按工作区分组）；
  // query 按标题/项目/路径过滤；path 可选（钉扫描根，缺省扫该格式默认数据根）。两种契约：
  //   * 流式（body 带 after）：后台扫描按「来源|关键词|路径|epoch」键启动（epoch 由客户端每次
  //     刷新 / 导入后自增 → 新扫描键强制重扫），onEntry 逐条追加到缓冲；每次请求返回 after(seq)
  //     之后的增量 { sessions, cursor, done, total }——done 前客户端按 cursor 轮询。
  //   * 分页（无 after）：全量扫描后切片返回 { sessions, total, offset, limit }。
  ws.register(jsonRoute('/api-import/sessions', async (req) => {
    const body = await readBody(req)
    const source = typeof body.source === 'string' && body.source ? body.source : ''
    const format = source ? SOURCE_FORMAT[source] : undefined
    if (source && !format) return badRequest('未知来源: ' + source)
    const query = typeof body.query === 'string' ? body.query : ''
    const path = typeof body.path === 'string' && body.path ? body.path : undefined
    const discoverOptions = async () => ({
      path, format, query,
      host: makeDiscoveryHost(ctx),
      imports: (await loadImports(registryDir)).imports,
      cacheDir: registryDir,
      archivedIds: archivedSessionIds(ctx),
      persistedIds: await listPersistedIds(ctx),
    })
    if (Number.isFinite(body.after)) {
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
        const options = await discoverOptions()
        s = startScan(key, (onEntry) => discoverSessions({ ...options, onEntry }))
      }
      // 分块交付：最多返回 STREAM_CHUNK 条；cursor 推进到实际交付的最后一条 seq（客户端
      // 从这继续轮询补齐），done 仅当扫描完成且全部条目已交付。
      const sessions = []
      let cursor = after
      for (const it of s.items) {
        if (sessions.length >= STREAM_CHUNK) break
        if (it.seq > after) {
          sessions.push(it.entry)
          cursor = it.seq
        }
      }
      const drained = cursor >= s.seq
      return [200, {
        ok: true, sessions, cursor, done: s.done && drained, dshVersion: await hostSessionFormatVersion(ctx),
        total: s.done ? s.items.length : null,
        ...(s.error ? { error: s.error } : {}),
      }]
    }
    const offset = Number.isFinite(body.offset) ? Math.max(0, Math.trunc(body.offset)) : 0
    const limit = Number.isFinite(body.limit) && body.limit > 0 ? Math.trunc(body.limit) : undefined
    const found = await discoverSessions(await discoverOptions())
    const all = found.sessions
    const sessions = limit === undefined ? all : all.slice(offset, offset + limit)
    return [200, { ok: true, sessions, total: found.total, offset, limit: limit ?? all.length }]
  }))

  // 按发现条目导入：POST /api-import/import。
  // body: { items: [{ source, sourcePath, sessionId?, cwd? }], force?, replace?, target?,
  // archiveSources? }——items 来自 /api-import/sessions；按 sourcePath 去重聚合（同一文件/库
  // 只导一次，一库多会话来源聚合所选 sessionIds 只导所选会话）；预算按工具同款解析链解析
  // 一次（批内共享）。逐条错误不拖垮整批：条目级 { status: 'failed', error }。
  // target（面板「导入到」）：缺省 / 'dsh' = 建 DSH 会话（宿主当前日志代次）；'dsh3' / 'dsh4'
  // = 显式代次；其余（claude / codex / kimi / opencode）= 转投到该工具的格式，不留 DSH 会话
  //（见 lib/transfer.mjs）。
  ws.register(jsonRoute('/api-import/import', async (req) => {
    const body = await readBody(req)
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) return badRequest('items 为空：请选择要导入的会话')
    const target = typeof body.target === 'string' && body.target ? body.target : 'dsh'
    const dshVersion = target === 'dsh3' ? 3 : target === 'dsh4' ? 4 : undefined
    const transfer = target !== 'dsh' && dshVersion === undefined
    if (transfer && !isTransferTarget(target)) return badRequest('未知导入目标: ' + target)
    const budgetInfo = await resolveImportBudget(ctx, body)
    const byPath = new Map()
    let transferCwd = ''
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const source = typeof item.source === 'string' && item.source ? item.source : ''
      const format = SOURCE_FORMAT[source]
      if (!format) return badRequest('未知来源: ' + source)
      const sourcePath = typeof item.sourcePath === 'string' && item.sourcePath ? item.sourcePath : ''
      if (!sourcePath) return badRequest('条目缺少 sourcePath')
      if (!transferCwd && typeof item.cwd === 'string' && item.cwd) transferCwd = item.cwd
      let group = byPath.get(sourcePath)
      if (!group) {
        group = { format, sourcePath, sessionIds: [] }
        byPath.set(sourcePath, group)
      }
      if (IMPORT_SPECS.get(format)?.multiSession && typeof item.sessionId === 'string' && item.sessionId) {
        group.sessionIds.push(item.sessionId)
      }
    }
    const importOptions = {
      force: body.force === true,
      replace: body.replace === true,
      budget: budgetInfo.budget,
      budgetSource: budgetInfo.source,
    }
    const results = []
    // 批处理通道：多选 N 组的 registry 记录合并为批末一次提交；finally 保证中途失败也
    // 提交已落盘部分的记录。
    beginRegistryBatch(registryDir)
    try {
      for (const group of byPath.values()) {
        try {
          if (transfer) {
            const out = await transferDiscoveryItem(ctx, { ...group, target, cwd: transferCwd }, {
              registryDir, importItem: importDiscoveryItem, ...importOptions,
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
          const runImport = () => importDiscoveryItem(ctx, group.format, group.sourcePath, group.sessionIds, importOptions)
          // dsh3 / dsh4：header.version 与事件形状都按显式代次产出（宿主 create(header) 认
          // header.version）；dsh 跟宿主当前版本。
          const out = dshVersion === undefined ? await runImport() : await withHostFormatVersion(ctx, dshVersion, runImport)
          results.push({ sourcePath: group.sourcePath, format: group.format, ...summarizeImport(out) })
        } catch (err) {
          results.push({ sourcePath: group.sourcePath, format: group.format, status: 'failed', error: errorText(err) })
        }
      }
    } finally {
      await endRegistryBatch()
    }
    const archive = body.archiveSources === true ? await archiveImportedSources(ctx, items, results) : {}
    return [200, { ok: true, target, results, ...archive }]
  }))

  // 导入历史：读 imports registry 展平为可浏览列表（sourcePath / sessionId / 计数 / 时间）。
  ws.register(jsonRoute('/api-import/history', async () => {
    return [200, { ok: true, ...(await listImportHistory(ctx, registryDir)) }]
  }))

  // 撤回导入：删除本插件创建的会话工件 + 解挂工作区 + 清 registry（需 confirm:true）。
  // body: { confirm, all?: true } | { confirm, sourcePath } | { confirm, sessionId }
  ws.register(jsonRoute('/api-import/purge', async (req) => {
    const body = await readBody(req)
    if (body.confirm !== true) return badRequest('批量删除需要 confirm:true')
    let result
    if (body.all === true) {
      result = await purgeAllImports(ctx, registryDir, { confirm: true })
    } else if (typeof body.sourcePath === 'string' && body.sourcePath) {
      result = await purgeBySourcePath(ctx, registryDir, body.sourcePath, { confirm: true })
    } else if (typeof body.sessionId === 'string' && body.sessionId) {
      result = await deleteImportedSession(ctx, registryDir, body.sessionId)
    } else {
      return badRequest('需要 all / sourcePath / sessionId 之一')
    }
    return [200, { ok: true, result }]
  }))

  // 维护：清理本插件创建且成员为 0 的工作区登记（专用导入工作区 + 旧实现为源 transcript
  // 目录误建的空工作区）。只删工作区登记，目录与会话日志保留；幂等。
  ws.register(jsonRoute('/api-import/workspaces/cleanup', async () => {
    const removed = await cleanupOrphanWorkspaces(ctx)
    return [200, { ok: true, count: removed.length, removed }]
  }))

  // 从文件导入（面板「从文件导入」区）：POST /api-import/file。
  // body { path? | uploadId?, format?, preview?, dryRun?, force?, replace?, target?, recursive?,
  // workspaceMode?, workspaceDir?, cwdRemap?, storeImages?, restamp?, sessionId? }：
  //   * path     = 本机路径（桌面端直读：单文件 / 目录，无上传大小限制）；
  //   * uploadId = 上传暂存件（远程 / 浏览器场景，见 /api-import/upload/*）——两种给文件的方式
  //                汇入同一编排；
  //   * format   = 'auto'（默认，三级探测）或强制解析器名；
  //   * preview  = 只读预览（识别格式 + 规模 + 降级计数，零副作用）；
  //   * target   = 与发现面板同款「导入到」：dsh（默认建可继续会话）或转投目标。
  // .dshbundle 便携包由 lib/file-import.mjs 分流到 restore_bundle（事件级无损还原）。
  ws.register(jsonRoute('/api-import/file', async (req) => {
    const body = await readBody(req)
    let filePath = typeof body.path === 'string' && body.path ? body.path : ''
    if (!filePath && typeof body.uploadId === 'string' && body.uploadId) {
      const resolved = await uploadResolvedPath(registryDir, body.uploadId)
      if (!resolved) return badRequest('上传尚未完成或已过期，请重新上传')
      filePath = resolved
    }
    if (!filePath) return badRequest('需要 path（本机路径）或 uploadId（上传件）')
    const budgetInfo = await resolveImportBudget(ctx, body)
    const common = {
      path: filePath,
      format: body.format,
      budget: budgetInfo.budget,
      budgetSource: budgetInfo.source,
      importSystemPrompt: readImportPrefs(ctx).importSystemPrompt === true,
      // 目录是否下钻：面板先按「仅当前目录」预览，弹窗确认后才用 recursive:true 重扫
      //（省略 = 该格式的既有默认：目录导入递归、单文件无意义）
      recursive: body.recursive === true ? true : body.recursive === false ? false : undefined,
    }
    if (body.preview === true || body.dryRun === true) return byOk(await previewFileTarget(ctx, common))
    const target = typeof body.target === 'string' && body.target ? body.target : 'dsh'
    const importOptions = {
      ...common,
      registryDir,
      force: body.force === true,
      replace: body.replace === true,
      workspaceMode: body.workspaceMode,
      workspaceDir: body.workspaceDir,
      cwdRemap: body.cwdRemap,
      storeImages: body.storeImages,
      restamp: body.restamp,
      sessionId: body.sessionId,
    }
    if (isTransferTarget(target)) {
      // 转投：复用发现面板同一条管线（导入 → 导出到目标格式 → 撤回中间会话），importItem
      // 换成从文件导入的执行体（同一编排、同一幂等/预算语义）
      const out = await transferDiscoveryItem(ctx, { format: 'local-jsonl', sourcePath: filePath, target }, {
        registryDir,
        force: body.force === true,
        replace: body.replace === true,
        budget: budgetInfo.budget,
        budgetSource: budgetInfo.source,
        importItem: (c, _format, sourcePath, _sessionIds, opts) => importFileTarget(c, {
          ...importOptions, ...opts, path: sourcePath,
        }),
      })
      return [out.transferred > 0 || out.failed === 0 ? 200 : 400, { ok: out.transferred > 0, kind: 'transfer', ...out }]
    }
    if (target !== 'dsh') return badRequest('未知导入目标: ' + target)
    return byOk(await importFileTarget(ctx, importOptions))
  }))

  // 上传通道（远程 / 浏览器场景）：init → chunk(×N) → complete 三步；同 (sha256,size) 幂等
  //（刷新 / 断线后续传），complete 校验整文件指纹后才产出可导入路径。协议与防护见
  // lib/upload.mjs 文件头。
  ws.register(jsonRoute('/api-import/upload/init', async (req) => byOk(await uploadInit(registryDir, await readBody(req)))))
  ws.register(jsonRoute('/api-import/upload/chunk', async (req) => byOk(await uploadChunk(registryDir, await readBody(req)))))
  ws.register(jsonRoute('/api-import/upload/complete', async (req) => byOk(await uploadComplete(registryDir, await readBody(req)))))

  // 暂存用量（默认）与维护：POST /api-import/uploads。
  //   { mode: 'stats' }（默认）→ { pending, completed, bytes, limitBytes, dir }
  //   { mode: 'gc' }            → 回收未完成上传（24h 未更新）
  //   { mode: 'cleanup', confirm: true } → 删除**未被 registry 引用**的暂存件
  // 已完成件是 registry 的源键（D13 增量续写依赖源文件仍在），故默认保留、只在显式清理时删。
  ws.register(jsonRoute('/api-import/uploads', async (req) => {
    const body = await readBody(req)
    const mode = typeof body.mode === 'string' && body.mode ? body.mode : 'stats'
    if (mode === 'stats') return [200, { ok: true, ...(await uploadsStats(registryDir)) }]
    if (mode === 'gc') return [200, { ok: true, removed: await gcUploads(registryDir) }]
    if (mode === 'cleanup') {
      if (body.confirm !== true) return badRequest('清理暂存需要 confirm:true')
      const registry = await loadImports(registryDir)
      return [200, { ok: true, ...(await cleanupStaging(registryDir, Object.keys(registry.imports || {}))) }]
    }
    return badRequest('未知 mode: ' + mode)
  }))

  // 设置偏好 fenced 路由：POST /api-import/prefs——面板设置分区客户端的读写通道。
  // 契约：DSH 配置客户端（settingsScope）只能访问 api-proxy 暴露白名单内的命名空间，本插件
  // 的命名空间不在其列；客户端经本路由（与 /api-import/* 同一信任围栏）进程内读写设置 seam
  //（describe / update）。body 无写入键（importSystemPrompt / sidebarButton 非 boolean、
  // injectTools 非档位或 boolean）→ 读 { value, revision, available, probe }；含任一写入键 →
  // 写（expectedRevision 冲突保护，冲突返回 code: 'settings-conflict' 由客户端重读）。
  // settings 服务缺席时读返回默认、写原样返回（不持久化），available:false 供客户端降级；
  // probe 是只读自检（宿主设置服务的关键事实，见 docs/SETTINGS-MIGRATION.md）。
  ws.register(jsonRoute('/api-import/prefs', async (req) => {
    const body = await readBody(req)
    const patch = {}
    if (typeof body.importSystemPrompt === 'boolean') patch.importSystemPrompt = body.importSystemPrompt
    if (typeof body.injectTools === 'boolean' || INJECT_MODES.includes(body.injectTools)) patch.injectTools = body.injectTools
    if (typeof body.sidebarButton === 'boolean') patch.sidebarButton = body.sidebarButton
    let view
    if (Object.keys(patch).length === 0) {
      view = describeImportPrefs(ctx)
    } else {
      try {
        view = await updateImportPrefs(ctx, patch, typeof body.revision === 'number' ? body.revision : undefined)
      } catch (err) {
        // 命名空间被并发移动时 settings 服务抛 SettingsConflictError（类名 + 消息），转成
        // 友好码由客户端重读权威值
        const label = String((err && err.name ? err.name + ': ' : '') + (err && err.message) || '')
        return [200, { ok: false, code: /conflict/i.test(label) ? 'settings-conflict' : undefined, error: label }]
      }
    }
    return [200, { ok: true, value: view.value, revision: view.revision, available: view.available, probe: view.probe }]
  }))
}

// 「导入所选并归档旧会话」：显式选了 DSH 来源时，导入完成后把**源会话**在宿主里归档。
// 插件只消费公开服务，所以按能力探测：workspaceRegistry 暴露 archiveSession/archive 才调用，
// 否则如实回报 archiveUnsupported（不假装归档成功——导入本身已经完成）。归档是不可逆的隐藏
// 动作（平台无取消归档面）：只有**导入确实成功**的条目才归档（目标会话确实存在：新建 /
// 替换 / 续写 / 已存在；批量条目按新增 + 续写 + 已存在计数），未归档条数经 archiveSkipped
// 如实上报。
async function archiveImportedSources(ctx, items, results) {
  const wr = ctx.get('workspaceRegistry')
  const archiveFn = wr && (typeof wr.archiveSession === 'function' ? (id) => wr.archiveSession(id)
    : typeof wr.archive === 'function' ? (id) => wr.archive(id) : null)
  if (!archiveFn) return { archiveUnsupported: true }
  const okPaths = new Set()
  for (const r of results) {
    if (!r || typeof r.sourcePath !== 'string') continue
    const ok = r.mode === 'batch'
      ? (r.imported || 0) + (r.appended || 0) + (r.alreadyImported || 0) > 0
      : (r.status === 'imported' || r.status === 'replaced' || r.status === 'appended' || r.status === 'already-imported')
    if (ok) okPaths.add(r.sourcePath)
  }
  let archived = 0
  let archiveSkipped = 0
  const seen = new Set()
  for (const item of items) {
    const source = typeof item?.source === 'string' ? item.source : ''
    const id = typeof item?.sessionId === 'string' ? item.sessionId : ''
    if (!id || seen.has(id) || !(source === 'dsh' || source === 'dsh4')) continue
    seen.add(id)
    const sourcePath = typeof item?.sourcePath === 'string' ? item.sourcePath : ''
    if (!okPaths.has(sourcePath)) { archiveSkipped++; continue }
    try {
      await archiveFn(id)
      archived++
    } catch (err) {
      console.warn('[dsh-chat-import] 归档源会话失败（' + id + '）：' + errorText(err))
      archiveSkipped++
    }
  }
  return { archived, ...(archiveSkipped > 0 ? { archiveSkipped } : {}) }
}
