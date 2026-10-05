// test/cline-legacy-path.test.mjs — Cline 旧版（VS Code globalStorage）任务转写路径的解析
//
// <globalStorage>/tasks/<id>/api_conversation_history.json → 任务 id / globalStorage 根。导入侧
// （lib/sources/cline.mjs 的目录收集与参数派生）与发现层（lib/discovery/cline.mjs）共用
// lib/convert/cline.mjs 的这一份；两种分隔符都认，tasks 段与文件名不区分大小写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clineLegacyTaskIdFromPath, clineLegacyRootFromApiPath } from '../lib/convert/cline.mjs'

const WIN_ROOT = 'C:\\Users\\u\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev'
const POSIX_ROOT = '/home/u/.config/Code/User/globalStorage/saoudrizwan.claude-dev'

test('任务转写路径 → 任务 id 与 globalStorage 根（Windows / POSIX 分隔符）', () => {
  const win = WIN_ROOT + '\\tasks\\1786000000000\\api_conversation_history.json'
  assert.equal(clineLegacyTaskIdFromPath(win), '1786000000000')
  assert.equal(clineLegacyRootFromApiPath(win), WIN_ROOT)
  const posix = POSIX_ROOT + '/tasks/1786000000000/api_conversation_history.json'
  assert.equal(clineLegacyTaskIdFromPath(posix), '1786000000000')
  assert.equal(clineLegacyRootFromApiPath(posix), POSIX_ROOT)
})

test('tasks 段与文件名不区分大小写；任务 id 原样保留', () => {
  const p = POSIX_ROOT + '/Tasks/Task-ABC/API_Conversation_History.json'
  assert.equal(clineLegacyTaskIdFromPath(p), 'Task-ABC')
  assert.equal(clineLegacyRootFromApiPath(p), POSIX_ROOT)
})

test('不是旧版任务转写的路径 → null', () => {
  for (const p of [
    POSIX_ROOT + '/tasks/t1/ui_messages.json', // 同目录的 UI 消息不是转写
    POSIX_ROOT + '/state/taskHistory.json',
    POSIX_ROOT + '/t1/api_conversation_history.json', // 缺 tasks 段
    '/home/u/.cline/data/sessions/s1/s1.messages.json', // 现代 SDK 布局
    'api_conversation_history.json',
  ]) {
    assert.equal(clineLegacyTaskIdFromPath(p), null, p)
    assert.equal(clineLegacyRootFromApiPath(p), null, p)
  }
})
