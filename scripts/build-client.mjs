// scripts/build-client.mjs — 由 src/client/ 片段组装 lib/client.js（浏览器侧单文件 bundle）
//
// 为什么需要它：DSH 的客户端模块加载器没有相对 require、也没有资源 URL，插件的
// 浏览器侧产物必须是单个自包含文件（见 docs/architecture.md D7）。源码按职责
// 分片维护在 src/client/，本脚本逐字拼回 lib/client.js。
//
// 片段契约（违反即构建失败）：
//   - 片段共享 bundle 的 factory 作用域：禁止 import/export，跨片引用直接用人家的
//     顶层声明（顺序 = FRAGMENTS 数组顺序）；
//   - 保持 4 空格基准缩进（嵌在 factory 内的一层）；
//   - 行尾一律 LF（读入时 CRLF 归一）。
//
// 内联模块（FRAGMENTS 里以 lib/ 开头的条目）：宿主侧的纯函数模块可以直接充当一个片段——
// 去掉顶格声明前的 `export `、整体缩进 4 格后拼入（inlineModule）。这样模块本身就是唯一
// 真相源：测试直接 import 它，测的就是 bundle 里发布的那一份，不再维护「lib 镜像 + 片段
// 副本 + 同步测试」三件套。模块必须是零 import、只有顶格 `export const|let|function|class`
// 声明的纯模块（export default / export { … } / export * / 跨行模板字符串一律拒绝：
// 前三者无法去 export 化，后者整体缩进会改掉字符串内容）。
//
// 用法：
//   node scripts/build-client.mjs          # 组装并写 lib/client.js
//   node scripts/build-client.mjs --check  # 只校验产物新鲜度（npm run build 用）
//   node scripts/build-client.mjs --out=dev/preview/client.variant.js
//                                          # 写别处：做测量/实验时用，避免把实验配置带进
//                                          # 宿主正在 HMR 加载的 lib/client.js（写它会触发宿主
//                                          # 重新加载面板，实验配置会被真实 UI 看到）
//
// 作为模块被 import（测试 / eslint.config.mjs）时只导出组装函数与片段全局名单，不写任何文件。
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(root, 'src/client')
const OUT = resolve(root, 'lib/client.js')

/** 组装顺序即运行时声明顺序：跨片引用只能指向排在前面的片段。 */
export const FRAGMENTS = [
  'lib/panel-filter.mjs', // 工作区筛选纯函数（宿主侧模块原样内联，测试直接 import）
  'i18n.js',      // 字典 DICT + fill + locale 服务句柄
  'prefs.js',     // 侧栏按钮偏好存取 + useTranslate
  'sources.js',   // 来源枚举 / 标签 / 徽标 / 分页常量 / 排序
  'logos.js',     // 来源品牌标与字标（lobehub 静态 SVG，生成物：scripts/gen-logos.mjs）
  'widgets.js',   // Icon / SourceBadge / useContainerWidth
  'styles.js',    // themeColors + makeStyles（DSW 设计令牌）
  'toast.js',     // ToastHost（官方 shell.overlay 落点提示；缺 primitives 时自绘横幅）
  'utils.js',     // fmt* / 结果摘要 / 响应解析 worker / Toggle
  'settings.js',  // 设置页「会话导入」分区 + 同步设置
  'tabs.js',      // ImportTabContent / SidebarImportTab / HistoryPanel / SearchableSelect
  'discovery.js', // DiscoveryPanel（发现 + 多选导入主面板）
  'file-import.js', // FileImportPanel（「从文件导入」折叠区：上传 / 路径浏览 / 预览 / 目录批处理）
  'lib/footer-layout.mjs', // footer 车道量法与形态判定（宿主侧模块原样内联，测试直接 import）
  'footer.js',    // LogoIcon / 设置导航图标
  'entry.js',     // ImportButton + apply()（槽注册、tab 类型注册）
]

