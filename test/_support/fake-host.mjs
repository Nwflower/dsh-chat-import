// test/_support/fake-host.mjs — 插件级用例共用的 fake host（DSH 宿主服务的内存替身）。
//
// 组合式 builder，按需取用（全部只在测试进程内存里活动，不碰真实 DSH）：
//
//   makePersistence(opts)       sessionPersistence 直写形态：list / create / append / inspect /
//                               readFrom / remove（+ 可选 locate）。sessions: Map<id, { meta, events }>
//                               可直接 seed；calls 记录每次调用的方法名。
//     strictSeq = true          append 校验 seq 从已存条数起连续（引擎契约）；false = 不校验、
//                               未知 id 静默忽略（只关心「写了什么」的用例）
//     omit = []                 去掉某些面，模拟缺该能力的宿主（如 ['remove'] / ['inspect']）
//     unreadable = false        有读面但读不出事件（inspect / readFrom 回 undefined）：插件拿不到
//                               DSH 侧日志长度，走「读不到日志」分支
//     locate(meta)              提供 locate 面（同步，返回 { kind, path }）
//     onCreate(meta)            create 成功后的钩子（如在磁盘上落会话工件）
//     另有 ghost(id)（list 仍可见、inspect/readFrom 抛错——工件已删）与 hostReject(id)（list
//     不再暴露、create 仍报 already exists）两种幽灵会话注入。
//   makeHandlePersistence(store) 新宿主（dsh >= 0.1.5）句柄面：list → { header, … }，读走
//                               open(id,'read') + handle.read()，写走 create(header) → handle.append；
//                               与 store（makePersistence 的返回值）共享同一份 sessions。
//   makeFs(tree, opts)          fs 服务：resolve / stat / readText / listDir / writeText / processPath。
//                               tree: { path → 'dir' | 文本 }。所有树查找都做分隔符归一（原键 → 正斜杠
//                               → 反斜杠三态命中；listDir 按正斜杠归一后比前缀），代码里 join() 在
//                               Linux 产出的混合分隔符也查得到（check-linux-compat 规则 1）。
//     real = 'stat'             树外路径回退 node:fs 的范围：false（不回退）| 'stat'（只回退 stat，
//                               如临时 SQLite 库）| true（stat / readText / listDir 都回退，真实临时
//                               目录夹具；listDir 合并树内与磁盘子项）
//     versions = {}             钉住某路径的 stat version（模拟「内容变而 fs 版本不变」）
//     caseInsensitive = false   树查找忽略大小写（Windows 盘符 / 目录大小写变体）
//     readOnly = false          writeText 一律抛错
//     返回的 fs 另带观测面：writes（writeText 记录 { path, content, options }）、reads.count
//     （readText 次数）、lookup(path)（树查找）。writeText 写回 tree（内存覆盖层，不落盘）；
//     createIfAbsent 对已存在路径抛 EEXIST。
//   forbiddenFs()               任何方法被取用即记录并在调用时抛错的 fs（断言「全程不碰 fs」）。
//   makeWorkspaceRegistry(opts) resolveByPath / create / archivedSessionIds / archiveSession；
//                               附带 workspaces（Map）与 attached（attachSession 记录）观测面。
//     reject(path)              返回真值时 create 抛错（模拟宿主「路径不是目录」拒绝）
//     archived = []             全局归档集初值
//   makeTools()                 tools.register 捕获：registered（全部注册过的定义）、active()（未注销数）。
//   makeRegistrar()             通用 register 捕获（commands / skills / webServer 共用形态）。
//   makeCtx(tree, opts)         组装 ctx：fs / sessionPersistence / tools / webServer 属性 +
//                               get / inject / on / effect。返回 { ctx, fs, persistence, registered,
//                               attached, workspaces, webRoutes, writes, reads, listeners, active }。
//     fs / persistence / workspaceRegistry  直接给定现成对象（键存在即采用，值可为 undefined
//                               表示宿主缺该服务）；否则按 fsOptions / persistenceOptions /
//                               rejectWorkspaceCreate / archived 现建
//     real / versions           makeFs 的同名选项（fsOptions 里给也行）
//     hostApi = 'legacy'        'handle' 时 sessionPersistence 换成句柄面（persistence 仍是底层 store）
//     services = {}             额外 ctx.get 服务（attachments / settings / agents / llm …）；其中
//                               skills / commands 同时挂成 ctx 属性（插件在 inject 回调里按属性取）
//     noWebServer = false       模拟 headless：webServer 不可得，依赖它的 inject 回调永不执行
//     inject 语义对齐 Cordis：依赖都可得（ctx.get 非 undefined）才同步执行回调；回调返回值按
//     effect 契约校验（函数 / 空 / thenable / 可迭代之外抛 TypeError: Invalid effect）。
//     on(event, handler) 记进 listeners（Map<event, handler[]>），用例可自行触发。
//   toolDef(ctx, name)          取回注册的工具定义；chatDef(ctx, format) / exportDef(ctx, format)
//                               是 import_chat / export_chat 分发器的「绑定 format」形态。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── sessionPersistence ──────────────────────────────────────────────

