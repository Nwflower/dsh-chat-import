// lib/discovery.mjs — 会话发现的公开入口（稳定导入路径；实现在 lib/discovery/）
//
// 只读发现层：经注入的 host（stat / readHead / readTail / readText / readDir / readSessions …）
// 访问文件与数据库，不 import DSH 服务。全部来源格式统一扫描成结构化索引（标题、项目名、
// 时间、上下文 token、导入状态、git 分支），支持 path / format / query 过滤；扫描结果有进程内
// 30s TTL 缓存与 scan-cache.json 持久化书签。
//
// 模块布局：
//   discovery/registry.mjs       来源描述符表（FORMATS / 默认根 / 布局项目名 / 单文件判格式的唯一真相源）
//   discovery/discover.mjs       主流程（目标展开、缓存、状态标注、排序）
//   discovery/scan-cache.mjs     TTL 缓存、进行中去重、持久化书签
//   discovery/run-host.mjs       单次发现内的 host 记忆化（目录列举 / stat / slug 解码）
//   discovery/<来源族>.mjs        各来源族的扫描器与描述符（claude / jsonl / gemini / sqlite /
//                                cline / session-dirs / documents / dsh）
//   discovery/common.mjs · walk.mjs · git-status.mjs · import-status.mjs  共用件

export { FORMATS, defaultRoots, layoutProject } from './discovery/registry.mjs'
export { discoverSessions, scanFormat } from './discovery/discover.mjs'
export {
  SCAN_TTL_MS, createScanCache, clearScanCache, clearInflightScans, SCAN_CACHE_FILE, SCAN_CACHE_VERSION,
} from './discovery/scan-cache.mjs'
export { resolveImportStatus } from './discovery/import-status.mjs'
export { HEAD_MAX_BYTES, isInjectedTitle } from './discovery/common.mjs'
export { traeUserDataDirs } from './discovery/sqlite.mjs'
export { clineLegacyStorageDirs } from './discovery/cline.mjs'
// 标题口径与转换层同源（lib/convert/util.mjs），这里只为既有调用方转出
export { TITLE_MAX_LEN, TITLE_ELLIPSIS, normalizeTitle } from './convert/util.mjs'