export const HEADER = `/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, Worker, Blob */
 // lib/client.js — DSH Web 侧面板 bundle：右侧栏「导入会话」tab，支持发现、搜索、分页、多选导入。
 // 纯前端，只消费注入的 slots / locale / react；唯一例外是官方 UI primitives 的 Toast
 //（toast.js，缺包自动退回自绘横幅），见 docs/architecture.md D17。
 //
 // GENERATED FILE — 勿手改。源在 src/client/ 分片，node scripts/build-client.mjs 组装。
window.__ModuleLoader__.load({
  id: "dsh-chat-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } = React;
    // 元素工厂简写（片段里的 UI 树一律写 h(type, props, ...children)）
    const h = React.createElement;
`

const FOOTER = `    module.exports = { name, inject, apply };
    return module.exports;
  },
})
`

const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '')

/** 片段契约检查（禁 import/export、4 空格基准缩进）；label 用于报错定位。 */
function checkFragment(label, text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^[ \t]*(import|export)[ \t]/m.test(line)) {
      throw new Error(`build-client: ${label} 第 ${i + 1} 行用了 import/export（片段共享 factory 作用域，禁止模块语法）`)
    }
    if (line.trim() !== '' && !/^ {4}/.test(line)) {
      throw new Error(`build-client: ${label} 第 ${i + 1} 行不是 4 空格基准缩进：${line.trim().slice(0, 60)}`)
    }
  }
  return text
}

/**
 * 宿主侧纯模块 → bundle 片段：去掉顶格声明前的 `export `、非空行整体缩进 4 格，顶部加一行
 * 来源标记。违反「纯模块」形态（见文件头）直接抛错——宁可构建失败，也不拼出语义变了的代码。
 * @param {string} label 模块相对路径（报错定位 + 来源标记）
 * @param {string} source 模块源码
 * @returns {string} 片段文本
 */