export function makePersistence({ strictSeq = true, omit = [], unreadable = false, locate, onCreate } = {}) {
  const sessions = new Map() // id -> { meta, events: [], ghosted?, readFromThrows? }
  const calls = []
  const rejectIds = new Set() // create 拒绝的幽灵 id（list 不暴露）
  const known = (id) => {
    const s = sessions.get(id)
    if (!s) throw new Error('unknown session ' + id)
    return s
  }
  const api = {
    sessions,
    calls,
    ghost(id) {
      const s = sessions.get(id)
      if (s) { s.ghosted = true; s.readFromThrows = true }
    },
    hostReject(id) {
      rejectIds.add(id)
      sessions.delete(id)
    },
    async list() {
      calls.push('list')
      return [...sessions.values()].map((s) => s.meta)
    },
    async create(meta) {
      calls.push('create')
      if (rejectIds.has(meta.id)) throw new Error('session "' + meta.id + '" already exists in this backend')
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [] })
      if (onCreate) onCreate(meta)
    },
    async append(id, events) {
      calls.push('append')
      if (!strictSeq) {
        const s = sessions.get(id)
        if (s) s.events.push(...events)
        return
      }
      const s = known(id)
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        if (!ev || typeof ev.seq !== 'number' || ev.seq !== s.events.length + i) {
          throw new Error('append seq 不连续: 期望 ' + (s.events.length + i) + ' 实际 ' + String(ev && ev.seq))
        }
      }
      s.events.push(...events)
    },
    async inspect(id) {
      calls.push('inspect')
      if (unreadable) return undefined
      const s = known(id)
      if (s.ghosted) throw new Error('session artifact missing (ghost)')
      return { meta: s.meta, events: s.events }
    },
    async readFrom(id, fromSeq = 0) {
      calls.push('readFrom')
      if (unreadable) return undefined
      const s = known(id)
      if (s.readFromThrows) throw new Error('readFrom failed (torn log)')
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
    async remove(id) {
      calls.push('remove')
      sessions.delete(id)
    },
  }
  if (typeof locate === 'function') {
    api.locate = (meta) => {
      calls.push('locate')
      return locate(meta)
    }
  }
  for (const name of omit) delete api[name]
  return api
}

export function makeHandlePersistence(store) {
  const sess = (id) => store.sessions.get(id)
  return {
    sessions: store.sessions,
    async list() {
      return [...store.sessions.values()].map((s) => ({ header: s.meta, revision: 'rev', sizeBytes: 0 }))
    },
    async create(header) {
      if (store.sessions.has(header.id)) throw new Error('session "' + header.id + '" already exists in this backend')
      store.sessions.set(header.id, { meta: header, events: [] })
      return {
        header,
        async append(events) {
          const target = sess(header.id)
          for (let i = 0; i < events.length; i++) {
            if (events[i].seq !== target.events.length + i) throw new Error('append seq 不连续: ' + String(events[i] && events[i].seq))
          }
          target.events.push(...events)
        },
        async flush() {},
        async close() {},
      }
    },
    async open(id, access) {
      if (!store.sessions.has(id)) throw new Error('unknown session ' + id)
      if (access !== 'read') throw new Error('tests only expose a read lease: ' + access)
      return {
        header: sess(id).meta,
        async read(offset = 0) { return { events: sess(id).events.slice(offset) } },
        async close() {},
      }
    },
  }
}

