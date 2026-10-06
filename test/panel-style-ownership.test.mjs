// panel-style-ownership.test.mjs — 本插件自己注入的设置导航样式表，在宿主客户端模块系统
// 的样式记账下必须「归属明确、只受本插件影响」：
//   1. 建成时就带 data-plugin = 本插件包名 + 自己的 data-plugin-css，因此不被
//      `style:not([data-plugin])` 命中、不会被下一个物化的包收走；
//   2. 旧版本留下的无标记元素 / 上一次 apply 建的那张按 id 认回并补标记，不新建第二张；
//   3. 本插件的物化不再替宿主把别人的无标记样式表收进自己名下（否则本插件重载时会把
//      它们连带删掉），而是改写到不等于任何包名的值上。
//
// 凭什么这样测：宿主的行为就两条——物化时 `claimStyles` 认领文档里所有未打标签的
// <style> 并记到正在物化的包名下，重载时 `removeOwnedStyles` 按包名整批删除（见页面里
// 那份 @deepseek-ai/dsh-client-modules/client.js）。这里把那两条照抄成断言用的宿主替身，
// 并把 bundle 里的那一段（LOGO_PATHS + ensureSettingsNavStyle + parkForeignSheets 及其
// 模块作用域调用）切出来在最小 DOM 替身上跑——测的是浏览器里真正执行的那份逻辑，
// 不是源码文本（面板没有 DOM 测试环境，替身只实现这段代码用到的接口）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// 切片边界：LOGO_PATHS（遮罩路径与设置导航图标共用）到 registerSettingsNavIcon 之前。
const SLICE_START = '    const LOGO_PATHS = ['
const SLICE_END = '    /** 监听设置弹窗导航行'

const KEBAB = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** 最小 DOM 替身：属性是唯一真相源，dataset 按真实 DOM 规则反射到 data-* 上。 */
function makeElement(tag) {
  const attrs = new Map()
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    textContent: '',
    children: [],
    parentNode: null,
    connected: false,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    hasAttribute: (name) => attrs.has(name),
    removeAttribute: (name) => attrs.delete(name),
    dataset: new Proxy({}, {
      get: (_, prop) => (attrs.has('data-' + KEBAB(String(prop))) ? attrs.get('data-' + KEBAB(String(prop))) : undefined),
      set: (_, prop, value) => { attrs.set('data-' + KEBAB(String(prop)), String(value)); return true },
    }),
    appendChild(child) {
      child.parentNode = el
      child.connected = true
      el.children.push(child)
      return child
    },
    remove() {
      if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el)
      el.parentNode = null
      el.connected = false
    },
    /** 只认这段代码与宿主记账用到的选择器形态：tag / tag:not([attr]) / tag[attr] / tag[attr="v"]。 */
    matches(selector) {
      const m = /^([a-z]+)(?::not\(\[([\w-]+)\]\))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector)
      assert.ok(m, 'DOM 替身不支持的选择器：' + selector)
      const [, tag, notAttr, attr, value] = m
      if (el.tagName !== tag.toUpperCase()) return false
      if (notAttr && el.hasAttribute(notAttr)) return false
      if (attr) {
        if (!el.hasAttribute(attr)) return false
        if (value !== undefined && el.getAttribute(attr) !== value) return false
      }
      return true
    },
  }
  return el
}

function createFakeDom() {
  const all = []
  const document = {
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) { const el = makeElement(tag); all.push(el); return el },
    getElementById(id) { return all.find((el) => el.connected && el.id === id) || null },
    querySelector(selector) { return document.querySelectorAll(selector)[0] || null },
    querySelectorAll(selector) { return all.filter((el) => el.connected && el.matches(selector)) },
  }
  document.documentElement = document.createElement('html')
  document.head = document.documentElement.appendChild(document.createElement('head'))
  document.body = document.documentElement.appendChild(document.createElement('body'))
  return document
}

