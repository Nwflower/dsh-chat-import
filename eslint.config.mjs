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
    // src/client/ 是 lib/client.js 的分片源：片段共享 bundle 的 factory 作用域
    //（禁 import/export，跨片直接引用彼此的顶层声明），逐文件 lint 必然误报
    // no-undef / no-unused-vars——这两条的检查职责由 scripts/build-client.mjs 的
    // 整体语法门禁承担。其余规则（eqeqeq / no-constant-condition）照常生效。
    files: ['src/client/**'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
]
