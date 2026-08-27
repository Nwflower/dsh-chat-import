// eslint.config.mjs — REQ-10 最小 flat config（无插件）。
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
        URL: 'readonly', // 脚本（.github/scripts/*）用 new URL(..., import.meta.url) 定位路径
        setTimeout: 'readonly', // node 计时器（index.test.mjs 轮询让出事件循环）
      },
    },
    rules: {
      'no-unused-vars': ['error', { caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'no-constant-condition': 'error',
    },
  },
]
