// eslint.config.mjs — 最小 flat config（无插件）。
// 规则贴近仓库风格：no-unused-vars / no-undef / eqeqeq / no-constant-condition。
// ECMAScript 内建全局由 ecmaVersion:'latest' 提供；宿主全局（console / process）
// 在此手工声明，不引入 globals 包。
//
// 两个 no-unused-vars 选项对应仓库既有惯用法：
//   caughtErrorsIgnorePattern '^_' — `catch (_)` 表示"已说明吞掉什么"（convert.mjs 遍布）；
//   argsIgnorePattern '^_' — 接口契约位参数（如 provider 的 control/options）未消费时加 _ 前缀；
//   ignoreRestSiblings — omit 模式（`({ isSummary, ...rest })`、`{ __action, ..., ...pub }`）。
// dev/ 是 gitignore 的本地工程面（永不提交，CI 无此目录），排除在 lint 面外。
import { clientFragmentGlobals } from './scripts/build-client.mjs'

export default [
  {
    ignores: ['dev/**'],
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly', // node 全局（zstd 解码 / 图片 base64 编解码）
        URL: 'readonly', // 脚本（.github/scripts/*）用 new URL(..., import.meta.url) 定位路径
        setTimeout: 'readonly', // node 计时器（index.test.mjs 轮询让出事件循环）
        clearTimeout: 'readonly', // node 计时器撤销（/api-import/browse 的原生目录对话框超时）
        AbortController: 'readonly', // node 全局（同上：对话框与请求的连接生命周期）
      },
    },
    rules: {
      'no-unused-vars': ['error', { caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'no-constant-condition': 'error',
    },
  },
  {
    // src/client/ 是 lib/client.js 的分片源：片段共享 bundle 的 factory 作用域（禁 import/
    // export，跨片直接引用彼此的顶层声明），按 script 解析。两条引用规则的分工：
    //   - no-undef：全局名单由 scripts/build-client.mjs 的 clientFragmentGlobals 生成（与组装
    //     同一份片段表 + bundle 头部声明），跨片名字拼错在片段文件的行号上直接报出；
    //   - no-unused-vars 只查函数内的局部（vars: 'local'）：顶层声明是否被别的片段用到，
    //     逐文件看不出来——这一半由下面对生成物 lib/client.js 的整体 lint 兜住（整份 bundle
    //     是一个作用域，未用的顶层声明在那里照常报错）。
    // build-client 的 vm 语法门禁只做 parse，不查引用，替代不了这两条。
    files: ['src/client/**'],
    languageOptions: {
      sourceType: 'script',
      globals: clientFragmentGlobals(),
    },
    rules: {
      'no-unused-vars': ['error', { vars: 'local', caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
]