// ── fs ──────────────────────────────────────────────────────────────

/** 内容派生的 fs 版本指纹：内容变则 version 变。 */
export function contentVersion(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return 'v' + h
}

const toSlash = (p) => String(p).replace(/\\/g, '/')
const targetOf = (path) => ({ targetKey: path, displayPath: path })

function realStat(path) {
  let s
  try { s = statSync(path) } catch { /* 路径不存在或不可访问 → 视为未找到 */ return undefined }
  if (s.isDirectory()) return { type: 'directory' }
  return { type: 'file', size: s.size, mtimeMs: s.mtimeMs, version: 'real-' + s.size + '-' + s.mtimeMs + '-' + s.ctimeMs }
}

export function makeFs(tree = {}, { real = 'stat', versions = {}, caseInsensitive = false, readOnly = false } = {}) {
  const writes = []
  const reads = { count: 0 }
  const keyOf = caseInsensitive ? (p) => toSlash(p).toLowerCase() : toSlash
  const lookup = (p) => {
    if (caseInsensitive) {
      const want = keyOf(p)
      for (const [k, v] of Object.entries(tree)) if (keyOf(k) === want) return v
      return undefined
    }
    const f = toSlash(p)
    return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
  }
  return {
    writes,
    reads,
    lookup,
    async resolve(path) { return targetOf(path) },
    processPath(target) { return target.targetKey },
    async stat(target) {
      const path = target.targetKey
      const v = lookup(path)
      if (v !== undefined) {
        return v === 'dir'
          ? { type: 'directory' }
          : { type: 'file', size: v.length, version: versions[path] !== undefined ? versions[path] : contentVersion(v) }
      }
      return real ? realStat(path) : undefined
    },
    async readText(target) {
      reads.count++
      const path = target.targetKey
      const v = lookup(path)
      if (v !== undefined && v !== 'dir') return v
      if (v === undefined && real === true) {
        try { return readFileSync(path, 'utf8') } catch { /* 磁盘上也没有 → 与树缺失同一报错 */ }
      }
      throw new Error('FS_NOT_FOUND ' + path)
    },
    async listDir(target) {
      const path = target.targetKey
      const dir = keyOf(path).replace(/\/+$/, '')
      const entries = []
      for (const [p, v] of Object.entries(tree)) {
        const k = keyOf(p)
        if (!k.startsWith(dir + '/')) continue
        const rest = k.slice(dir.length + 1)
        if (!rest || rest.includes('/')) continue
        entries.push({ name: p.slice(p.length - rest.length), type: v === 'dir' ? 'directory' : 'file', target: targetOf(p), version: 1 })
      }
      if (real === true) {
        let dirents
        try {
          dirents = readdirSync(path, { withFileTypes: true })
        } catch (err) {
          // 树内认识这个目录 → 只列树内项；两边都没有 → 照实抛（宿主 listDir 对缺失目录报错）
          if (entries.length === 0 && lookup(path) === undefined) throw err
          dirents = []
        }
        for (const d of dirents) {
          if (entries.some((e) => e.name === d.name)) continue
          const child = join(path, d.name)
          entries.push({ name: d.name, type: d.isDirectory() ? 'directory' : 'file', target: targetOf(child), version: 1 })
        }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
    async writeText(target, content, options) {
      if (readOnly) throw new Error('read-only')
      const path = target.targetKey
      if (options && options.kind === 'createIfAbsent' && (lookup(path) !== undefined || (real === true && realStat(path)))) {
        throw Object.assign(new Error('EEXIST ' + path), { code: 'EEXIST' })
      }
      tree[path] = content
      writes.push({ path, content, options })
      return { path }
    },
  }
}

export function forbiddenFs() {
  const calls = []
  const fs = new Proxy({}, {
    get(_t, prop) {
      calls.push(String(prop))
      return async () => { throw new Error('fs.' + String(prop) + ' 不应被调用') }
    },
  })
  return { fs, calls }
}

// ── workspaceRegistry / tools / 通用 register 捕获 ──────────────────

export function makeWorkspaceRegistry({ reject, archived = [] } = {}) {
  const workspaces = new Map()
  const attached = []
  const archivedIds = [...archived]
  return {
    workspaces,
    attached,
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) {
      // 真实宿主 create 校验「路径是已存在的目录」（realpath + isDirectory）；mock 默认宽松
      // （虚拟项目路径也能当工作区），reject 打开该校验。
      if (typeof reject === 'function' && (await reject(p))) {
        throw new Error("cannot create a workspace at '" + p + "': path is not a directory")
      }
      const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }
      workspaces.set(p, ws)
      return ws
    },
    get archivedSessionIds() { return archivedIds },
    async archiveSession(id) { archivedIds.push(id) },
  }
}

