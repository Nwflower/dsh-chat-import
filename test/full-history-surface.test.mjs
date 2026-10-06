// test/full-history-surface.test.mjs — fullHistory 三面对账：声明 / 实现 / 参数指纹
//
// 这个开关曾在三处各自漂移，并且都是「静默」的：
//   * 声明面：import_chat 的描述串手写来源名单 → 漏掉真正支持的来源（grokbuild）、
//     列上零实现的来源（vibe）；
//   * 实现面：声明支持的来源，其转换器/来源读取器未必真的读这个开关（vibe 就是空转）；
//   * 指纹面：实现了却没把 fullHistory 放进参数指纹 → 换值走「源未变」短路径被静默跳过
//     （grokbuild 曾把指纹键硬编码成空表）。
// 三面都由本文件对账：改声明、改实现、改指纹接线任一处漏改，这里红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../lib/tools.mjs'
import { IMPORT_SPECS } from '../lib/toolkit.mjs'
import { apply } from '../lib/index.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { hostAbs } from './_support/host-path.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// 非注释行里的 fullHistory 才算实现（注释里的提及不算）
function consumes(source) {
  return source.split('\n').some((line) => line.includes('fullHistory') && !/^\s*(\/\/|\*|\/\*)/.test(line))
}

// 实现面：format → 真正消费该开关的文件（转换器，或 opencode 家族共用的来源读取器）
const IMPLEMENTATION = {
  claude: ['lib/convert/claude.mjs'],
  cline: ['lib/convert/cline.mjs'],
  codex: ['lib/convert/codex.mjs'],
  continue: ['lib/convert/continue.mjs'],
  crush: ['lib/convert/crush.mjs'],
  grokbuild: ['lib/convert/grokbuild.mjs'],
  kimi: ['lib/convert/kimi.mjs'],
  pi: ['lib/convert/pi.mjs'],
  zcode: ['lib/convert/zcode.mjs'],
  zed: ['lib/convert/zed.mjs'],
  opencode: ['lib/sources/opencode.mjs'],
  mimocode: ['lib/sources/mimocode.mjs'],
  kilocode: ['lib/sources/kilocode.mjs'],
  teleagent: ['lib/sources/teleagent.mjs'],
}

// 已知缺口：有压缩概念/接了指纹键但**没有实现**该开关的来源。列在这里是为了让它可见，
// 而不是当它不存在——一旦哪天实现了，下面第 4 条会红，逼着同时更新声明与 spec。
const KNOWN_GAPS = {
  vibe: '压缩导入靠 pendingCompaction（有检查点），但转换器不读 fullHistory → 开关空转',
  trae: '源侧没有压缩概念（ItemTable/JSON 里没有 compaction 记录）→ 开关无意义',
}

function registeredTools() {
  const { ctx, registered } = makeCtx()
  registerTools(ctx, '.full-history-surface-test')
  return new Map(registered.map((d) => [d.name, d]))
}

const declaredFormats = () =>
  [...IMPORT_SPECS.values()].filter((s) => s.fullHistory === true).map((s) => s.format).sort()

const sorted = (list) => [...list].sort()

test('fullHistory：spec 的声明 == 实现表（既不虚报，也不漏报）', () => {
  const tools = registeredTools()
  assert.ok(tools.has('import_chat'))
  assert.deepEqual(declaredFormats(), sorted(Object.keys(IMPLEMENTATION)),
    'spec 声明 fullHistory 的来源与 test 的实现表不一致：声明漏了真实支持的来源，或列了没有实现的来源')
})

test('fullHistory：import_chat 的描述串由 spec 派生，名单与声明一致', () => {
  const desc = registeredTools().get('import_chat').parameters.properties.fullHistory.description
  const m = /^Optional \((.+?) only\):/.exec(desc)
  assert.ok(m, '描述串不再是「Optional (名单): 说明」的形态，本测试的解析需要同步：' + desc)
  assert.deepEqual(sorted(m[1].split('/')), declaredFormats(),
    '描述串里的来源名单必须由 spec.fullHistory 派生（手写必然漂移）')
})

test('fullHistory：每个声明来源都真有一处非注释的消费点', () => {
  for (const [format, files] of Object.entries(IMPLEMENTATION)) {
    for (const file of files) {
      assert.ok(consumes(read(file)), format + ' 声明支持 fullHistory，但 ' + file + ' 里没有消费点（实现被删了？）')
    }
  }
})

test('fullHistory：已知缺口不得悄悄被实现（实现了就要更新声明与 spec）', () => {
  for (const format of Object.keys(KNOWN_GAPS)) {
    assert.ok(!declaredFormats().includes(format), format + ' 已在 spec 里声明 fullHistory，请从 KNOWN_GAPS 移除')
    const files = ['lib/convert/' + format + '.mjs', 'lib/sources/' + format + '.mjs']
    for (const file of files) {
      let source
      try {
        source = read(file)
      } catch {
        continue // 该来源没有这一层的文件
      }
      assert.ok(!consumes(source),
        format + ' 现在真的消费 fullHistory 了（' + file + '）：请补实现声明、去掉 KNOWN_GAPS 里的豁免，并给参数指纹用例')
    }
  }
})

test('fullHistory：index.d.ts 的来源名单与声明同源', () => {
  const dts = read('lib/index.d.ts')
  const line = dts.split('\n').find((l) => l.includes('仅压缩感知来源'))
  assert.ok(line, 'index.d.ts 里找不到 fullHistory 的说明行')
  const m = /仅压缩感知来源（([^）]+)）/.exec(line)
  assert.ok(m, 'index.d.ts 的说明行不再是「仅压缩感知来源（名单）：」形态：' + line)
  assert.deepEqual(sorted(m[1].split(' / ')), declaredFormats(),
    'index.d.ts 的来源名单必须与 spec.fullHistory 一致')
})

test('fullHistory：grokbuild 换值重导走 argsChanged，不被「源未变」短路径静默吞掉', async () => {
  // 回归：grokbuild 的指纹键曾被硬编码成空表，导致换 fullHistory 后短路径照常跳过，
  // 用户的开关永远不生效、也不报任何变化。
  const dir = 'D:\\demo\\grok\\sessions\\proj-a\\grok-fh-001'
  const chat = [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '第一问' }] }),
    JSON.stringify({ type: 'assistant', content: '第一答' }),
    JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' }],
      synthetic_reason: 'compaction_meta',
    }),
    JSON.stringify({ type: 'assistant', content: '第二答' }),
  ].join('\n')
  const { ctx, persistence } = makeCtx({
    [dir]: 'dir',
    [dir + '\\summary.json']: JSON.stringify({
      info: { id: 'grok-fh-001', cwd: hostAbs('D:/demo/grok-proj') },
      generated_title: 'Grok FH',
      created_at: '2026-07-16T12:00:00Z',
    }),
    [dir + '\\chat_history.jsonl']: chat,
  })
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')

  const first = await def.execute({ path: dir })
  assert.equal(first.alreadyImported, false)
  assert.equal(first.compacted, true, '默认尊重压缩：夹具应发出原生压缩检查点')
  assert.equal(persistence.sessions.size, 1)

  const again = await def.execute({ path: dir })
  assert.equal(again.alreadyImported, true)
  assert.equal(again.argsChanged, undefined)

  const flipped = await def.execute({ path: dir, fullHistory: true })
  assert.equal(flipped.argsChanged, true, 'fullHistory 必须进参数指纹：换值要能报出来（而不是静默跳过）')
  assert.equal(persistence.sessions.size, 1, 'argsChanged 是跳过并点名，不另建会话')
})