/** 把 bundle 里那一段切出来求值；observerCallbacks 收集注册的观察者回调（模块作用域那次）。 */
function loadStyleModule(document, observerCallbacks = []) {
  const start = source.indexOf(SLICE_START)
  const end = source.indexOf(SLICE_END, start)
  assert.notEqual(start, -1, 'lib/client.js 缺少 ' + SLICE_START.trim())
  assert.notEqual(end, -1, 'lib/client.js 缺少 ' + SLICE_END.trim())
  const body = source.slice(start, end)
    + '\nreturn { ensureSettingsNavStyle, parkForeignSheets, PLUGIN_ID, SETTINGS_NAV_STYLE_ID, SETTINGS_NAV_PLUGIN_CSS, FOREIGN_SHEET_PLUGIN };'
  // MutationObserver 替身：只记录回调，由测试手动触发（真实浏览器里是微任务）。
  function MutationObserverStub(callback) {
    observerCallbacks.push(callback)
    return { observe() {} }
  }
  return new Function('document', 'MutationObserver', body)(document, MutationObserverStub)
}

/** 宿主 @deepseek-ai/dsh-client-modules/client.js 的两条样式记账（照抄）。 */
const hostClaimStyles = (document, id) => {
  for (const el of document.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
}
const hostRemoveOwnedStyles = (document, id) => {
  for (const el of document.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove()
}

const unclaimedByHostSelector = (el) => el.matches('style:not([data-plugin])')

test('标记值 = 包名 = 模块 entry 名（宿主按 entry 名记账，改一个必须改三个）', () => {
  const document = createFakeDom()
  const mod = loadStyleModule(document)
  assert.equal(mod.PLUGIN_ID, pkg.name, 'data-plugin 必须等于 package.json 的 name')
  assert.match(source, new RegExp('__ModuleLoader__\\.load\\(\\{\\s*\\n\\s*id: "' + mod.PLUGIN_ID + '"'), 'bundle 的模块 id 必须等于同一个包名')
  assert.equal(mod.SETTINGS_NAV_PLUGIN_CSS, mod.PLUGIN_ID + '/settings-nav.css', 'data-plugin-css 要用本插件自己的键')
  assert.notEqual(mod.FOREIGN_SHEET_PLUGIN, mod.PLUGIN_ID, '被挪走的外来样式表不能落在任何包名上')
})

test('本插件自己那张样式表带归属标记，不被 style:not([data-plugin]) 命中', () => {
  const document = createFakeDom()
  const mod = loadStyleModule(document)
  mod.ensureSettingsNavStyle()
  const style = document.getElementById(mod.SETTINGS_NAV_STYLE_ID)
  assert.ok(style, 'apply() 后应存在设置导航样式表')
  assert.equal(style.dataset.plugin, mod.PLUGIN_ID, 'data-plugin 必须是本插件包名')
  assert.equal(style.dataset.pluginCss, mod.SETTINGS_NAV_PLUGIN_CSS, '要带自己的 data-plugin-css 键')
  assert.equal(unclaimedByHostSelector(style), false, '不得被宿主的认领扫描命中')
  assert.equal(style.parentNode, document.head, '挂在 <head> 上')
  assert.match(style.textContent, /\[data-dsh-chat-import-settings-nav\]::before/, '遮罩 CSS 要写上')
  assert.match(style.textContent, /-webkit-mask: url\("data:image\/svg\+xml,/, '遮罩走插件 logo 的 data URI')
  // 宿主物化这次不会认领任何东西：文档里没有未打标签的样式表
  hostClaimStyles(document, mod.PLUGIN_ID)
  assert.equal(document.querySelectorAll('style:not([data-plugin])').length, 0)
})

test('既有元素（旧版本留下的无标记元素 / 上次建的那张）按 id 认回并补标记，不新建第二张', () => {
  const document = createFakeDom()
  const legacy = document.createElement('style')
  legacy.id = 'dsh-chat-import-settings-nav-style'
  document.head.appendChild(legacy)
  const mod = loadStyleModule(document)
  // 模块作用域的 parkForeignSheets 放它一马（认 id），免得它被写成外来值
  assert.equal(legacy.getAttribute('data-plugin'), null, '本插件自己那张不参与外来样式表的挪动')
  mod.ensureSettingsNavStyle()
  assert.equal(document.getElementById(mod.SETTINGS_NAV_STYLE_ID), legacy, '要复用既有元素')
  assert.equal(legacy.dataset.plugin, mod.PLUGIN_ID, '并补上标记')
  assert.equal(legacy.dataset.pluginCss, mod.SETTINGS_NAV_PLUGIN_CSS)
  mod.ensureSettingsNavStyle()
  assert.equal(document.querySelectorAll('style[data-plugin-css="' + mod.SETTINGS_NAV_PLUGIN_CSS + '"]').length, 1, '重复调用不长出第二张')
})

test('本插件重载（宿主先按包名删除）后重新 apply 会重建出带标记的那张', () => {
  const document = createFakeDom()
  const mod = loadStyleModule(document)
  mod.ensureSettingsNavStyle()
  const css = document.getElementById(mod.SETTINGS_NAV_STYLE_ID).textContent
  hostRemoveOwnedStyles(document, mod.PLUGIN_ID)
  assert.equal(document.getElementById(mod.SETTINGS_NAV_STYLE_ID), null, '重载会删掉本插件名下那张（样式空窗由紧随的 apply 补回）')
  mod.ensureSettingsNavStyle()
  const rebuilt = document.getElementById(mod.SETTINGS_NAV_STYLE_ID)
  assert.ok(rebuilt, '下一次 apply 必须重建')
  assert.equal(rebuilt.dataset.plugin, mod.PLUGIN_ID)
  assert.equal(unclaimedByHostSelector(rebuilt), false)
  assert.equal(rebuilt.textContent, css, '重建出来的是同一份遮罩 CSS')
})

test('别人的无标记样式表不被认领，也就不会在本插件重载时被连带删除', () => {
  const document = createFakeDom()
  const foreign = document.createElement('style')
  foreign.textContent = '.dsh-meme-sheet { color: red; }'
  document.head.appendChild(foreign)
  const mod = loadStyleModule(document)
  // 模块作用域这一次赶在本插件那次 claimStyles 之前
  assert.equal(foreign.getAttribute('data-plugin'), mod.FOREIGN_SHEET_PLUGIN, '外来样式表要被挪到不等于任何包名的值上')
  mod.ensureSettingsNavStyle()
  hostClaimStyles(document, mod.PLUGIN_ID) // 本插件物化时的认领扫描
  assert.notEqual(foreign.getAttribute('data-plugin'), mod.PLUGIN_ID, '不得记到本插件名下')
  assert.equal(unclaimedByHostSelector(foreign), false, '已被挪走，宿主的认领扫描碰不到它')
  hostRemoveOwnedStyles(document, mod.PLUGIN_ID) // 本插件重载时的删除
  assert.ok(document.querySelector('style[data-plugin="' + mod.FOREIGN_SHEET_PLUGIN + '"]'), '重载后它必须还在文档里')
  assert.equal(foreign.parentNode, document.head, '原地不动')
})

test('本插件之后出现的无标记样式表由常驻观察者挪走（微任务回调）', () => {
  const callbacks = []
  const document = createFakeDom()
  const mod = loadStyleModule(document, callbacks)
  assert.equal(callbacks.length, 1, '模块作用域应挂一个 <head> 观察者')
  mod.ensureSettingsNavStyle()
  const later = document.createElement('style')
  later.textContent = '.later-sheet {}'
  document.head.appendChild(later)
  callbacks[0]()
  assert.equal(later.getAttribute('data-plugin'), mod.FOREIGN_SHEET_PLUGIN, '后出现的无标记样式表同样挪走')
  assert.equal(document.getElementById(mod.SETTINGS_NAV_STYLE_ID).dataset.plugin, mod.PLUGIN_ID, '自己那张保持本插件标记')
  hostClaimStyles(document, mod.PLUGIN_ID)
  assert.deepEqual(
    document.querySelectorAll('style[data-plugin="' + mod.PLUGIN_ID + '"]').map((el) => el.id),
    [mod.SETTINGS_NAV_STYLE_ID],
    '本插件名下只应有自己那一张',
  )
})

test('没有 document / MutationObserver 时不抛错（非浏览器环境加载 bundle）', () => {
  const start = source.indexOf(SLICE_START)
  const end = source.indexOf(SLICE_END, start)
  const body = source.slice(start, end) + '\nreturn { ensureSettingsNavStyle, parkForeignSheets };'
  const mod = new Function('document', 'MutationObserver', body)(undefined, undefined)
  assert.doesNotThrow(() => { mod.parkForeignSheets(); mod.ensureSettingsNavStyle() })
})