export function inlineModule(label, source) {
  const lines = normalize(source).split('\n')
  const out = [`    // ── 内联自 ${label}（宿主侧纯模块，构建时去掉 export 原样拼入；改它即改 bundle）──`]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const where = `build-client: ${label} 第 ${i + 1} 行`
    if (/^\s*import\b/.test(line)) throw new Error(`${where}有 import：内联模块必须零依赖`)
    if (/^\s*export\b/.test(line) && !/^export\s+(?:const|let|function|async\s+function|class)\b/.test(line)) {
      throw new Error(`${where}的 export 形态无法内联（只认顶格 export const|let|function|class）：${line.trim().slice(0, 60)}`)
    }
    const comment = /^\s*(?:\/\/|\/?\*)/.test(line)
    if (!comment && (line.match(/`/g) || []).length % 2 === 1) {
      throw new Error(`${where}疑似跨行模板字符串：整体缩进会改掉字符串内容，请改成单行或字符串拼接`)
    }
    const body = line.replace(/^export\s+/, '')
    out.push(body.trim() === '' ? '' : '    ' + body)
  }
  return out.join('\n')
}

/** 读一个片段：src/client/<name>，或 lib/ 下的内联模块；都过片段契约检查。 */
function fragment(name) {
  if (name.startsWith('lib/')) {
    return checkFragment(name, inlineModule(name, readFileSync(resolve(root, name), 'utf8')))
  }
  return checkFragment(`src/client/${name}`, normalize(readFileSync(resolve(SRC, name), 'utf8')))
}

/** 组装整份 bundle 文本（纯函数：只读源文件，不写盘）。 */
export function assemble() {
  return [normalize(HEADER), ...FRAGMENTS.map(fragment), normalize(FOOTER)].join('\n\n') + '\n'
}

/**
 * 片段共享作用域里的全部顶层名字 → eslint 的 globals（eslint.config.mjs 据此给 src/client/
 * 逐文件开 no-undef，跨片名字拼错在片段文件的行号上直接报出）。来源与组装同一份清单：
 * bundle 头部 `/* global … *\/` 声明的浏览器全局、factory 参数 require、头部声明（React /
 * hooks / h / module / exports）、每个片段（含内联模块）的顶层声明（4 空格基准缩进处的
 * function / class / const / let / var，含头部那条解构）。let / var 记 writable（跨片赋值
 * 合法，如 entry.js 给 localeSvc 赋值），其余 readonly。
 * @returns {Record<string, 'readonly'|'writable'>}
 */
export function clientFragmentGlobals() {
  const globals = { require: 'readonly' }
  const browser = /^\/\* global ([^*]+)\*\//.exec(HEADER)
  for (const name of browser[1].split(',')) globals[name.trim()] = 'readonly'
  for (const text of [HEADER, ...FRAGMENTS.map(fragment)]) {
    for (const line of text.split('\n')) {
      const decl = /^ {4}(?:async\s+)?(function\*?|class|const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})/.exec(line)
      if (!decl) continue
      const access = decl[1] === 'let' || decl[1] === 'var' ? 'writable' : 'readonly'
      const names = decl[2] ? [decl[2]] : decl[3].split(',').map((part) => part.split(':').pop().trim()).filter(Boolean)
      for (const name of names) globals[name] = access
    }
  }
  return globals
}

function main() {
  const bundle = assemble()

  // 语法门禁：bundle 必须能整体 parse 才允许落盘 / 通过校验。只 parse 不执行、不查引用——
  // 引用未定义 / 声明未使用这类错误由 eslint 兜住（片段逐文件 + lib/client.js 整体，见
  // eslint.config.mjs）。
  try {
    new vm.Script(bundle, { filename: 'lib/client.js' })
  } catch (error) {
    console.error('build-client: 组装产物语法校验失败：' + error.message)
    process.exit(1)
  }

  const outArg = process.argv.find((arg) => arg.startsWith('--out='))
  /** 写入目标：默认 lib/client.js；--out= 时写别处（不参与新鲜度校验）。 */
  const TARGET = outArg === undefined ? OUT : resolve(root, outArg.slice('--out='.length))

  if (process.argv.includes('--check')) {
    const onDisk = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n')
    if (onDisk !== bundle) {
      console.error('build-client: lib/client.js 与 src/client/ 不同步——请运行 node scripts/build-client.mjs 重新组装')
      process.exit(1)
    }
    console.log(`build-client: OK — lib/client.js 与 src/client/（${FRAGMENTS.length} 片）同步`)
    return
  }
  // 原子写：先写同目录临时文件，再 rename 覆盖目标。
  //
  // 为什么必须原子（血泪）：宿主的客户端 HMR 会轮询 lib/client.js 的 stat（mtime/size），
  // 一旦变化就 clientModules.rebuilt(id) —— 注册表随即 readFileSync 重新取内容，按「内容
  // 哈希」作为版本号发给浏览器，并带一年 immutable 缓存。直接 writeFileSync 覆写 180KB+
  // 会留出一个「读者拿到半截 bundle」的窗口：那一版会被当成合法版本发出去并被浏览器长期
  // 缓存（URL 由哈希决定，正常构建也换不回它），表现就是「构建一次有概率崩界面」。
  // rename 在同一目录内是原子的：读者要么看到旧版本，要么看到完整的新版本。
  const tmp = `${TARGET}.tmp-${process.pid}`
  writeFileSync(tmp, bundle)
  try {
    renameSync(tmp, TARGET)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件可能已不存在；下面原样抛出真正的失败原因 */ }
    throw error
  }
  const rel = TARGET === OUT ? 'lib/client.js' : TARGET.slice(root.length + 1).replace(/\\/g, '/')
  console.log(`build-client: built ${rel}（${bundle.split('\n').length - 1} 行，${bundle.length} 字节，${FRAGMENTS.length} 片，原子写）`)
}

// 直接运行才组装落盘；被 import 时（测试 / eslint 配置）只提供上面的导出。
// Windows 上 argv 与 import.meta.url 的盘符大小写可能不同，按平台口径比较。
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] !== undefined && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