export function makeTools() {
  const registered = []
  let active = 0
  const tools = {
    register(def) {
      registered.push(def)
      active++
      return () => { active-- }
    },
    registered: (name) => registered.find((d) => d.name === name),
  }
  return { tools, registered, active: () => active }
}

export function makeRegistrar() {
  const defs = []
  return {
    defs,
    register(def) { defs.push(def); return () => {} },
    find: (name) => defs.find((d) => d.name === name),
  }
}

// ── ctx ─────────────────────────────────────────────────────────────

// 插件在 inject 回调里按属性取用的可选服务（cmdCtx.commands / skillCtx.skills）。
const PROPERTY_SERVICES = ['skills', 'commands']

export function makeCtx(tree = {}, opts = {}) {
  const services = opts.services || {}
  // 外部给定的 fs 不读它的任何属性（forbiddenFs 把属性读取也记作一次调用）
  const ownFs = 'fs' in opts ? null : makeFs(tree || {}, { real: opts.real, versions: opts.versions, ...opts.fsOptions })
  const fs = ownFs || opts.fs
  const persistence = 'persistence' in opts ? opts.persistence : makePersistence(opts.persistenceOptions)
  const hostPersistence = opts.hostApi === 'handle' ? makeHandlePersistence(persistence) : persistence
  const workspaceRegistry = 'workspaceRegistry' in opts
    ? opts.workspaceRegistry
    : makeWorkspaceRegistry({ reject: opts.rejectWorkspaceCreate, archived: opts.archived })
  const { tools, registered, active } = makeTools()
  const web = makeRegistrar()
  const listeners = new Map()

  const ctx = {
    fs,
    sessionPersistence: hostPersistence,
    webServer: web,
    tools,
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return hostPersistence
      if (service === 'webServer') return opts.noWebServer ? undefined : web
      return services[service]
    },
    inject(serviceList, cb) {
      const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
      if (!list.every((s) => ctx.get(s) !== undefined)) return undefined
      const effect = cb(ctx)
      if (effect !== undefined && effect !== null && typeof effect !== 'function') {
        const invalid = typeof effect !== 'object' ||
          (!('then' in effect) && !(Symbol.iterator in effect) && !(Symbol.asyncIterator in effect))
        if (invalid) throw new TypeError('Invalid effect')
      }
      return effect
    },
    on(event, handler) {
      const list = listeners.get(event) || []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect() { return () => {} },
  }
  for (const name of PROPERTY_SERVICES) {
    if (services[name] !== undefined) ctx[name] = services[name]
  }
  return {
    ctx,
    fs,
    persistence,
    registered,
    active,
    attached: workspaceRegistry && workspaceRegistry.attached,
    workspaces: workspaceRegistry && workspaceRegistry.workspaces,
    webRoutes: web.defs,
    writes: ownFs ? ownFs.writes : undefined,
    reads: ownFs ? ownFs.reads : undefined,
    listeners,
  }
}

// ── 工具定义取回 ─────────────────────────────────────────────────────

export function toolDef(ctx, name) {
  return ctx.tools.registered(name)
}

// import_chat 分发器定义——execute 时注入 format（等价旧 import_<format> 工具的调用方式）
export function chatDef(ctx, format) {
  const tool = toolDef(ctx, 'import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// export_chat 三合一定义——execute 时注入 format（等价旧 export_claude / export_codex / export_kimi）
export function exportDef(ctx, format) {
  const tool = toolDef(ctx, 'export_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}
