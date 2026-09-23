/* global window, document, fetch, getComputedStyle, MutationObserver, ResizeObserver, setTimeout, requestAnimationFrame, cancelAnimationFrame, Worker, Blob */
 // lib/client.js — DSH Web 侧面板 bundle：右侧栏「导入会话」tab，支持发现、搜索、分页、多选导入。
 // 纯前端，只消费注入的 slots / locale / react，不 import DSH host 模块。
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

    // 面板文案字典（自有 ns "chat-import"；zh 为现状中文，en 为翻译）。
    // 查键链：chat-import → chat-import.zh → common → 键本身（locale 服务负责）。
    const LOCALE_NS = "chat-import";
    // 未分组桶的稳定键（排序钉最后；显示时经 t("noWorkspace") 翻译）
    const NO_WORKSPACE_KEY = "__no_workspace__";
    // 与 lib/panel-filter.mjs 同步：工作区筛选键 / 过滤 / 可搬空计数
    const workspaceKey = (s) => (s && s.project ? s.project : NO_WORKSPACE_KEY);
    const filterByWorkspace = (list, ws) => (!ws ? list : list.filter((s) => workspaceKey(s) === ws));
    const importableSessions = (list, ws) => filterByWorkspace(list, ws).filter((s) => s.importStatus !== "imported" && s.importStatus !== "archived");
    const refreshableSessions = (list, ws) => filterByWorkspace(list, ws).filter((s) => s.importStatus === "imported");
    // 工作区下拉的选项：key/latest 供排序与过滤，path 是该组里最新会话的绝对路径
    //（discovery 的 project 通常只是文件夹名，下拉里用更淡的字把它后面的路径画出来；
    // 同名不同路径时以最活跃的那个会话为准）。
    const buildWorkspaceOptions = (list) => {
      const map = new Map();
      for (const s of list) {
        const key = workspaceKey(s);
        const t0 = (typeof s.lastActiveAt === "number" ? s.lastActiveAt : 0) || (typeof s.createdAt === "number" ? s.createdAt : 0);
        const prev = map.get(key);
        if (!prev) {
          map.set(key, { key, latest: t0, at: t0, path: typeof s.cwd === "string" ? s.cwd : "" });
        } else {
          prev.latest = Math.max(prev.latest, t0);
          if (t0 >= prev.at) {
            prev.at = t0;
            prev.path = typeof s.cwd === "string" ? s.cwd : "";
          }
        }
      }
      return [...map.values()].sort((a, b) => {
        if (a.key === NO_WORKSPACE_KEY) return 1;
        if (b.key === NO_WORKSPACE_KEY) return -1;
        return (b.latest - a.latest) || String(a.key).localeCompare(String(b.key));
      });
    };
    const workspaceLabel = (key, tr) => (key === NO_WORKSPACE_KEY ? tr("noWorkspace") : key);
    const DICT = {
      zh: {
        "trigger.title": "从其他工具导入会话（发现 + 单选/多选导入）",
        "trigger.label": "导入会话",
        "sidebar.guide.description": "从 Claude Code / Codex / ChatGPT 等 25+ 工具导入会话并续聊",
        "source": "来源",
        "allSources": "全部来源",
        // DSH 两代的完整展示名（来源下拉用；会话行提示用 SOURCE_LABELS 的中性短名）
        "source.dsh": "DSH V3 会话格式",
        "source.dsh4": "DSH V4 会话格式",
        "source.title": "按外部工具过滤；切换来源会重新扫描",
        "workspace": "工作区",
        "filter.path": "筛选：路径",
        "filter.time": "筛选：时间",
        "filter.all": "全部",
        "filter.time.all": "不筛选",
        "filter.time.24h": "24 小时",
        "filter.time.7d": "7 天",
        "filter.time.30d": "30 天",
        "noWorkspace": "无工作区",
        "workspace.title": "只显示该工作区下的会话（与搜索同时生效）",
        "combobox.search.source": "搜索来源…",
        "combobox.search.workspace": "搜索工作区…",
        "combobox.noMatch": "无匹配项",
        "clearSearch": "清除",
        "search.placeholder": "搜索标题 / 工作区 / 路径…",
        "selectAll": "全选",
        "deselectAll": "取消全选",
        "clearSelection": "清空",
        "toast.skipped": "已跳过 {n} 个可能已导入的对话",
        "toast.ignore": "忽略警告",
        "selectImportable": "仅选未导入",
        "selectImported": "仅选已导入",
        "refresh": "刷新",
        "refresh.title": "重新扫描；源文件未改时复用 scan-cache，通常几秒完成",
        "importing": "导入中…",
        "import.selected": "导入所选 ({n})",
        "import.selectedArchive": "导入所选并归档旧会话 ({n})",
        "import.selectedArchive.short": "导入并归档 ({n})",
        "import.selectedArchive.title": "按目标代次导入所选会话，并在宿主里归档对应的源会话（迁移收尾）",
        "archive.done": "已归档 {n} 个旧会话",
        "archive.skipped": "{n} 个旧会话未归档：对应导入未成功（跳过或失败），旧会话保持原样",
        "archive.unsupported": "旧会话未归档：当前宿主没有暴露归档 API（导入本身已完成）",
        "pageSize": "每页",
        "search": "搜索",
        "previous": "上一页",
        "next": "下一页",
        "history.title": "导入历史",
        "history.empty": "尚无导入记录",
        "history.loading": "加载历史…",
        "history.purgeAll": "清空全部导入",
        "history.purgeAll.title": "删除本插件创建的全部导入会话（不可逆）",
        "history.purgeOne": "删除",
        "history.purgeOne.title": "删除该导入记录对应的 DSH 会话",
        "history.confirm.title": "确认删除",
        "history.confirm.all": "将删除 {n} 个本插件导入的会话及其工件，并清理空工作区。此操作不可撤销，确定继续？",
        "history.confirm.one": "将删除会话 {id} 及其工件。此操作不可撤销，确定继续？",
        "history.confirm.ok": "确认删除",
        "history.confirm.cancel": "取消",
        "history.purge.done": "删除完成：成功 {deleted}，失败 {failed}",
        "history.col.source": "来源路径",
        "history.col.session": "会话 ID",
        "history.col.time": "导入时间",
        "history.col.counts": "轮次/事件",
        "status.imported": "已导入",
        "status.partial": "部分",
        "status.archived": "已归档",
        "status.notImported": "未导入",
        "noTitle": "(无标题)",
        "count.messages": "{n} 条",
        "count.contextTokens": "上下文 {n}",
        "count.sessions": "{n} 个会话",
        "timeUnknown": "时间未知",
        "time.justNow": "刚刚",
        "time.minutesAgo": "{n} 分钟前",
        "time.hoursAgo": "{n} 小时前",
        "time.daysAgo": "{n} 天前",
        "noMatch": "没有匹配的会话",
        "noSessions": "没有找到会话",
        "loading": "正在准备扫描…",
        "scan.hint.start": "正在连接扫描…缓存命中通常几秒，首次全量可能十几秒到一分钟",
        // 底栏那一条的状态文案：扫描中报进度，完成后报页码与总数（两者合并显示）
        "scan.status.progress": "扫描中 · 已发现 {n} 个",
        // 底栏：页控件（点开是页码网格）+ 状态文案（扫描进度 / 总数）
        "page.jump": "第 {page} / {pages} 页",
        "page.jump.title": "点击选择页码",
        "count.total": "共 {n} 个",
        "pageSizeAll": "全部",
        "error.route": "导入失败：服务响应异常（路由可能未注册，请重启 dsh 后重试）",
        "error.import": "导入失败：{msg}",
        "error.load": "导入面板服务响应异常（路由可能未注册，请重启 dsh 后重试）",
        "ungrouped": "(未分组)",
        "multiSelect.title": "多选导入",
        "import.one": "导入",
        "import.one.title": "导入该会话（已导入则幂等跳过/续写）",
        "sync": "同步",
        "sync.title": "同步该会话：重读源文件并追加新增轮次（增量续写）",
        "group.expand": "展开该工作区分组",
        "group.collapse": "折叠该工作区分组",
        "result.imported": "新增 {n}",
        "result.replaced": "刷新 {n}",
        "result.appended": "续写 {n}",
        "result.already": "已存在 {n}",
        "result.skipped": "跳过 {n}",
        "result.failed": "失败 {n}",
        "result.separator": "，",
        "result.done": "导入完成：{bits}",
        "result.nochange": "无变化",
        "from": "从",
        "importTo": "导入到",
        "importTo.title": "选择落点：DSH 会话环境可继续对话；选其他工具则转换成它的格式落盘，不在 DSH 留副本",
        "combobox.search.target": "搜索目标…",
        "target.dsh": "DSH 会话环境",
        // 显式代次目标：宿主按 header.version 落盘，所以能真写出一条 V3 / V4 generation
        "target.dsh3": "DSH（V3 会话格式）",
        "target.dsh4": "DSH（V4 会话格式）",
        "target.claude": "Claude Code",
        "target.codex": "Codex",
        "target.kimi": "Kimi Code",
        "target.opencode": "opencode",
        "target.hint.claude": "写进 ~/.claude/projects/<项目>/，Claude Code 直接能读（claude --resume 打开）",
        "target.hint.codex": "写 Codex rollout JSONL 到 ~/.dsh/exports/，放进 Codex 的 sessions 目录即可",
        "target.hint.kimi": "写 Kimi wire.jsonl 到 ~/.dsh/exports/，放进 Kimi 的会话目录即可",
        "target.hint.opencode": "写 opencode JSON 到 ~/.dsh/exports/，再用 opencode import <文件> 导入",
        "transfer.done": "已转投 {n} 个会话到 {target}",
        "transfer.kept": "保留 {n} 个既有 DSH 会话",
        "transfer.purged": "已撤回 {n} 个中间会话",
        "tab.import": "导入",
        "tab.history": "历史",
        "tab.sync": "同步",
        "sync.panel.title": "双向同步",
        "sync.inbound": "外部 → DSH",
        "sync.outbound": "DSH → 外部",
        "sync.inbound.hint": "巡检 Claude / Codex / Grok 新增或增长的会话，增量导入到 DSH。",
        "sync.outbound.hint": "把 DSH 新增完整轮次写回对应 agent（导入源追加；原生会话落副本）。",
        "sync.interval": "间隔（秒）",
        "sync.run": "立即同步",
        "sync.running": "同步中…",
        "sync.save": "保存",
        "sync.enabled": "开启",
        "sync.disabled": "关闭",
        "sync.last": "上次：{when}",
        "sync.never": "尚未运行",
        "sync.timer.on": "定时器开",
        "sync.timer.off": "定时器关",
        "sync.excludeDirs": "排除目录",
        "sync.excludeDirs.hint": "逗号/换行分隔的绝对目录路径；其下会话（含子目录）不参与同步",
        "sync.result": "入站 扫 {scanned} / 新 {imported} / 续 {appended} / 跳 {skipped} / 败 {failed}；出站 写回 {synced} / 跳 {outSkipped} / 败 {outFailed}",
        "settings.systemPrompt.title": "导入系统提示词",
        "settings.systemPrompt.description": "把源会话的 system / developer 提示词作为「上下文注入」保留。默认开启：注入正文会附环境变更提示（工具、权限与执行指令以 DSH 当前会话为准），原文仅作参考附后；关闭后仅保留环境变更提示。",
        "settings.injectTools.title": "工具注入对话上下文",
        "settings.injectTools.description": "导入是低频需求：精简档（默认）只常驻 import_chat 入口工具，省约 4.5k 上下文；全量注入全部 13 个工具；关闭后对话内 Agent 看不到本插件工具，仍可通过 GUI「导入会话」面板完成转换。",
        "settings.injectTools.off": "关闭",
        "settings.injectTools.minimal": "精简",
        "settings.injectTools.full": "全量",
        "settings.sidebarButton.title": "侧边栏入口",
        "settings.sidebarButton.description": "在左侧栏底部显示「导入会话」快捷按钮；关闭后不在侧边栏显示，仍可通过右侧栏打开。",
        "settings.tab": "会话导入",
      },
      en: {
        "trigger.title": "Import sessions from other tools (discover + single/multi select)",
        "trigger.label": "Import Sessions",
        "sidebar.guide.description": "Import and resume sessions from Claude Code, Codex, ChatGPT and 25+ tools",
        "source": "Source",
        "allSources": "All sources",
        "source.dsh": "DSH V3 session format",
        "source.dsh4": "DSH V4 session format",
        "source.title": "Filter by external tool; changing source rescans",
        "workspace": "Workspace",
        "filter.path": "Filter: path",
        "filter.time": "Filter: time",
        "filter.all": "All",
        "filter.time.all": "Any time",
        "filter.time.24h": "24 hours",
        "filter.time.7d": "7 days",
        "filter.time.30d": "30 days",
        "noWorkspace": "No workspace",
        "workspace.title": "Show only sessions in this workspace (AND with search)",
        "combobox.search.source": "Search sources…",
        "combobox.search.workspace": "Search workspaces…",
        "combobox.noMatch": "No matches",
        "clearSearch": "Clear",
        "search.placeholder": "Search title / workspace / path…",
        "selectAll": "Select all",
        "deselectAll": "Clear selection",
        "clearSelection": "Clear",
        "toast.skipped": "Skipped {n} conversation(s) that may already be imported",
        "toast.ignore": "Ignore warning",
        "selectImportable": "Select unimported",
        "selectImported": "Select imported",
        "refresh": "Refresh",
        "refresh.title": "Rescan; unchanged files reuse scan-cache and finish in seconds",
        "importing": "Importing…",
        "import.selected": "Import selected ({n})",
        "import.selectedArchive": "Import selected and archive old sessions ({n})",
        "import.selectedArchive.short": "Import & archive ({n})",
        "import.selectedArchive.title": "Import the selected sessions in the target generation and archive the matching source sessions in the host",
        "archive.done": "Archived {n} old session(s)",
        "archive.skipped": "{n} old session(s) left unarchived: their import did not succeed (skipped or failed), so the originals stay as they are",
        "archive.unsupported": "Old sessions not archived: this host exposes no archive API (the import itself completed)",
        "pageSize": "Per page",
        "search": "Search",
        "previous": "Previous",
        "next": "Next",
        "history.title": "Import history",
        "history.empty": "No imports recorded yet",
        "history.loading": "Loading history…",
        "history.purgeAll": "Remove all imports",
        "history.purgeAll.title": "Delete every session created by this plugin (irreversible)",
        "history.purgeOne": "Remove",
        "history.purgeOne.title": "Delete the DSH session for this import record",
        "history.confirm.title": "Confirm deletion",
        "history.confirm.all": "This will delete {n} plugin-imported sessions and their artifacts, and clean up empty workspaces. This cannot be undone. Continue?",
        "history.confirm.one": "This will delete session {id} and its artifacts. This cannot be undone. Continue?",
        "history.confirm.ok": "Delete",
        "history.confirm.cancel": "Cancel",
        "history.purge.done": "Removal done: {deleted} succeeded, {failed} failed",
        "history.col.source": "Source path",
        "history.col.session": "Session ID",
        "history.col.time": "Imported at",
        "history.col.counts": "Turns/events",
        "status.imported": "Imported",
        "status.partial": "Partial",
        "status.archived": "Archived",
        "status.notImported": "Not imported",
        "noTitle": "(untitled)",
        "count.messages": "{n} messages",
        "count.contextTokens": "{n} tokens",
        "count.sessions": "{n} sessions",
        "timeUnknown": "Time unknown",
        "time.justNow": "just now",
        "time.minutesAgo": "{n}m ago",
        "time.hoursAgo": "{n}h ago",
        "time.daysAgo": "{n}d ago",
        "noMatch": "No matching sessions",
        "noSessions": "No sessions found",
        "loading": "Preparing scan…",
        "scan.hint.start": "Connecting… cache hits usually take seconds; first full scan may take 15s–1min",
        "scan.status.progress": "Scanning · {n} found",
        "page.jump": "Page {page} / {pages}",
        "page.jump.title": "Pick a page",
        "count.total": "{n} total",
        "pageSizeAll": "All",
        "error.route": "Import failed: the service route is unavailable (the route may not be registered — restart dsh and retry)",
        "error.import": "Import failed: {msg}",
        "error.load": "Panel failed to load: the service route is unavailable (the route may not be registered — restart dsh and retry)",
        "ungrouped": "(unassigned)",
        "multiSelect.title": "Multi-select import",
        "import.one": "Import",
        "import.one.title": "Import this session (idempotent skip / append if already imported)",
        "sync": "Sync",
        "sync.title": "Sync this session: re-read the source file and append new turns (incremental)",
        "group.expand": "Expand this workspace group",
        "group.collapse": "Collapse this workspace group",
        "result.imported": "{n} imported",
        "result.replaced": "{n} refreshed",
        "result.appended": "{n} appended",
        "result.already": "{n} already existed",
        "result.skipped": "{n} skipped",
        "result.failed": "{n} failed",
        "result.separator": ", ",
        "result.done": "Import done: {bits}",
        "result.nochange": "no change",
        "from": "From",
        "importTo": "Import to",
        "importTo.title": "Where the imported conversation lands: DSH sessions stay resumable; other targets are converted into that tool's own format (no DSH copy left behind)",
        "combobox.search.target": "Search targets…",
        "target.dsh": "DSH session",
        "target.dsh3": "DSH (V3 session format)",
        "target.dsh4": "DSH (V4 session format)",
        "target.claude": "Claude Code",
        "target.codex": "Codex",
        "target.kimi": "Kimi Code",
        "target.opencode": "opencode",
        "target.hint.claude": "Writes into ~/.claude/projects/<project>/ — Claude Code reads it directly (open with claude --resume)",
        "target.hint.codex": "Writes a Codex rollout JSONL into ~/.dsh/exports/; move it into Codex's sessions directory",
        "target.hint.kimi": "Writes a Kimi wire.jsonl into ~/.dsh/exports/; move it into Kimi's sessions directory",
        "target.hint.opencode": "Writes opencode JSON into ~/.dsh/exports/; import it with `opencode import <file>`",
        "transfer.done": "Transferred {n} conversation(s) to {target}",
        "transfer.kept": "kept {n} existing DSH session(s)",
        "transfer.purged": "removed {n} intermediate session(s)",
        "tab.import": "Import",
        "tab.history": "History",
        "tab.sync": "Sync",
        "sync.panel.title": "Two-way sync",
        "sync.inbound": "External → DSH",
        "sync.outbound": "DSH → External",
        "sync.inbound.hint": "Watch Claude / Codex / Grok for new or grown sessions and import incrementally.",
        "sync.outbound.hint": "Write new complete DSH turns back to the matching agent (append source, or create a copy).",
        "sync.interval": "Interval (sec)",
        "sync.run": "Sync now",
        "sync.running": "Syncing…",
        "sync.save": "Save",
        "sync.enabled": "On",
        "sync.disabled": "Off",
        "sync.last": "Last: {when}",
        "sync.never": "Never ran",
        "sync.timer.on": "Timer on",
        "sync.timer.off": "Timer off",
        "sync.excludeDirs": "Exclude dirs",
        "sync.excludeDirs.hint": "Comma/newline-separated absolute dirs; sessions under them (incl. subdirs) are skipped",
        "sync.result": "In scanned {scanned} / new {imported} / append {appended} / skip {skipped} / fail {failed}; out wrote {synced} / skip {outSkipped} / fail {outFailed}",
        "settings.systemPrompt.title": "Import system prompt",
        "settings.systemPrompt.description": "Keep the source session's system/developer prompt as a \"context injection\". On by default: the injected body carries a note that the environment changed and tools, permissions, and instructions now follow DSH, with the original prompt appended for reference; turn off to keep only the note.",
        "settings.injectTools.title": "Tool injection into conversation context",
        "settings.injectTools.description": "Import is a low-frequency need: Minimal (default) keeps only the import_chat entry tool resident, saving ~4.5k tokens of context; Full injects all 13 tools; Off hides this plugin's tools from the in-conversation agent — the Import Sessions panel still works.",
        "settings.injectTools.off": "Off",
        "settings.injectTools.minimal": "Minimal",
        "settings.injectTools.full": "Full",
        "settings.sidebarButton.title": "Sidebar Entry",
        "settings.sidebarButton.description": "Show the 'Import Sessions' quick button at the bottom of the left sidebar; when disabled, the button is hidden from the sidebar and remains accessible via the right sidebar.",
        "settings.tab": "Session Import",
      },
    };

    // 模板参数填充：{name} → params[name]（locale 服务 translate 内部同款；fallback 用）。
    function fill(text, params) {
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }

    // locale 服务（ctx.get('locale')，apply 时设置；缺失时 UI 降级 zh 字典）。
    let localeSvc = null;

    const IMPORT_TAB_TYPE = "chat-import";
    // 官方原生右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right，DSH ≥ 0.1.5-rc.1，
    // peerDependencies 已抬升门槛）的打开面：footer 按钮点击时经
    // ctx.get('sidebarRight').openTab(kind) 打开「导入会话」tab（同一时刻展开右栏、
    // 对话区保留——接入侧栏接口而非覆盖主区）。闭包在 apply 里建立、点击时重证服务
    //（无挂载会话 / HMR 换服务等返回 false，对齐 dsh-context 的 openContextSidebar
    // 每次调用时重证的做法）。
    let openNativeImportTab = null;
    // 侧边栏入口按钮开关（设置项 sidebarButton）：默认 true。
    // 经 localStorage 同步缓存避免初次渲染出现闪烁；通过事件监听在设置页修改时即刻生效。
    const SIDEBAR_PREF_KEY = "dsh-chat-import:sidebar-button";
    function getStoredSidebarButton() {
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          const val = window.localStorage.getItem(SIDEBAR_PREF_KEY);
          if (val === "false") return false;
        }
      } catch (_) {}
      return true;
    }
    let cachedSidebarButton = getStoredSidebarButton();
    const sidebarButtonListeners = new Set();
    function setSidebarButton(enabled) {
      cachedSidebarButton = enabled !== false;
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(SIDEBAR_PREF_KEY, String(cachedSidebarButton));
        }
      } catch (_) {}
      for (const listener of sidebarButtonListeners) {
        try { listener(cachedSidebarButton); } catch (_) {}
      }
    }
    // 组件侧翻译 hook：订阅 locale/change 触发重渲染；无服务时查 zh 字典兜底。
    function useTranslate() {
      const [, force] = useState(0);
      useEffect(() => {
        if (!localeSvc) return undefined;
        return localeSvc.subscribe(() => force((x) => x + 1));
      }, []);
      return (key, params) => {
        if (!localeSvc) return fill(DICT.zh[key] || key, params);
        return localeSvc.bind(LOCALE_NS)(key, params);
      };
    }

    // 来源下拉（'' = 全部来源；与 lib/discovery.mjs 的 FORMATS 对应，claude-code →
    // claude）。chatgpt 无默认数据根，仅显式 path 可发现。
    const SOURCES = [
      // DSH 两代置顶（紧随「全部来源」）：这是本插件自己的会话格式，最常被用来做迁移/续聊
      "", "dsh", "dsh4", "claude-code", "codex", "chatgpt", "cursor", "gemini", "antigravity", "reasonix",
      "opencode", "mimocode", "teleagent", "kilocode", "zcode", "grokbuild", "openclaw", "pi", "hermes", "kimi", "qoder", "workbuddy", "qwen", "continue", "cline", "goose", "zed", "crush",
    ];
    // 「导入到」下拉：'dsh' = 照常建可继续的 DSH 会话（默认）；其余 = 转投到该工具自己的
    // 格式（服务端 lib/transfer.mjs，与 export_chat 的目标保持一致）。值顺序 = 展示顺序。
    // 「导入到」下拉：dsh3 / dsh4 = 建指定代次的 DSH 会话日志（宿主按 header.version 落盘），
    // 默认项由探测到的宿主版本决定（面板在首个扫描响应里带回 dshVersion）。其余值 = 转投。
    const IMPORT_TARGETS = ["dsh3", "dsh4", "claude", "codex", "kimi", "opencode"];
    // discovery format 短名 → 客户端来源 id（构建 /api-import/import 的 items）。
    const FORMAT_SOURCE = {
      claude: "claude-code", codex: "codex", chatgpt: "chatgpt", cursor: "cursor",
      gemini: "gemini", antigravity: "antigravity", reasonix: "reasonix", opencode: "opencode", mimocode: "mimocode", teleagent: "teleagent", kilocode: "kilocode", zcode: "zcode",
      grokbuild: "grokbuild", openclaw: "openclaw", pi: "pi", hermes: "hermes",
      kimi: "kimi", qoder: "qoder", workbuddy: "workbuddy", qwen: "qwen", continue: "continue", cline: "cline", goose: "goose", zed: "zed", crush: "crush", dsh: "dsh", dsh4: "dsh4",
    };
    // 来源展示名（产品名不翻译）
    const SOURCE_LABELS = {
      "claude-code": "Claude", codex: "Codex", chatgpt: "ChatGPT", cursor: "Cursor",
      gemini: "Gemini CLI", antigravity: "Antigravity", reasonix: "Reasonix", opencode: "OpenCode", mimocode: "MimoCode",
      teleagent: "TeleAgent",
      kilocode: "Kilo Code",
      zcode: "ZCode", grokbuild: "Grok Build", openclaw: "OpenClaw", pi: "Pi",
      hermes: "Hermes", kimi: "Kimi CLI", qoder: "Qoder CLI", workbuddy: "WorkBuddy",
      qwen: "QwenWork", continue: "Continue", cline: "Cline", goose: "Goose", zed: "Zed", crush: "Crush",
      // DSH 按会话日志代次拆两项（与 discovery 的 format 一一对应）：V0–V3 归 "dsh"，V4+ 归 "dsh4"。
      // 这里是中性短名（会话行提示/aria 用）；下拉里的完整展示名（「DSH V3 会话格式」）走 i18n。
      dsh: "DSH V3", dsh4: "DSH V4",
    };
    // 来源 id → 标键（SOURCE_LOGOS / SOURCE_BADGES 都按 discovery format 短名键控，
    // claude-code 的键是 claude；其余同名。两个表都查不到时由 BrandMark 按首字母兜底）。
    // 来源 id → 品牌标键：claude-code 的标键是 claude；dsh4（DSH V4）与 dsh 共用同一个 DSH 标
    const SOURCE_MARK_KEY = { "claude-code": "claude", dsh4: "dsh" };
    // 只有连项目仓库里都没有可用矢量标的来源才在这里手绘（有官方标的走 SOURCE_LOGOS，见
    // logos.js）：白色圆角卡 + 品牌标 / 品牌色缩写。目前只剩 WorkBuddy（原仓库已不可达）、
    // TeleAgent（TeleAI 产品页无矢量标）、Crush（仓库里只有演示 GIF / PNG，没有矢量标）。
    // SVG 字符串为静态受信标记，经 dangerouslySetInnerHTML 注入。
    const SOURCE_BADGES = {
      workbuddy: { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 280 280\" width=\"100%\" height=\"100%\">\n<g clip-path=\"url(#clip0_744_3208)\">\n<rect width=\"280\" height=\"280\" rx=\"60.4211\" fill=\"url(#paint0_linear_744_3208)\"/>\n<g filter=\"url(#filter0_f_744_3208)\">\n<circle cx=\"88.2504\" cy=\"244.86\" r=\"98.5668\" fill=\"#32E6B9\" fill-opacity=\"0.4\"/>\n</g>\n<g filter=\"url(#filter1_f_744_3208)\">\n<circle cx=\"223.384\" cy=\"290.328\" r=\"90.0931\" fill=\"#FFE355\" fill-opacity=\"0.49\"/>\n</g>\n<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M204.15 6.89352C206.896 4.43111 207.061 4.33611 209.074 4.21524C212.336 3.97692 215.324 5.54248 220.41 10.1729C232.291 20.9692 248.834 43.1654 259.119 62.1205L263.093 69.4768L268.707 72.2672C274.126 75.0055 283.015 80.6198 286.728 83.6308C288.407 85.0191 288.642 85.0483 290.388 84.3692C298.267 81.3008 309.553 85.3675 319.508 94.9178C328.47 103.507 337.052 118.181 340.34 130.429C340.82 132.4 341.458 136.638 341.69 139.794C342.44 150.876 338.886 159.726 332.042 163.733C330.644 164.54 330.551 164.759 330.59 168.245C330.905 184.841 326.432 201.406 317.445 217.561C307.301 235.7 289.238 254.464 264.791 272.142C251.663 281.695 220.604 299.792 206.561 306.145C172.92 321.29 145.952 327.1 122.527 324.23C108.554 322.537 92.7397 317.083 83.3819 310.752C80.9182 309.049 80.5286 308.944 78.6462 309.483C68.6285 312.36 55.5086 306.447 44.3628 294.075C39.9174 289.129 32.743 276.986 30.417 270.488C25.0365 255.281 26.1061 241.558 33.273 233.363C35.1245 231.252 35.1835 231.163 34.7791 227.614C34.1112 221.804 33.808 213.206 34.1131 207.656L34.3541 202.472L26.5713 188.706C14.5194 167.262 6.8648 149.255 3.91152 135.497C2.35249 127.954 2.44923 124.607 4.36401 122.131C5.52945 120.635 9.35191 119.087 13.9599 118.236C25.5602 116.199 50.8596 118.043 79.0059 123.012L81.9295 123.517L88.3537 117.834C99.0194 108.386 106.105 103.089 119.168 94.9439C132.783 86.4254 148.148 79.4181 165.452 73.8693L171.004 72.09L174.054 64.0775C184.981 35.233 196.172 13.9675 204.15 6.89352ZM112.625 154.702C100.275 161.832 94.0999 165.397 89.5627 169.393C71.1894 185.572 64.3228 211.198 72.145 234.396C74.0767 240.125 77.642 246.3 84.7719 258.65C91.9018 270.999 95.4667 277.173 99.4619 281.711C115.641 300.084 141.267 306.95 164.466 299.128C170.194 297.197 176.369 293.631 188.719 286.501L259.76 245.486C272.109 238.356 278.284 234.791 282.821 230.796C301.194 214.617 308.061 188.99 300.239 165.792C298.307 160.063 294.742 153.889 287.612 141.54C280.482 129.19 276.917 123.015 272.922 118.478C256.743 100.104 231.116 93.2378 207.918 101.06C202.19 102.992 196.015 106.557 183.666 113.687L112.625 154.702Z\" fill=\"url(#paint1_linear_744_3208)\"/>\n<rect x=\"119.473\" y=\"204.341\" width=\"28.0633\" height=\"58.2852\" rx=\"14.0316\" transform=\"rotate(-30 119.473 204.341)\" fill=\"white\"/>\n<rect x=\"195.186\" y=\"160.627\" width=\"28.0633\" height=\"58.2852\" rx=\"14.0316\" transform=\"rotate(-30 195.186 160.627)\" fill=\"white\"/>\n</g>\n<defs>\n<filter id=\"filter0_f_744_3208\" x=\"-104.414\" y=\"52.1958\" width=\"385.327\" height=\"385.328\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"47.0486\" result=\"effect1_foregroundBlur_744_3208\"/>\n</filter>\n<filter id=\"filter1_f_744_3208\" x=\"56.2884\" y=\"123.233\" width=\"334.191\" height=\"334.192\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"38.5013\" result=\"effect1_foregroundBlur_744_3208\"/>\n</filter>\n<linearGradient id=\"paint0_linear_744_3208\" x1=\"140\" y1=\"0\" x2=\"140\" y2=\"280\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"#0EC8A9\"/>\n<stop offset=\"1\" stop-color=\"#01C886\"/>\n</linearGradient>\n<linearGradient id=\"paint1_linear_744_3208\" x1=\"106.647\" y1=\"62.5482\" x2=\"237.632\" y2=\"289.42\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"white\" stop-opacity=\"0.8\"/>\n<stop offset=\"0.437689\" stop-color=\"white\"/>\n</linearGradient>\n<clipPath id=\"clip0_744_3208\">\n<rect width=\"280\" height=\"280\" rx=\"60.4211\" fill=\"white\"/>\n</clipPath>\n</defs>\n</svg>\n" },
    };
    // Crush 同为缩写卡（与 assets/agents/crush.svg 同款）
    SOURCE_BADGES.crush = { color: "#5A56E0", text: "Cr" };
    // TeleAgent（星辰超级智能体）无公开矢量品牌标 → 缩写卡（与 assets/agents/teleagent.svg 同款）
    SOURCE_BADGES.teleagent = { color: "#0B57D0", text: "TA" };
    // 品牌标查询（lobehub 官方标优先）：SOURCE_LOGOS 在 logos.js 声明，两个表都按 discovery
    // format 短名键控，所以 source id 要先过 SOURCE_MARK_KEY（claude-code → claude）。
    // 返回 null = 这个来源没有官方品牌标，调用方回退 SOURCE_BADGES 的手绘卡。
    const sourceLogo = (key) => SOURCE_LOGOS[SOURCE_MARK_KEY[key] || key] || null;
    // format 短名 → 来源展示名（徽标 title/aria 用）
    const sourceLabel = (format) => SOURCE_LABELS[FORMAT_SOURCE[format]] || format;
    // 分页大小选项（客户端窗口切片；翻页零重扫）
    // 每页条数档位。列表按可视区窗口化渲染（discovery.js），每档只挂载可见的十几行，
    // 实测（React 生产构建、缓冲 3000 条、视口约 16 行）：100 / 500 / 1000 / 2000 档的
    // 换页成本都是 1.1–1.5ms React+DOM + ~0.1ms 布局、DOM 恒为 19 行 / ~360 节点
    //（窗口化之前 500 档要 31ms+21ms、6287 节点，2000 档要 73ms+61ms、24723 节点）。
    // 所以档位尽量给大：翻页次数少了，成本并不增加。
    // 「全部」档 = 不分页。列表窗口化后渲染成本与档位无关（10 万行实测 DOM 恒为 19 行），
    // 代价只有两条：滚动条会很长（10 万行 ≈ 290 万 px），以及常驻内存 ≈1KB/会话。
    const ALL_PAGE_SIZE = "all";
    // 「筛选：时间」档位（'' = 不筛选）；按会话最后活跃（缺省创建时间）落在窗口内过滤
    const TIME_FILTERS = ["", "24h", "7d", "30d"];
    const TIME_FILTER_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
    const PAGE_SIZES = [500, 2000, ALL_PAGE_SIZE];
    // 窄宽阈值：侧边栏可拖宽，面板宽度低于此值时工具栏/分页按钮降级为图标、
    // 页码压缩为「当前页/总页」，搜索/清除按钮只留图标。
    const NARROW_MAX_WIDTH = 400;
    // 时间倒序比较（对齐服务端 discoverSessions 的 lastActiveAt 降序）：
    // 流式期间缓冲按发现顺序纯追加（行不跳动、页面稳定），扫描完成时一次性重排
    //（单次排序事件之后恒定——不做每块全量重排，巨库加载不再占主线程）
    const byTimeDesc = (a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0);

    // Agent 品牌标（mark）与品牌字标（wordmark）：18 个取自 @lobehub/icons 的静态 SVG 包
    //（MIT），5 个取自项目自己的仓库——ChatGPT 用 lobehub 的 OpenAI 标、MimoCode 用 lobehub 的
    // XiaomiMiMo 标，Reasonix / Continue / Zed 从各自仓库的官方标取（商标归各自权利人）。
    // 生成物，勿手改——由 scripts/gen-logos.mjs 生成（增删来源或上游换标时重跑）。
    // 键与 SOURCE_BADGES 同口径（discovery format 短名）。生成时已把每个标的 ink 包围盒
    // 归一化：mark 等比缩放进 24×24 里的 22 单位方框并居中（上游的标并不都画满 viewBox，
    // 不归一化会大小不一），word 的 ink 高度统一为 22 单位、viewBox 宽度收紧到 ink 宽度。
    // 两者都是完整的内联 <svg>：viewBox 保留，高度交给 CSS 的 1em，宽度按比例。
    // word 为 null = 该品牌没有字标（Pi 等），或字标拼的不是我们展示的名字（Hermes /
    // ZCode / DSH 展示的是工具名而非厂商名），此时用品牌标 + 我们自己的标签文本。
    // svg 是静态受信标记，经 dangerouslySetInnerHTML 注入。
    const SOURCE_LOGOS = {
      claude: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\"><path d=\"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z\" fill=\"#D97757\" fill-rule=\"nonzero\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 93 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 1) scale(1)\" fill=\"currentColor\" fill-rule=\"nonzero\"><path d=\"M13.623 20.222c-3.417 0-5.753-1.901-6.855-4.827a12.992 12.992 0 01-.838-4.772c0-4.907 2.206-8.315 7.08-8.315 3.275 0 5.297 1.425 6.448 4.826h1.402l-.19-4.69C18.709 1.18 16.258.543 13.276.543c-4.2 0-7.775 1.874-9.763 5.254a11.357 11.357 0 00-1.511 5.872c0 3.753 1.777 7.08 5.113 8.926a11.95 11.95 0 005.943 1.398c3.254 0 5.835-.617 8.122-1.697l.593-5.172h-1.43c-.858 2.362-1.88 3.78-3.574 4.534-.831.373-1.88.564-3.146.564zm14.74-17.914L28.499 0h-.967L23.23 1.29v.699l1.907.882v16.142c0 1.1-.565 1.344-2.043 1.528v1.18h7.319v-1.18c-1.484-.184-2.042-.428-2.042-1.528V2.315l-.007-.007zm29.104 19.685h.565l4.95-.937v-1.208l-.695-.054c-1.157-.109-1.457-.346-1.457-1.29V9.897l.137-2.763h-.783l-4.678.672v1.181l.457.082c1.266.183 1.64.536 1.64 1.419v7.67c-1.212.937-2.369 1.527-3.744 1.527-1.525 0-2.471-.774-2.471-2.58V9.905l.136-2.763h-.804l-4.684.672v1.181l.484.082c1.266.183 1.64.536 1.64 1.418v7.08c0 3 1.703 4.426 4.412 4.426 2.07 0 3.765-1.1 5.038-2.627L57.474 22l-.007-.007zm-13.602-9.55c0-3.836-2.043-5.309-5.733-5.309-3.254 0-5.616 1.344-5.616 3.57 0 .666.238 1.175.721 1.528l2.478-.326c-.109-.746-.163-1.201-.163-1.391 0-1.263.674-1.901 2.042-1.901 2.022 0 3.044 1.419 3.044 3.7v.746l-5.106 1.527c-1.702.462-2.67.863-3.316 1.8a3.386 3.386 0 00-.476 1.9c0 2.172 1.497 3.706 4.057 3.706 1.852 0 3.493-.835 4.922-2.416.51 1.581 1.294 2.416 2.69 2.416 1.13 0 2.15-.455 3.063-1.344l-.272-.937a4.363 4.363 0 01-1.178.163c-.783 0-1.157-.617-1.157-1.826v-5.607zm-6.536 7.378c-1.396 0-2.26-.808-2.26-2.226 0-.964.456-1.528 1.43-1.854l4.139-1.31v3.965c-1.321.997-2.097 1.425-3.31 1.425zm43.095 1.235v-1.208l-.701-.054c-1.158-.109-1.45-.346-1.45-1.29V2.308L78.409 0h-.974l-4.302 1.29v.699l1.906.882V8.18a6.024 6.024 0 00-3.656-1.046c-4.276 0-7.612 3.245-7.612 8.098 0 3.998 2.397 6.761 6.346 6.761 2.042 0 3.819-.99 4.922-2.525l-.136 2.525h.571l4.95-.937zm-8.96-12.313c2.043 0 3.575 1.181 3.575 3.353v6.11a4.91 4.91 0 01-3.547 1.425c-2.928 0-4.412-2.308-4.412-5.39 0-3.462 1.695-5.498 4.385-5.498zm19.424 3.055c-.381-1.792-1.484-2.81-3.016-2.81-2.288 0-3.874 1.717-3.874 4.18 0 3.646 1.934 6.008 5.059 6.008a5.858 5.858 0 005.03-2.953l.913.245c-.408 3.163-3.281 5.525-6.808 5.525-4.14 0-6.992-3.054-6.992-7.399 0-4.378 3.098-7.46 7.237-7.46 3.09 0 5.27 1.853 5.97 5.07l-10.783 3.3V14.05l7.264-2.247v-.006z\"></path></g></svg>" },
      codex: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\"><path d=\"M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z\" fill=\"#fff\"></path><path d=\"M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z\" fill=\"url(#lobe-icons-codex-_R_0_)\"></path><defs><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lobe-icons-codex-_R_0_\" x1=\"12\" x2=\"12\" y1=\"3\" y2=\"21\"><stop stop-color=\"#B1A7FF\"></stop><stop offset=\".5\" stop-color=\"#7A9DFF\"></stop><stop offset=\"1\" stop-color=\"#3941FF\"></stop></linearGradient></defs></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 86.9 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 0) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M79.915 14.964l-5.53-7.548h3.33l3.88 5.256 3.88-5.256h3.24l-5.5 7.486 5.683 7.792h-3.361l-4.003-5.5-4.064 5.5H74.2l5.715-7.73zM66.368 23c-1.345 0-2.567-.326-3.667-.978-1.08-.652-1.935-1.579-2.567-2.78-.631-1.203-.947-2.608-.947-4.217 0-1.59.316-2.974.947-4.156.652-1.202 1.518-2.129 2.597-2.78 1.08-.652 2.272-.978 3.575-.978 1.813 0 3.33.55 4.553 1.65 1.222 1.1 1.956 2.597 2.2 4.491.082.693.112 1.477.092 2.353H62.09c.06 1.548.489 2.76 1.283 3.636.815.876 1.793 1.314 2.933 1.314h.184c.855 0 1.599-.224 2.23-.672.632-.448 1.06-1.06 1.284-1.833h2.933a6.147 6.147 0 01-2.322 3.575C69.433 22.54 68.018 23 66.368 23zm3.819-9.687c-.082-1.16-.469-2.077-1.161-2.75-.693-.692-1.558-1.038-2.597-1.038h-.214c-.978 0-1.844.315-2.597.947-.734.611-1.212 1.558-1.437 2.841h8.006zM47.834 23c-1.324 0-2.516-.326-3.575-.978-1.039-.652-1.854-1.579-2.444-2.78-.591-1.202-.887-2.598-.887-4.187 0-1.588.306-2.984.917-4.186.611-1.201 1.446-2.128 2.506-2.78 1.08-.652 2.281-.978 3.605-.978 1.08 0 2.047.224 2.903.672.855.449 1.497 1.019 1.925 1.711V1.306h2.903v21.388h-2.903v-2.108c-.408.672-1.06 1.242-1.956 1.711-.896.469-1.894.703-2.994.703zm.58-2.475c.856 0 1.62-.234 2.292-.703.672-.468 1.192-1.11 1.558-1.925.387-.835.58-1.782.58-2.841 0-1.06-.193-1.997-.58-2.812-.366-.835-.886-1.487-1.558-1.955a3.911 3.911 0 00-2.292-.703h-.183c-1.304 0-2.363.51-3.178 1.528-.794 1.018-1.191 2.332-1.191 3.941 0 1.61.397 2.924 1.191 3.942.815 1.019 1.874 1.528 3.178 1.528h.183zM31.022 23c-1.406 0-2.679-.337-3.82-1.009a7.367 7.367 0 01-2.688-2.841c-.652-1.223-.978-2.587-.978-4.095 0-1.507.326-2.862.978-4.064.651-1.222 1.548-2.17 2.688-2.841 1.141-.693 2.414-1.04 3.82-1.04 1.405 0 2.668.347 3.789 1.04 1.14.672 2.037 1.62 2.688 2.841.652 1.202.978 2.557.978 4.064 0 1.508-.326 2.872-.977 4.095a7.367 7.367 0 01-2.69 2.841C33.69 22.663 32.428 23 31.023 23zm.06-2.476c.857 0 1.62-.224 2.293-.672.672-.468 1.201-1.11 1.589-1.925.386-.835.58-1.792.58-2.872 0-1.08-.194-2.027-.58-2.841-.388-.836-.917-1.477-1.59-1.925a3.911 3.911 0 00-2.291-.703H30.9c-1.304 0-2.373.51-3.209 1.528-.814.998-1.222 2.312-1.222 3.941 0 1.63.407 2.954 1.222 3.972.835.998 1.905 1.497 3.209 1.497h.183zM12.053 23c-2.037 0-3.82-.469-5.348-1.406-1.507-.957-2.668-2.271-3.483-3.941S2 14.098 2 12c0-2.098.407-3.982 1.222-5.653.835-1.67 2.017-2.974 3.545-3.91C8.294 1.478 10.057 1 12.053 1c1.609 0 3.055.316 4.338.947 1.304.611 2.363 1.477 3.178 2.597.815 1.1 1.304 2.374 1.467 3.82h-3.117c-.244-1.365-.876-2.465-1.894-3.3-1.019-.856-2.302-1.283-3.85-1.283h-.245c-1.385 0-2.597.356-3.636 1.069-1.039.713-1.833 1.69-2.383 2.933-.55 1.243-.825 2.648-.825 4.217 0 1.568.275 2.974.825 4.216.55 1.243 1.344 2.22 2.383 2.934 1.04.713 2.251 1.07 3.636 1.07h.245c1.548 0 2.831-.418 3.85-1.254 1.039-.855 1.68-1.976 1.925-3.36h3.086c-.184 1.446-.683 2.729-1.497 3.85-.795 1.12-1.844 1.996-3.148 2.627-1.303.611-2.75.917-4.338.917z\"></path></g></svg>" },
      cursor: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1.0046 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 130.9 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2.2 -1.2) scale(1.1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M11.995 2.33h6.516v3.582h-6.295C8.82 5.912 6.169 7.868 6.169 12c0 4.133 2.65 6.089 6.047 6.089h6.295v3.581H11.72C6.03 21.67 2 18.336 2 12c0-6.337 4.307-9.67 9.995-9.67zm9.829 0h4.03V14.15c0 2.947 1.354 4.325 4.53 4.325 3.175 0 4.528-1.377 4.528-4.325V2.33h4.03v12.644c0 4.297-2.733 7.025-8.559 7.025-5.826 0-8.56-2.755-8.56-7.052V2.33zm38.185 5.483c0 2.149-1.243 3.801-2.9 4.518v.055c1.74.248 2.624 1.488 2.65 3.169l.084 6.115h-4.031l-.083-5.454c-.027-1.212-.745-1.956-2.181-1.956h-6.71v7.41h-4.03V2.33h11.127c3.644 0 6.074 1.846 6.074 5.483zm-4.059.55c0-1.652-.883-2.561-2.54-2.561H46.84v5.123h6.626c1.518 0 2.485-.909 2.485-2.562zm19.3 7.66c0-1.378-.884-1.957-2.209-2.067l-4.473-.413c-3.866-.358-5.881-1.873-5.881-5.537 0-3.664 2.485-5.675 6.046-5.675h9.885V5.8h-9.609c-1.38 0-2.263.717-2.263 2.094 0 1.378.91 2.039 2.291 2.15l4.556.385c3.452.303 5.715 1.874 5.715 5.565 0 3.691-2.402 5.675-5.798 5.675H63.184V18.2h9.94c1.297 0 2.126-.882 2.126-2.177zM91.097 2c6.074 0 9.912 3.884 9.912 9.972C101.01 18.061 97.006 22 90.932 22s-9.912-3.94-9.912-10.028C81.02 5.884 85.024 2 91.098 2zm5.743 10c0-4.077-2.374-6.474-5.826-6.474-3.451 0-5.826 2.397-5.826 6.474s2.375 6.473 5.826 6.473c3.452 0 5.826-2.396 5.826-6.473zM121 7.813c0 2.149-1.242 3.801-2.899 4.518v.055c1.739.248 2.623 1.488 2.65 3.169l.083 6.115h-4.031l-.083-5.454c-.027-1.212-.745-1.956-2.181-1.956h-6.709v7.41h-4.031V2.33h11.127c3.645 0 6.074 1.846 6.074 5.483zm-4.059.55c0-1.652-.883-2.561-2.54-2.561h-6.571v5.123h6.626c1.518 0 2.485-.909 2.485-2.562z\"></path></g></svg>" },
      gemini: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\"><path d=\"M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z\" fill=\"url(#lobe-icons-gemini-cli-_R_0_)\"></path><path clip-rule=\"evenodd\" d=\"M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z\" fill=\"#1E1E2E\" fill-rule=\"evenodd\"></path><defs><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lobe-icons-gemini-cli-_R_0_\" x1=\"24\" x2=\"0\" y1=\"6.587\" y2=\"16.494\"><stop stop-color=\"#EE4D5D\"></stop><stop offset=\".328\" stop-color=\"#B381DD\"></stop><stop offset=\".476\" stop-color=\"#207CFE\"></stop></linearGradient></defs></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 147.76 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 0) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M146.467 1.472h3.294V22.53h-3.294V1.472zM130.814 1.472h3.294v17.911h9.029v3.147h-12.323V1.472zM118.754 23c-2.039 0-3.902-.48-5.588-1.442a10.433 10.433 0 01-3.971-3.97c-.961-1.686-1.441-3.549-1.441-5.588 0-2.04.48-3.902 1.441-5.588a10.434 10.434 0 013.971-3.97C114.852 1.48 116.715 1 118.754 1c1.588 0 3.029.294 4.323.882a10.234 10.234 0 013.471 2.56l-2.353 2.264c-.726-.863-1.529-1.5-2.412-1.912-.882-.431-1.892-.647-3.029-.647-1.412 0-2.706.324-3.882.97-1.157.648-2.079 1.57-2.765 2.765-.686 1.177-1.03 2.55-1.03 4.118 0 1.568.344 2.95 1.03 4.147a7.258 7.258 0 002.765 2.735c1.176.647 2.47.97 3.882.97 2.353 0 4.353-.98 6-2.94l2.382 2.294A10.73 10.73 0 01123.46 22c-1.432.666-3 1-4.706 1zM96.321 5.353a2.177 2.177 0 01-1.559-.618 2.177 2.177 0 01-.617-1.559c0-.607.206-1.117.617-1.529A2.125 2.125 0 0196.321 1a2.03 2.03 0 011.53.647c.43.412.646.922.646 1.53 0 .607-.215 1.127-.647 1.558-.411.412-.921.618-1.529.618zm-1.618 2.176h3.236v15h-3.236v-15zM77.35 7.53h3.088V9.5h.147c.431-.706 1.069-1.284 1.912-1.735a5.63 5.63 0 012.735-.706c1.824 0 3.206.54 4.147 1.618.96 1.059 1.441 2.51 1.441 4.353v9.5h-3.235v-9.06c0-1.176-.294-2.039-.882-2.588-.569-.548-1.363-.823-2.383-.823-.725 0-1.372.206-1.94.618a3.902 3.902 0 00-1.324 1.588 4.979 4.979 0 00-.47 2.147v8.117H77.35v-15zM71.706 5.353a2.177 2.177 0 01-1.558-.618 2.176 2.176 0 01-.618-1.559c0-.607.206-1.117.618-1.529A2.125 2.125 0 0171.706 1a2.03 2.03 0 011.53.647c.431.412.647.922.647 1.53 0 .607-.216 1.127-.647 1.558-.412.412-.922.618-1.53.618zM70.09 7.529h3.235v15h-3.235v-15zM43.487 7.53h3.088V9.5h.147c.451-.725 1.088-1.313 1.912-1.764a5.426 5.426 0 012.647-.677c1.078 0 2.02.255 2.823.765.804.49 1.383 1.147 1.736 1.97a5.747 5.747 0 012.029-1.97c.863-.51 1.872-.765 3.03-.765 1.725 0 3.029.53 3.91 1.588.903 1.04 1.354 2.461 1.354 4.265v9.617h-3.235v-9.058c0-2.275-.97-3.412-2.912-3.412-1.04 0-1.892.422-2.559 1.265-.666.843-1 1.882-1 3.117v8.088h-3.235v-9.058c0-2.275-1-3.412-3-3.412-1.02 0-1.863.422-2.53 1.265-.646.843-.97 1.882-.97 3.117v8.088h-3.235v-15zM33.394 23c-1.47 0-2.794-.343-3.97-1.03a7.421 7.421 0 01-2.736-2.823c-.647-1.216-.97-2.578-.97-4.088 0-1.431.313-2.755.94-3.97.648-1.236 1.54-2.216 2.677-2.942 1.137-.725 2.431-1.088 3.882-1.088 1.51 0 2.814.333 3.912 1a6.425 6.425 0 012.53 2.735c.587 1.157.882 2.461.882 3.912 0 .274-.03.618-.089 1.03h-11.5c.118 1.392.608 2.47 1.471 3.235a4.6 4.6 0 003.059 1.117c.922 0 1.716-.206 2.382-.617a4.827 4.827 0 001.647-1.736l2.735 1.294c-.705 1.236-1.627 2.206-2.764 2.912-1.137.706-2.5 1.059-4.088 1.059zm3.853-9.735a3.635 3.635 0 00-.5-1.559c-.294-.53-.745-.97-1.353-1.323-.588-.353-1.314-.53-2.177-.53-1.039 0-1.921.314-2.647.941-.706.608-1.196 1.432-1.47 2.47h8.147zM13.03 23c-2 0-3.844-.48-5.53-1.442a10.94 10.94 0 01-4.03-3.94C2.49 15.93 2 14.057 2 12c0-2.059.49-3.922 1.47-5.588a10.87 10.87 0 014.03-3.97C9.186 1.48 11.03 1 13.03 1c1.587 0 3.068.284 4.44.853 1.373.569 2.52 1.363 3.441 2.382L18.617 6.53a6.96 6.96 0 00-2.47-1.764c-.941-.412-1.99-.618-3.147-.618a7.75 7.75 0 00-3.794.97c-1.177.648-2.118 1.57-2.824 2.765C5.676 9.078 5.323 10.451 5.323 12c0 1.549.353 2.921 1.06 4.117.705 1.196 1.646 2.118 2.823 2.765a7.806 7.806 0 003.823.97c1.255 0 2.304-.186 3.147-.558a7.996 7.996 0 002.265-1.5c.431-.432.794-.97 1.088-1.618a6.8 6.8 0 00.618-2.117H13v-2.941h10.264c.098.548.147 1.117.147 1.705 0 1.334-.206 2.618-.617 3.853a8.113 8.113 0 01-1.97 3.177C18.842 21.95 16.243 23 13.028 23z\"></path></g></svg>" },
      antigravity: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(7.5604 6.7346) scale(0.4171)\"><mask height=\"23\" id=\"lobe-icons-antigravity-0-_R_0_\" maskUnits=\"userSpaceOnUse\" width=\"24\" x=\"0\" y=\"1\"><path d=\"M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z\" fill=\"#fff\"></path></mask><g mask=\"url(#lobe-icons-antigravity-0-_R_0_)\"><g filter=\"url(#lobe-icons-antigravity-1-_R_0_)\"><path d=\"M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z\" fill=\"#FFE432\"></path></g><g filter=\"url(#lobe-icons-antigravity-2-_R_0_)\"><path d=\"M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z\" fill=\"#FC413D\"></path></g><g filter=\"url(#lobe-icons-antigravity-3-_R_0_)\"><path d=\"M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z\" fill=\"#00B95C\"></path></g><g filter=\"url(#lobe-icons-antigravity-4-_R_0_)\"><path d=\"M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z\" fill=\"#00B95C\"></path></g><g filter=\"url(#lobe-icons-antigravity-5-_R_0_)\"><path d=\"M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z\" fill=\"#00B95C\"></path></g><g filter=\"url(#lobe-icons-antigravity-6-_R_0_)\"><path d=\"M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z\" fill=\"#3186FF\"></path></g><g filter=\"url(#lobe-icons-antigravity-7-_R_0_)\"><path d=\"M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z\" fill=\"#FBBC04\"></path></g><g filter=\"url(#lobe-icons-antigravity-8-_R_0_)\"><path d=\"M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z\" fill=\"#3186FF\"></path></g><g filter=\"url(#lobe-icons-antigravity-9-_R_0_)\"><path d=\"M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z\" fill=\"#749BFF\"></path></g><g filter=\"url(#lobe-icons-antigravity-10-_R_0_)\"><path d=\"M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z\" fill=\"#FC413D\"></path></g><g filter=\"url(#lobe-icons-antigravity-11-_R_0_)\"><path d=\"M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z\" fill=\"#FFEE48\"></path></g></g><defs><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"17.587\" id=\"lobe-icons-antigravity-1-_R_0_\" width=\"19.838\" x=\"-3.288\" y=\"-11.917\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"1.117\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"38.565\" id=\"lobe-icons-antigravity-2-_R_0_\" width=\"38.9\" x=\"4.251\" y=\"-13.493\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"5.4\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"36.517\" id=\"lobe-icons-antigravity-3-_R_0_\" width=\"40.955\" x=\"-21.889\" y=\"-10.592\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"4.591\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"36.517\" id=\"lobe-icons-antigravity-4-_R_0_\" width=\"40.955\" x=\"-21.889\" y=\"-10.592\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"4.591\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"36.595\" id=\"lobe-icons-antigravity-5-_R_0_\" width=\"36.632\" x=\"-19.099\" y=\"-10.278\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"4.591\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"34.087\" id=\"lobe-icons-antigravity-6-_R_0_\" width=\"33.533\" x=\".981\" y=\"8.758\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"4.363\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"35.276\" id=\"lobe-icons-antigravity-7-_R_0_\" width=\"35.978\" x=\"-6.143\" y=\"-21.659\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"3.954\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"46.523\" id=\"lobe-icons-antigravity-8-_R_0_\" width=\"45.114\" x=\"-11.96\" y=\"-.46\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"3.531\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"24.054\" id=\"lobe-icons-antigravity-9-_R_0_\" width=\"25.094\" x=\"10.485\" y=\".58\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"3.159\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"30.007\" id=\"lobe-icons-antigravity-10-_R_0_\" width=\"33.508\" x=\"5.833\" y=\"-12.467\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"2.669\"></feGaussianBlur></filter><filter color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"26.151\" id=\"lobe-icons-antigravity-11-_R_0_\" width=\"22.194\" x=\"-8.355\" y=\"-8.876\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"></feFlood><feBlend in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"></feBlend><feGaussianBlur result=\"effect1_foregroundBlur_977_115\" stdDeviation=\"3.303\"></feGaussianBlur></filter></defs></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 170.22 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 -1) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M165.834 22.734a6.851 6.851 0 01-.148.317 8.749 8.749 0 01-.105.232h-1.856c.085-.183.176-.387.274-.612.099-.21.218-.47.359-.78l.232-.506c.07-.155.147-.33.232-.527.098-.183.211-.415.337-.696l.97-2.108-4.449-10.078h1.94l3.373 7.99h.042l3.247-7.99h1.94l-5.566 12.84c-.056.126-.148.323-.274.59-.113.281-.225.548-.337.801a6.679 6.679 0 01-.211.527zM154.865 9.6V7.976h1.898V4.94h1.792v3.036h2.635V9.6h-2.635v5.861c0 .604.119 1.054.358 1.35.253.28.625.421 1.117.421.225 0 .436-.028.633-.084.197-.07.387-.162.569-.274v1.75a3.916 3.916 0 01-.696.19 3.392 3.392 0 01-.78.084c-.899 0-1.623-.267-2.171-.802-.548-.548-.822-1.279-.822-2.192V9.6h-1.898zM151.661 18.729V7.976h1.792V18.73h-1.792zm.885-12.734a1.24 1.24 0 01-.907-.38 1.24 1.24 0 01-.379-.907c0-.365.127-.667.379-.906a1.24 1.24 0 01.907-.38c.366 0 .668.127.907.38.253.239.379.541.379.906 0 .352-.126.654-.379.907-.239.253-.541.38-.907.38zM144.496 18.729l-4.343-10.753h1.918l3.332 8.644h.042l3.373-8.644h1.876l-4.385 10.753h-1.813zM134.384 19.066c-.801 0-1.503-.154-2.108-.463a3.696 3.696 0 01-1.434-1.266 3.471 3.471 0 01-.506-1.855c0-.787.204-1.447.612-1.982.408-.548.956-.955 1.644-1.223.689-.28 1.448-.421 2.277-.421.478 0 .921.042 1.329.126.407.07.759.162 1.054.274.309.099.541.197.696.296v-.654c0-.815-.289-1.462-.865-1.94-.576-.478-1.279-.716-2.108-.716-.591 0-1.146.133-1.666.4a2.964 2.964 0 00-1.201 1.075l-1.35-1.012a4.344 4.344 0 011.054-1.096c.422-.31.9-.548 1.434-.717a5.848 5.848 0 011.729-.253c1.462 0 2.607.387 3.436 1.16.83.773 1.244 1.813 1.244 3.12v6.81h-1.707v-1.54h-.085c-.182.31-.443.612-.78.907a4.347 4.347 0 01-1.202.696 3.938 3.938 0 01-1.497.274zm.169-1.58c.619 0 1.181-.155 1.687-.465.52-.309.935-.724 1.244-1.244.309-.52.464-1.089.464-1.707-.324-.225-.731-.408-1.223-.549a5.592 5.592 0 00-1.581-.21c-1.027 0-1.779.21-2.256.632-.478.422-.717.942-.717 1.56 0 .59.225 1.069.674 1.434.45.365 1.02.548 1.708.548zM123.833 18.729V7.976h1.708v1.73h.084c.14-.408.372-.76.696-1.055.337-.31.716-.548 1.138-.717a3.312 3.312 0 011.286-.274c.324 0 .577.021.759.063.183.029.352.078.506.148v1.94a3.05 3.05 0 00-.738-.253 3.584 3.584 0 00-.78-.085 2.5 2.5 0 00-1.433.443 3.297 3.297 0 00-1.055 1.18 3.508 3.508 0 00-.379 1.624v6.009h-1.792zM116.438 23.62c-.913 0-1.7-.154-2.361-.464-.646-.295-1.173-.674-1.581-1.138-.394-.464-.675-.935-.843-1.413l1.644-.695c.225.59.604 1.082 1.139 1.476.548.407 1.215.61 2.002.61 1.125 0 1.989-.33 2.594-.99.604-.646.906-1.553.906-2.72v-1.202h-.084c-.337.52-.822.963-1.455 1.329-.632.351-1.37.527-2.213.527a4.76 4.76 0 01-2.552-.717c-.759-.478-1.363-1.139-1.813-1.982-.45-.857-.674-1.841-.674-2.951s.224-2.088.674-2.931c.45-.857 1.054-1.525 1.813-2.003a4.76 4.76 0 012.552-.717c.843 0 1.581.183 2.213.548.633.352 1.118.794 1.455 1.329h.084v-1.54h1.708v10.331c0 1.195-.232 2.186-.696 2.973a4.201 4.201 0 01-1.855 1.75c-.773.394-1.658.59-2.657.59zm0-6.304a3.43 3.43 0 001.75-.463c.535-.324.956-.788 1.265-1.392.324-.604.485-1.328.485-2.171 0-.872-.161-1.603-.485-2.193-.309-.604-.73-1.061-1.265-1.37a3.43 3.43 0 00-1.75-.464c-.632 0-1.215.161-1.749.485-.535.309-.963.766-1.287 1.37-.323.59-.484 1.314-.484 2.171 0 .858.161 1.589.484 2.193.324.59.752 1.047 1.287 1.37a3.43 3.43 0 001.749.464zM107.731 18.729V7.976h1.792V18.73h-1.792zm.886-12.734c-.352 0-.654-.127-.907-.38a1.237 1.237 0 01-.379-.907c0-.365.126-.667.379-.906.253-.253.555-.38.907-.38.365 0 .667.127.906.38.254.239.38.541.38.906 0 .352-.126.654-.38.907-.239.253-.541.38-.906.38zM99.693 9.6V7.976h1.898V4.94h1.792v3.036h2.635V9.6h-2.635v5.861c0 .604.119 1.054.358 1.35.253.28.626.421 1.117.421.225 0 .436-.028.633-.084.197-.07.387-.162.569-.274v1.75a3.916 3.916 0 01-.696.19 3.39 3.39 0 01-.779.084c-.9 0-1.624-.267-2.172-.802-.548-.548-.822-1.279-.822-2.192V9.6h-1.898zM89.427 18.729V7.977h1.707v1.58h.085c.28-.52.738-.97 1.37-1.349.647-.38 1.35-.569 2.108-.569 1.322 0 2.313.387 2.973 1.16.675.759 1.012 1.77 1.012 3.036v6.894H96.89v-6.62c0-1.04-.253-1.771-.759-2.193-.492-.436-1.131-.653-1.918-.653-.59 0-1.11.168-1.56.506-.45.323-.802.745-1.055 1.265a3.713 3.713 0 00-.38 1.644v6.051h-1.791zM74.733 18.729l5.735-15.096h2.024l5.735 15.096h-1.961l-1.54-4.153h-6.493l-1.54 4.153h-1.96zm9.382-5.84l-2.003-5.44-.59-1.623h-.084l-.59 1.623-2.004 5.44h5.271zM10.653 19.068C5.951 19.068 2 15.237 2 10.534 2 5.832 5.95 2 10.653 2c2.601 0 4.45 1.02 5.844 2.351l-1.643 1.643c-1-.937-2.351-1.666-4.2-1.666-3.431 0-6.115 2.769-6.115 6.204 0 3.435 2.684 6.201 6.114 6.201 2.226 0 3.495-.894 4.306-1.707.665-.667 1.103-1.623 1.27-2.936h-5.635V9.76h7.901c.083.417.124.916.124 1.457 0 1.749-.479 3.914-2.017 5.454-1.496 1.56-3.41 2.393-5.949 2.393v.004zM30.454 13.573c0 3.164-2.473 5.495-5.505 5.495s-5.505-2.33-5.505-5.495 2.473-5.496 5.505-5.496 5.505 2.31 5.505 5.496zm-2.411 0c0-1.978-1.435-3.33-3.096-3.33-1.662 0-3.096 1.352-3.096 3.33 0 1.977 1.434 3.33 3.096 3.33 1.661 0 3.096-1.373 3.096-3.33zM42.437 13.573c0 3.164-2.473 5.495-5.505 5.495s-5.505-2.33-5.505-5.495 2.473-5.496 5.505-5.496 5.505 2.31 5.505 5.496zm-2.411 0c0-1.978-1.435-3.33-3.096-3.33-1.662 0-3.096 1.352-3.096 3.33 0 1.977 1.434 3.33 3.096 3.33 1.661 0 3.096-1.373 3.096-3.33zM53.9 8.41v9.865c0 4.059-2.393 5.725-5.22 5.725-2.664 0-4.266-1.79-4.868-3.247l2.101-.874c.374.896 1.29 1.957 2.766 1.957 1.81 0 2.934-1.123 2.934-3.226v-.791h-.083c-.54.667-1.581 1.249-2.892 1.249-2.745 0-5.262-2.393-5.262-5.475s2.517-5.516 5.262-5.516c1.31 0 2.351.582 2.892 1.228h.083V8.41H53.9zm-2.122 5.183c0-1.936-1.29-3.35-2.934-3.35-1.643 0-3.057 1.416-3.057 3.35 0 1.934 1.393 3.31 3.057 3.31s2.934-1.396 2.934-3.31zM58.047 2.582v16.152h-2.413V2.582h2.413zM67.4 15.383l1.872 1.249c-.603.896-2.06 2.436-4.576 2.436-3.12 0-5.45-2.415-5.45-5.495 0-3.268 2.351-5.496 5.18-5.496 2.827 0 4.241 2.269 4.7 3.497l.25.624-7.343 3.038c.561 1.103 1.434 1.666 2.663 1.666 1.228 0 2.08-.602 2.704-1.519zm-5.762-1.978l4.91-2.04c-.271-.687-1.082-1.166-2.038-1.166-1.226 0-2.933 1.082-2.87 3.206h-.002z\"></path></g></svg>" },
      opencode: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-1.2 -1.2) scale(1.1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M16 6H8v12h8V6zm4 16H4V2h16v20z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 122.5675 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-1.9617 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M12.429 17.143H5.57v-6.857h6.858v6.857z\" fill-opacity=\".25\"></path><path d=\"M12.428 6.857H5.571v10.286h6.857V6.857zm3.43 13.715H2.142V3.429h13.714v17.143z\" fill-opacity=\".75\"></path><path d=\"M29.571 17.143h-6.857v-6.857h6.857v6.857z\" fill-opacity=\".25\"></path><path d=\"M22.714 17.143h6.858V6.857h-6.858v10.286zM33 20.572H22.714V24h-3.428V3.43H33v17.143z\" fill-opacity=\".75\"></path><path d=\"M50.143 13.714v3.429H39.857v-3.429h10.286z\" fill-opacity=\".25\"></path><path d=\"M50.143 13.714H39.857v3.429h10.286v3.429H36.429V3.429h13.714v10.285zm-10.286-3.428h6.857V6.857h-6.857v3.429z\" fill-opacity=\".75\"></path><path d=\"M63.857 20.571H57V10.286h6.857V20.57z\" fill-opacity=\".25\"></path><path d=\"M63.857 6.857H57v13.715h-3.429V3.429h10.286v3.428zm3.429 13.715h-3.429V6.857h3.429v13.715z\" fill-opacity=\".75\"></path><path d=\"M84.428 17.143H74.144v-6.857h10.285v6.857z\" fill-opacity=\".25\"></path><path d=\"M84.428 6.857H74.144v10.286h10.285v3.429H70.715V3.429H84.43v3.428z\"></path><path d=\"M98.143 17.143h-6.857v-6.857h6.857v6.857z\" fill-opacity=\".25\"></path><path d=\"M98.143 6.857h-6.857v10.286h6.857V6.857zm3.428 13.715H87.857V3.429h13.714v17.143z\"></path><path d=\"M115.286 17.143h-6.857v-6.857h6.857v6.857z\" fill-opacity=\".25\"></path><path d=\"M115.286 6.857h-6.857v10.286h6.857V6.857zm3.428 13.714H105V3.43h10.286V0h3.428v20.571z\"></path><path d=\"M135.857 13.714v3.429h-10.286v-3.429h10.286z\" fill-opacity=\".25\"></path><path d=\"M125.571 6.857v3.429h6.858V6.857h-6.858zm10.286 6.857h-10.286v3.429h10.286v3.429h-13.714V3.429h13.714v10.285z\"></path></g></svg>" },
      kilocode: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M0 0v24h24V0H0zm22.222 22.222H1.778V1.778h20.444v20.444zm-7.555-4.964h2.222v1.778h-2.794L12.89 17.83v-2.794h1.778v2.222zm4 0h-1.778v-2.222h-2.222v-1.778h2.793l1.207 1.207v2.793zm-7.556-2.591H9.333v-1.778h1.778v1.778zm-5.778-1.778h1.778v4h4v1.778H6.54L5.333 17.46V12.89zm13.334-3.556v1.778h-5.778V9.333h1.987V7.111h-1.987V5.333h2.558l1.206 1.207v2.793h2.014zm-11.556-2h2.222l1.778 1.778v2H9.333v-2H7.111v2H5.333V5.333h1.778v2zm4 0H9.333v-2h1.778v2z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 142.91 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 1) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M138.579 21.999c-1.289 0-2.413-.249-3.371-.746-.959-.498-1.705-1.189-2.239-2.073-.516-.903-.774-1.953-.774-3.15v-3.815c0-1.197.258-2.238.774-3.123a5.467 5.467 0 012.239-2.1c.958-.498 2.082-.746 3.371-.746 1.272 0 2.377.248 3.317.746.958.497 1.695 1.197 2.211 2.1.534.885.801 1.926.801 3.123v2.736h-9.369v1.078c0 1.069.258 1.88.774 2.432.516.535 1.281.802 2.294.802.774 0 1.4-.13 1.879-.387.479-.277.783-.673.912-1.189h3.4c-.258 1.308-.958 2.359-2.101 3.151-1.124.774-2.496 1.16-4.118 1.16zm2.985-8.982v-.83c0-1.05-.249-1.851-.746-2.404-.498-.571-1.244-.857-2.239-.857-.995 0-1.75.286-2.266.857s-.774 1.382-.774 2.432v.58l6.274-.055-.249.277zM120.958 22c-1.511 0-2.736-.525-3.676-1.576-.921-1.05-1.382-2.46-1.382-4.228v-4.118c0-1.787.461-3.206 1.382-4.256.921-1.05 2.146-1.575 3.676-1.575 1.253 0 2.247.359 2.984 1.077.737.7 1.106 1.668 1.106 2.902l-.774-.801h.802l-.111-3.62V1.547h3.455v20.176h-3.372v-2.902h-.774l.774-.802c0 1.235-.369 2.211-1.106 2.93-.737.7-1.731 1.05-2.984 1.05zm1.216-2.985c.884 0 1.566-.258 2.045-.774.497-.534.746-1.271.746-2.21v-3.815c0-.94-.249-1.667-.746-2.183-.479-.534-1.161-.802-2.045-.802-.885 0-1.576.258-2.073.774-.498.516-.746 1.253-.746 2.211v3.814c0 .958.248 1.695.746 2.211.497.516 1.188.774 2.073.774zM105.961 21.972c-1.289 0-2.413-.24-3.371-.719a5.573 5.573 0 01-2.211-2.073c-.516-.902-.774-1.962-.774-3.178v-3.758c0-1.216.258-2.267.774-3.151a5.327 5.327 0 012.211-2.073c.958-.497 2.082-.746 3.371-.746 1.309 0 2.433.249 3.372.746a5.155 5.155 0 012.184 2.073c.534.884.801 1.925.801 3.123v3.786c0 1.216-.267 2.276-.801 3.178a5.386 5.386 0 01-2.184 2.073c-.939.48-2.063.719-3.372.719zm0-3.013c.922 0 1.631-.248 2.129-.746.515-.516.773-1.253.773-2.21v-3.76c0-.976-.258-1.713-.773-2.21-.498-.498-1.207-.747-2.129-.747-.902 0-1.612.25-2.128.747-.515.497-.773 1.234-.773 2.21v3.76c0 .957.258 1.694.773 2.21.516.498 1.226.746 2.128.746zM89.777 22c-1.29 0-2.423-.24-3.4-.719-.958-.497-1.704-1.188-2.238-2.072-.516-.903-.774-1.963-.774-3.179V7.242c0-1.235.258-2.294.774-3.179a5.347 5.347 0 012.239-2.045c.976-.497 2.11-.746 3.399-.746 1.308 0 2.432.249 3.372.746a5.347 5.347 0 012.238 2.045c.535.885.802 1.944.802 3.179h-3.483c0-.958-.258-1.686-.773-2.184-.498-.497-1.216-.746-2.156-.746-.94 0-1.668.249-2.183.746-.516.498-.774 1.216-.774 2.156v8.816c0 .94.258 1.668.774 2.183.516.498 1.243.747 2.183.747.94 0 1.658-.249 2.156-.747.515-.515.773-1.243.773-2.183h3.483c0 1.198-.267 2.248-.802 3.15a5.473 5.473 0 01-2.238 2.101c-.94.48-2.064.719-3.372.719zM57.076 21.972c-1.29 0-2.413-.24-3.372-.719a5.576 5.576 0 01-2.21-2.073c-.517-.902-.774-1.962-.774-3.178v-3.758c0-1.216.258-2.267.773-3.151a5.33 5.33 0 012.211-2.073c.959-.497 2.082-.746 3.372-.746 1.308 0 2.432.249 3.372.746a5.155 5.155 0 012.183 2.073c.535.884.802 1.925.802 3.123v3.786c0 1.216-.267 2.276-.802 3.178a5.385 5.385 0 01-2.183 2.073c-.94.48-2.064.719-3.372.719zm0-3.013c.921 0 1.63-.248 2.128-.746.516-.516.774-1.253.774-2.21v-3.76c0-.976-.258-1.713-.774-2.21-.497-.498-1.207-.747-2.128-.747-.903 0-1.612.25-2.128.747s-.774 1.234-.774 2.21v3.76c0 .957.258 1.694.774 2.21.516.498 1.225.746 2.128.746zM43.102 21.724c-.994 0-1.87-.203-2.625-.609a4.446 4.446 0 01-1.741-1.713c-.424-.756-.636-1.621-.636-2.598V4.671h-4.864V1.548h8.319v15.256c0 .553.157.995.47 1.327.331.313.773.47 1.326.47h4.588v3.123h-4.837zM18.295 21.723v-3.15h5.306V9.644h-4.615V6.522h7.932v12.05h4.698v3.15h-13.32zM24.983 3.98c-.7 0-1.253-.175-1.658-.525-.405-.369-.608-.857-.608-1.465 0-.608.203-1.087.608-1.437C23.73.184 24.283 0 24.983 0s1.253.184 1.659.553c.405.35.608.829.608 1.437 0 .608-.203 1.096-.608 1.465-.406.35-.959.525-1.659.525zM2 21.724V1.548h3.455v8.153h2.404l3.786-8.153h3.759l-4.505 9.673 4.726 10.503h-3.841l-3.98-8.872h-2.35v8.872H2z\"></path></g></svg>" },
      grokbuild: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 0.9817) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64.46 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2.2 -1.2) scale(1.1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M47.419 21.645V2.457h3.033V15.12l6.415-7.369h3.678l-5.772 6.316 5.825 7.578h-3.624l-4.717-6.512-1.805-.012v6.524h-3.033zM38.22 21.968c-4.51 0-6.952-3.198-6.952-7.283 0-4.112 2.443-7.283 6.952-7.283 4.537 0 6.952 3.17 6.952 7.283 0 4.085-2.415 7.283-6.952 7.283zm-3.785-7.283c0 3.17 1.718 4.756 3.785 4.756 2.094 0 3.785-1.585 3.785-4.756 0-3.172-1.691-4.784-3.785-4.784-2.067 0-3.785 1.612-3.785 4.784zM22.826 21.645V9.955l2.55-2.204h5.422v2.58H25.86v11.314h-3.033zM11.228 22C5.447 22 2 17.802 2 12.078 2 6.3 5.57 2 11.341 2c4.51 0 7.811 2.311 8.59 6.611h-3.463c-.51-2.445-2.55-3.816-5.127-3.816-4.16 0-5.986 3.601-5.986 7.283 0 3.682 1.826 7.256 5.986 7.256 3.973 0 5.717-2.876 5.852-5.267h-5.986v-2.783h9.046l-.015 1.455c0 5.406-2.203 9.261-9.01 9.261z\"></path></g></svg>" },
      openclaw: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 0.3858) scale(0.9167)\"><path d=\"M12 2.568c-6.33 0-9.495 5.275-9.495 9.495 0 4.22 3.165 8.44 6.33 9.494v2.11h2.11v-2.11s1.055.422 2.11 0v2.11h2.11v-2.11c3.165-1.055 6.33-5.274 6.33-9.494S18.33 2.568 12 2.568z\" fill=\"url(#lobe-icons-open-claw-0-_R_0_)\"></path><path d=\"M3.56 9.953C.396 8.898-.66 11.008.396 13.118c1.055 2.11 3.164 1.055 4.22-1.055.632-1.477 0-2.11-1.056-2.11z\" fill=\"url(#lobe-icons-open-claw-1-_R_0_)\"></path><path d=\"M20.44 9.953c3.164-1.055 4.22 1.055 3.164 3.165-1.055 2.11-3.164 1.055-4.22-1.055-.632-1.477 0-2.11 1.056-2.11z\" fill=\"url(#lobe-icons-open-claw-2-_R_0_)\"></path><path d=\"M5.507 1.875c.476-.285 1.036-.233 1.615.037.577.27 1.223.774 1.937 1.488a.316.316 0 01-.447.447c-.693-.693-1.279-1.138-1.757-1.361-.475-.222-.795-.205-1.022-.069a.317.317 0 01-.326-.542zM16.877 1.913c.58-.27 1.14-.323 1.616-.038a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.069-.478.223-1.064.668-1.756 1.361a.316.316 0 11-.448-.447c.714-.714 1.36-1.218 1.936-1.487z\" fill=\"#FF4D4D\"></path><path d=\"M8.835 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532zM15.165 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532z\" fill=\"#050810\"></path><path d=\"M9.046 8.16a.527.527 0 100-1.056.527.527 0 000 1.055zM15.376 8.16a.527.527 0 100-1.055.527.527 0 000 1.054z\" fill=\"#00E5CC\"></path><defs><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lobe-icons-open-claw-0-_R_0_\" x1=\"-.659\" x2=\"27.023\" y1=\".458\" y2=\"22.855\"><stop stop-color=\"#FF4D4D\"></stop><stop offset=\"1\" stop-color=\"#991B1B\"></stop></linearGradient><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lobe-icons-open-claw-1-_R_0_\" x1=\"0\" x2=\"4.311\" y1=\"9.672\" y2=\"14.949\"><stop stop-color=\"#FF4D4D\"></stop><stop offset=\"1\" stop-color=\"#991B1B\"></stop></linearGradient><linearGradient gradientUnits=\"userSpaceOnUse\" id=\"lobe-icons-open-claw-2-_R_0_\" x1=\"19.385\" x2=\"24.399\" y1=\"9.953\" y2=\"14.462\"><stop stop-color=\"#FF4D4D\"></stop><stop offset=\"1\" stop-color=\"#991B1B\"></stop></linearGradient></defs></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 135.78 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 -1) scale(1)\" fill=\"currentColor\" fill-rule=\"nonzero\"><path d=\"M122.59 19.6h-6.082l-3.287-13.044h5.047l.932 4.71.492 4.659h.336l1.087-5.177 1.294-4.192h6.264l1.294 4.192 1.087 5.177h.336l.518-4.659.906-4.71h4.969L134.341 19.6h-6.082l-1.683-5.228-.957-3.908h-.337l-.983 3.908-1.709 5.228zM112.685 19.6h-4.555v-2.899h-.259v-4.633c0-.655-.173-1.07-.518-1.242-.328-.19-.923-.285-1.786-.285-.793 0-1.345.095-1.656.285-.293.19-.44.561-.44 1.113v.104h-4.866v-.052c0-1.156.302-2.157.906-3.002.604-.863 1.458-1.527 2.562-1.993 1.105-.466 2.39-.7 3.857-.7 1.518 0 2.778.242 3.779.726 1 .465 1.742 1.138 2.225 2.018.501.863.751 1.907.751 3.132V19.6zm-9.732.259c-1.466 0-2.605-.32-3.416-.958-.794-.638-1.19-1.51-1.19-2.614 0-.62.146-1.173.44-1.656.293-.483.75-.872 1.371-1.165.621-.31 1.424-.518 2.407-.621l5.565-.543v2.691l-4.271.492c-.224.017-.388.069-.491.155a.453.453 0 00-.13.337c0 .207.095.345.285.414.207.052.5.078.88.078.863 0 1.544-.044 2.044-.13.501-.104.863-.285 1.087-.543.225-.26.337-.63.337-1.113l.362-.104v2.278h-.362c-.242.914-.768 1.648-1.579 2.2-.811.535-1.924.802-3.339.802zM97.18 19.6h-4.865V2.26h4.865V19.6zM81.715 19.858c-2.001 0-3.718-.362-5.15-1.087-1.432-.742-2.528-1.777-3.287-3.105-.76-1.346-1.14-2.925-1.14-4.737 0-1.811.38-3.382 1.14-4.71.759-1.346 1.855-2.381 3.287-3.106C77.997 2.37 79.714 2 81.715 2c1.95 0 3.615.293 4.995.88 1.398.587 2.468 1.432 3.21 2.536.742 1.105 1.113 2.433 1.113 3.986v.44h-5.436v-.44c0-.983-.276-1.682-.828-2.096-.552-.432-1.544-.647-2.976-.647-1.174 0-2.088.12-2.744.362a2.179 2.179 0 00-1.346 1.268c-.258.604-.388 1.484-.388 2.64 0 1.139.13 2.019.389 2.64a2.266 2.266 0 001.345 1.294c.656.225 1.57.337 2.744.337 1.432 0 2.424-.207 2.976-.621.552-.432.828-1.14.828-2.123v-.44h5.436v.44c0 1.536-.371 2.864-1.113 3.986-.742 1.104-1.812 1.95-3.21 2.537-1.38.586-3.045.88-4.995.88zM70.96 19.6h-4.866v-6.574c0-.914-.199-1.535-.596-1.863-.397-.345-1.13-.518-2.2-.518-1.07 0-1.786.164-2.148.492-.345.31-.518.888-.518 1.734h-.491l-.414-2.355h.854a5.758 5.758 0 01.698-2.045c.38-.638.932-1.156 1.657-1.553.742-.414 1.69-.621 2.847-.621 1.173 0 2.14.216 2.899.647.776.431 1.346 1.018 1.708 1.76.38.742.57 1.587.57 2.536v8.36zm-10.328 0h-4.865V6.556h4.555v4.011l.31.13V19.6zM47.192 19.859c-1.467 0-2.77-.224-3.908-.673-1.14-.449-2.028-1.173-2.666-2.174-.639-1-.958-2.312-.958-3.934 0-1.415.32-2.623.958-3.624a6.219 6.219 0 012.614-2.329c1.121-.552 2.407-.828 3.856-.828 1.501 0 2.804.25 3.908.75 1.105.484 1.959 1.208 2.563 2.175.604.949.906 2.122.906 3.52 0 .224-.009.43-.026.62 0 .173-.017.38-.052.622H42.844v-2.459h8.023l-1.061 1.527v-.906c0-.794-.207-1.346-.621-1.656-.397-.31-1.13-.466-2.2-.466-1.105 0-1.855.172-2.252.518-.38.345-.57.966-.57 1.863v1.242c0 .915.199 1.536.596 1.864.397.328 1.147.492 2.252.492.983 0 1.639-.087 1.967-.26.345-.189.517-.474.517-.853v-.285h4.866v.31c0 .967-.293 1.82-.88 2.563-.587.742-1.415 1.328-2.485 1.76-1.07.414-2.338.621-3.804.621zM32.648 19.859c-1.536 0-2.692-.328-3.469-.984-.776-.672-1.26-1.552-1.449-2.64h-.75v-3.002h.491c0 .604.112 1.07.337 1.398.241.31.595.526 1.06.647.484.103 1.088.155 1.813.155.759 0 1.354-.078 1.785-.233.449-.155.768-.405.958-.75.19-.345.285-.803.285-1.372 0-.587-.095-1.044-.285-1.372-.19-.345-.509-.586-.958-.724-.431-.156-1.026-.233-1.786-.233-1.087 0-1.898.146-2.432.44-.518.293-.777.914-.777 1.863h-.492l-.362-2.976h.802c.207-1.294.716-2.243 1.527-2.847.811-.622 1.976-.932 3.494-.932 1.33 0 2.45.276 3.365.828.932.535 1.63 1.311 2.096 2.33.484 1 .725 2.208.725 3.623s-.233 2.631-.699 3.65c-.465 1-1.147 1.776-2.044 2.329-.88.535-1.959.802-3.236.802zM27.47 24h-4.866V6.556h4.556v3.675l.31.336V24zM11.602 19.858c-2.001 0-3.727-.362-5.176-1.087-1.432-.742-2.528-1.777-3.287-3.105C2.379 14.32 2 12.74 2 10.929c0-1.811.38-3.382 1.139-4.71.759-1.346 1.855-2.381 3.287-3.106C7.876 2.37 9.6 2 11.602 2c2.07 0 3.822.371 5.254 1.113 1.45.725 2.554 1.76 3.313 3.106.76 1.328 1.139 2.899 1.139 4.71 0 1.812-.38 3.39-1.139 4.737-.76 1.328-1.863 2.363-3.313 3.105-1.432.725-3.183 1.087-5.254 1.087zm0-4.658c1.173 0 2.088-.112 2.744-.337.655-.241 1.113-.673 1.371-1.294.276-.621.414-1.501.414-2.64 0-1.156-.138-2.036-.414-2.64-.258-.62-.716-1.044-1.371-1.268-.656-.241-1.57-.362-2.744-.362-1.173 0-2.079.12-2.717.362A2.179 2.179 0 007.539 8.29c-.242.604-.363 1.484-.363 2.64 0 1.139.121 2.019.363 2.64a2.266 2.266 0 001.346 1.294c.638.225 1.544.337 2.717.337z\"></path></g></svg>" },
      kimi: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2.1777 1.4078) scale(1.0592)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z\"></path><path d=\"M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 66 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2.2 -1.2) scale(1.1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M24.353 21.58c0 .232.188.42.42.42h2.69a.42.42 0 00.42-.42V2.42a.42.42 0 00-.42-.42h-2.69a.42.42 0 00-.42.42v19.16zM58.47 21.58c0 .232.188.42.42.42h2.691a.42.42 0 00.419-.42V2.42a.42.42 0 00-.419-.42H58.89a.42.42 0 00-.42.42v19.16zM47.786 2a.42.42 0 00-.408.32L43.4 18.633c-.066.267-.38.267-.444 0L38.976 2.32A.417.417 0 0038.57 2H31.83a.418.418 0 00-.418.42v19.16c0 .232.188.42.42.42h2.988c.231 0 .419-.182.419-.414V5.471c0-.322.378-.389.454-.079l3.974 16.288a.42.42 0 00.407.32h6.208a.42.42 0 00.407-.32L50.66 5.394c.076-.31.455-.243.455.079V21.58c0 .231.187.419.419.419h2.987a.42.42 0 00.42-.42V2.42a.42.42 0 00-.42-.42h-6.735zM11.55 11.273l8.115-8.565A.42.42 0 0019.36 2h-3.776a.42.42 0 00-.298.124l-9.303 9.39c-.144.146-.357.016-.357-.218V2.42a.42.42 0 00-.42-.42H2.42a.42.42 0 00-.42.42v19.16c0 .232.188.42.42.42h2.786a.42.42 0 00.42-.42v-3.82c0-.085.03-.166.081-.219l2.87-2.931c.07-.07.166-.081.243-.029l7.678 5.816c1.123.778 2.552 1.288 3.861 1.5a.403.403 0 00.464-.404v-3.461c0-.206-.15-.38-.35-.423-.76-.164-1.604-.474-2.244-.918l-6.647-4.953c-.138-.095-.155-.34-.033-.465z\"></path></g></svg>" },
      qoder: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1.2842 1) scale(0.9167)\" fill=\"currentColor\"><path d=\"M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075L11.612.574l-.046.086-.045.086c1.68.886 2.644 2.673 2.644 4.902v4.056a7.928 7.928 0 01-.014.454l-.005.061c-.005.081-.01.164-.018.245a4.897 4.897 0 01-.011.1l-.01.076c-.008.068-.015.135-.025.203l-.018.113-.01.058a9.99 9.99 0 01-.098.513l-.007.03a7.209 7.209 0 01-.074.294l-.024.086c-.027.099-.056.197-.087.296l-.027.085a9.592 9.592 0 01-.111.323l-.033.085-.018.046c-.032.082-.064.166-.098.248-.019.048-.04.096-.061.145l-.007.017a6 6 0 01-.084.187c-.024.056-.05.11-.077.165-.03.061-.058.122-.089.182a9.423 9.423 0 01-.176.332c-.03.056-.062.111-.094.167-.031.053-.062.108-.095.16-.033.055-.066.11-.101.164-.033.053-.065.104-.1.155-.034.055-.07.107-.111.169l-.099.144a15.193 15.193 0 01-.34.457c-.04.05-.08.102-.121.151l-.107.128-.007.008a6.987 6.987 0 01-.262.298l-.149.16-.116.12a9.562 9.562 0 01-.204.198l-.03.03-.072.069a9.05 9.05 0 01-.263.235l-.025.022-.029.026-.042.035a11.7 11.7 0 01-.22.18l-.07.055-.018.013a8.904 8.904 0 01-.194.146c-.029.02-.057.042-.086.063a7.7 7.7 0 01-.22.152l-.057.04a8.865 8.865 0 01-.293.185l-.062.037a10.424 10.424 0 01-.307.173l-.037.02-.196.103-.108.052-.012.006a6.196 6.196 0 01-.315.143c-.065.028-.13.054-.196.08l-.035.014-.086.034c-.07.026-.143.05-.215.075l-.039.014-.064.023a8.056 8.056 0 01-.323.097l-.63.173a7.285 7.285 0 01-.33.08l-.07.015c-.053.012-.104.023-.157.032l-.065.011-.085.015a2.332 2.332 0 01-.194.027l-.085.01a4.715 4.715 0 01-.16.018l-.034.003a4.861 4.861 0 01-.246.016h-.033a2.714 2.714 0 01-.155.005h-.106a3.384 3.384 0 01-.225-.007H4.86l-.15-.012-.066-.006a5.586 5.586 0 01-.187-.02l-.04-.005a5.14 5.14 0 01-.219-.035l-.054-.01a6.943 6.943 0 01-.347-.082l-.03-.008-.038-.01a5.034 5.034 0 01-.269-.086l-.063-.023a4.216 4.216 0 01-.188-.073l-.071-.031-.016-.007a4.959 4.959 0 01-.16-.074l-.026-.013a.164.164 0 00-.014-.007l-.671-.351.486.486h.016l8.995 4.742.093.048.03.014.02.01c.056.026.111.052.169.076l.016.008.073.032.195.076.022.008a.718.718 0 01.03.012l.014.004a4.693 4.693 0 00.323.1l.027.007c.073.02.147.038.22.055l.018.004.027.006.066.013.088.016c.075.014.15.026.226.038l.042.004c.064.009.128.016.193.022l.126.012.06.003.05.002.098.005c.046.002.094.002.14.003h.12c.05 0 .1-.002.161-.005h.033l.07-.004a6.17 6.17 0 00.184-.014l.033-.003a.753.753 0 00.058-.005l.108-.012.081-.01.08-.01.129-.021.082-.014.071-.012c.054-.01.107-.021.16-.033l.066-.013.059-.013c.096-.022.192-.046.287-.073l.63-.172a7.354 7.354 0 00.397-.122l.04-.015c.075-.025.149-.051.222-.078.032-.011.062-.024.093-.037l.03-.012c.067-.027.135-.054.2-.082l.128-.056.195-.09.021-.01.102-.05c.068-.034.135-.069.202-.105l.037-.02.073-.038c.08-.044.16-.092.24-.139l.026-.015a8.086 8.086 0 00.322-.2l.065-.045 1.98.902a1.748 1.748 0 002.472-1.59v-7.33l.004.004z\" fill=\"#2ADB5C\"></path><path d=\"M11.617.576a3.904 3.904 0 00-.093-.047c-.016-.009-.033-.016-.05-.024a5.854 5.854 0 00-.166-.077l-.09-.04a4.094 4.094 0 00-.194-.074c-.017-.006-.035-.015-.053-.02l-.013-.005a5.18 5.18 0 00-.277-.088l-.07-.019a4.034 4.034 0 00-.219-.053c-.015-.003-.03-.008-.044-.012L10.253.1l-.057-.011a5.177 5.177 0 00-.225-.036L9.928.047a5.972 5.972 0 00-.191-.022L9.669.02a1.33 1.33 0 00-.058-.005L9.515.009a4.058 4.058 0 00-.111-.005C9.354 0 9.304 0 9.254 0h-.109c-.052 0-.106.004-.16.004L8.884.01A5.32 5.32 0 008.7.022l-.083.006h-.008c-.05.005-.1.013-.15.019l-.12.014c-.056.008-.112.018-.169.028-.037.006-.074.011-.11.018a7.054 7.054 0 00-.572.133l-.63.172c-.111.031-.22.064-.33.1-.037.011-.072.025-.108.037a12.91 12.91 0 00-.345.126c-.067.027-.133.054-.2.083l-.128.055a11.916 11.916 0 00-.318.15 7.376 7.376 0 00-.311.163c-.082.045-.16.092-.24.14a9.424 9.424 0 00-.35.218l-.016.01-.06.04a9.242 9.242 0 00-.51.37 12.54 12.54 0 00-.315.254l-.043.034-.01.007-.045.041c-.09.078-.18.158-.268.24l-.106.101c-.07.067-.139.135-.207.204l-.056.054-.063.067-.153.164-.12.133-.148.17c-.024.03-.049.057-.073.086l-.043.053a5.96 5.96 0 00-.123.155l-.118.151c-.04.053-.08.106-.118.16l-.075.101-.038.056-.107.155-.11.164a9.91 9.91 0 00-.168.265c-.012.02-.023.043-.037.063a12.43 12.43 0 00-.192.335l-.09.168c-.019.034-.04.07-.057.105-.011.022-.02.043-.032.065l-.092.188-.08.167a19.15 19.15 0 00-.083.192c-.017.038-.035.076-.05.115-.008.016-.014.034-.021.051-.035.083-.067.167-.1.253l-.051.134c-.04.11-.077.22-.113.33l-.02.057c0 .002 0 .005-.002.007l-.008.026c-.032.1-.06.2-.09.301l-.023.089c-.027.1-.052.2-.075.301l-.007.03a7.63 7.63 0 00-.057.267l-.008.048c-.015.074-.026.148-.038.223L.082 8.4c-.011.078-.02.156-.029.234-.006.051-.013.103-.017.154a6.57 6.57 0 00-.02.26c-.003.044-.007.086-.009.13-.004.128-.007.257-.007.386v4.056c0 1.478.42 2.741 1.138 3.692A4.75 4.75 0 002.73 18.67l9.015 4.753c-1.656-.874-2.728-2.685-2.73-5.051v-4.056c0-.13.004-.26.01-.39.002-.043.006-.085.01-.128.005-.088.01-.174.019-.261l.017-.155c.01-.077.018-.155.029-.234l.026-.164c.013-.074.025-.15.039-.223.02-.105.04-.21.064-.313l.008-.031c.023-.1.048-.201.075-.301l.023-.088c.028-.1.058-.202.09-.302l.008-.025.021-.063c.036-.11.073-.22.113-.33l.052-.134c.031-.085.065-.169.1-.253.022-.056.047-.111.07-.166a13.856 13.856 0 01.164-.358c.03-.063.06-.126.092-.188l.088-.172a9.22 9.22 0 01.187-.338l.096-.164c.034-.057.069-.112.104-.168l.1-.159a10.49 10.49 0 01.567-.786l.123-.155.116-.139c.05-.057.098-.115.148-.171a14.092 14.092 0 01.272-.297 9.706 9.706 0 01.432-.425c.088-.083.177-.163.268-.241l.054-.048a10.08 10.08 0 01.553-.435l.092-.068c.075-.053.15-.105.226-.156.019-.013.038-.028.06-.04a9.18 9.18 0 01.362-.227c.08-.047.16-.094.241-.139l.11-.058a7.643 7.643 0 01.521-.256l.126-.056a7.509 7.509 0 01.546-.208l.107-.037c.11-.036.22-.069.33-.1l.63-.172c.095-.026.191-.05.287-.072l.097-.02c.062-.014.125-.029.187-.04l.114-.018c.055-.01.11-.02.166-.028.04-.006.08-.01.12-.014.053-.007.105-.014.157-.019l.083-.006c.061-.005.123-.01.184-.013.034-.003.067-.003.101-.004l.16-.006h.11a3.187 3.187 0 01.261.008l.153.01.067.007c.064.006.128.013.192.022l.043.005a5.232 5.232 0 01.281.047l.141.03c.073.016.146.035.218.053l.07.019c.094.026.187.055.278.087l.067.025a4.326 4.326 0 01.449.19l.143.072L11.617.576z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 92 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 0) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M12.895 22.902c-1.462 0-2.852-.284-4.172-.851a11.449 11.449 0 01-3.517-2.357 10.584 10.584 0 01-2.372-3.487A10.726 10.726 0 012 12c0-1.484.284-2.908.85-4.272.568-1.364 1.353-2.538 2.356-3.52a11.05 11.05 0 013.485-2.357A10.529 10.529 0 0112.895 1c1.483 0 2.89.284 4.22.851a10.91 10.91 0 015.856 5.893c.568 1.353.851 2.772.851 4.256 0 1.55-.305 3.012-.916 4.387a10.697 10.697 0 01-2.552 3.568h3.468v2.947H12.895zm0-18.923a7.886 7.886 0 00-3.06.606 7.87 7.87 0 00-2.568 1.719 7.889 7.889 0 00-1.7 2.57A8.038 8.038 0 004.944 12a7.9 7.9 0 00.605 3.061 7.876 7.876 0 001.717 2.57 7.87 7.87 0 002.569 1.719c.97.403 1.99.605 3.059.605a7.885 7.885 0 003.059-.605 7.87 7.87 0 002.568-1.719 7.877 7.877 0 001.718-2.57A7.9 7.9 0 0020.845 12a8.038 8.038 0 00-.622-3.126 7.89 7.89 0 00-1.7-2.57 7.87 7.87 0 00-2.57-1.72 7.886 7.886 0 00-3.058-.605zM34.717 23a7.87 7.87 0 01-3.174-.655 8.516 8.516 0 01-4.45-4.452 7.884 7.884 0 01-.654-3.176c0-1.135.219-2.215.655-3.24a8.414 8.414 0 011.8-2.685 8.284 8.284 0 012.65-1.785 8.043 8.043 0 013.173-.638c1.134 0 2.214.213 3.239.638a8.19 8.19 0 012.683 1.785 8.198 8.198 0 011.783 2.684 8.379 8.379 0 01.638 3.241 8.058 8.058 0 01-.638 3.176 8.29 8.29 0 01-1.783 2.652 8.409 8.409 0 01-2.683 1.8 8.183 8.183 0 01-3.24.655zm0-13.717c-1.461 0-2.716.524-3.762 1.571a5.455 5.455 0 00-1.178 1.768 5.37 5.37 0 00-.426 2.095c0 .72.142 1.408.426 2.063a5.555 5.555 0 001.177 1.735 5.609 5.609 0 001.718 1.178 5.013 5.013 0 002.045.426c.72 0 1.418-.142 2.094-.425a5.091 5.091 0 001.734-1.18c.48-.501.861-1.08 1.145-1.734a5.137 5.137 0 00.425-2.063c0-.72-.142-1.418-.425-2.095a5.74 5.74 0 00-1.145-1.768 4.936 4.936 0 00-1.718-1.162 5.508 5.508 0 00-2.11-.41zM58.73 22.836v-2.52a7.813 7.813 0 01-2.47 1.964c-.949.48-1.936.72-2.96.72a8.207 8.207 0 01-3.24-.638 7.685 7.685 0 01-2.617-1.817 8.627 8.627 0 01-1.783-2.701 8.258 8.258 0 01-.638-3.225c0-1.135.212-2.21.638-3.225a8.628 8.628 0 011.783-2.7 7.686 7.686 0 012.617-1.818 8.207 8.207 0 013.24-.638c1.133 0 2.164.23 3.09.688a6.712 6.712 0 012.34 1.898V1.098h2.88v21.738h-2.88zm-5.43-13.619c-.72 0-1.408.137-2.062.41a4.972 4.972 0 00-1.701 1.162 5.796 5.796 0 00-1.145 1.751 5.253 5.253 0 00-.426 2.079c0 1.462.524 2.74 1.57 3.83.48.502 1.048.895 1.702 1.179a5.244 5.244 0 004.139 0 5.131 5.131 0 001.717-1.179c1.047-1.09 1.57-2.368 1.57-3.83 0-.72-.141-1.413-.425-2.079a5.795 5.795 0 00-1.145-1.751 4.936 4.936 0 00-1.717-1.163 5.424 5.424 0 00-2.078-.409zm14.395 6.679c0 .524.19 1.07.572 1.637a6.218 6.218 0 001.325 1.44c.916.72 1.985 1.08 3.206 1.08 1.942 0 3.523-.938 4.744-2.815l2.487 1.473c-.85 1.375-1.898 2.434-3.14 3.176A7.832 7.832 0 0172.8 23a8.043 8.043 0 01-3.174-.638 8.283 8.283 0 01-2.65-1.785 8.29 8.29 0 01-1.783-2.651 8.058 8.058 0 01-.638-3.176c0-1.113.212-2.177.638-3.192a8.243 8.243 0 011.783-2.668 7.673 7.673 0 012.633-1.768A8.349 8.349 0 0172.8 6.5c1.113 0 2.176.207 3.19.622a7.67 7.67 0 012.634 1.768c1.614 1.659 2.421 3.58 2.421 5.762 0 .393-.033.807-.098 1.244h-13.25zm5.103-6.711c-.894 0-1.734.196-2.519.589-.785.393-1.412.911-1.881 1.555-.469.644-.703 1.326-.703 2.046h10.207c0-.72-.234-1.402-.703-2.046-.47-.644-1.096-1.162-1.881-1.555a5.553 5.553 0 00-2.52-.59zm18.485.425c-.523-.24-.992-.36-1.406-.36-.873 0-1.593.306-2.16.917-.61.654-.916 1.407-.916 2.259v10.41H83.99v-10.41a6.1 6.1 0 01.9-3.241 6.18 6.18 0 012.47-2.292 5.822 5.822 0 012.519-.557c.72 0 1.406.131 2.06.393.655.262 1.342.688 2.062 1.277L91.284 9.61z\"></path></g></svg>" },
      qwen: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(0 0) scale(1)\"><path d=\"M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z\" fill=\"url(#lobe-icons-qwen-_R_0_)\" fill-rule=\"nonzero\"></path><defs><linearGradient id=\"lobe-icons-qwen-_R_0_\" x1=\"0%\" x2=\"100%\" y1=\"0%\" y2=\"0%\"><stop offset=\"0%\" stop-color=\"#6336E7\" stop-opacity=\".84\"></stop><stop offset=\"100%\" stop-color=\"#6F69F7\" stop-opacity=\".84\"></stop></linearGradient></defs></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 70.81 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 1) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M11.425 14.13h3.642l1.529 1.795a7.89 7.89 0 002.166-2.832 8.36 8.36 0 00.771-3.562c0-2.03-.624-3.664-1.874-4.905-1.24-1.25-2.884-1.874-4.931-1.874-1.028 0-1.99.186-2.885.558A6.99 6.99 0 007.45 4.932 8.576 8.576 0 005.656 7.67a8.354 8.354 0 00-.625 3.19c0 2.003.611 3.643 1.834 4.919 1.223 1.276 2.779 1.914 4.666 1.914.39 0 .793-.031 1.21-.093.425-.062.868-.16 1.329-.293l-2.645-3.177zM18.07 22l-2.127-2.46c-.753.293-1.48.51-2.18.652a9.84 9.84 0 01-2.073.226c-2.97 0-5.326-.85-7.072-2.552C2.873 16.164 2 13.865 2 10.966c0-1.577.28-3.052.837-4.426a10.148 10.148 0 012.406-3.576A10.427 10.427 0 018.713.758C10.025.253 11.429 0 12.927 0c2.915 0 5.25.86 7.005 2.579 1.755 1.72 2.632 4.01 2.632 6.872 0 1.764-.354 3.399-1.063 4.905a10.156 10.156 0 01-3.031 3.776L21.714 22H18.07zm5.743-14.675h2.884l2.047 6.433.054.16c.248.789.38 1.373.399 1.755.097-.302.221-.62.372-.958.16-.345.354-.713.585-1.103l4.227-7.218 2.06 7.43c.08.275.146.559.2.851.053.293.097.63.133 1.01.132-.372.265-.708.398-1.01.142-.3.28-.562.412-.784l3.816-6.567h3.243L36.097 20.71l-2.127-7.045a8.683 8.683 0 01-.213-.798 17.846 17.846 0 01-.146-.97 69.17 69.17 0 01-.519 1.063c-.15.302-.265.514-.345.638l-4.28 7.112-4.653-13.385zm24.392 4.785h6.5c-.026-.85-.292-1.52-.797-2.007-.496-.497-1.166-.745-2.008-.745-.957 0-1.768.248-2.432.745-.665.496-1.086 1.165-1.263 2.007zm6.34 3.948l2.061 1.608c-.735.966-1.533 1.67-2.392 2.114-.86.443-1.848.665-2.965.665-1.87 0-3.38-.563-4.533-1.689-1.152-1.134-1.728-2.623-1.728-4.466 0-2.162.66-3.935 1.98-5.317 1.33-1.391 3.018-2.087 5.066-2.087 1.71 0 3.07.532 4.08 1.595 1.02 1.055 1.53 2.473 1.53 4.254 0 .15-.01.345-.027.585-.01.23-.027.51-.054.837h-9.61c0 1.143.288 2.056.864 2.738.576.674 1.342 1.01 2.3 1.01.664 0 1.293-.159 1.887-.478a4.633 4.633 0 001.542-1.369zm14.317 3.868l.957-7.244c.018-.133.031-.27.04-.412.009-.151.013-.368.013-.652 0-.824-.2-1.453-.598-1.887-.399-.444-.98-.665-1.741-.665-1.188 0-2.118.385-2.792 1.156-.673.763-1.112 1.937-1.316 3.523l-.797 6.181H59.77l1.661-12.601h2.752l-.213 1.515c.727-.664 1.476-1.156 2.247-1.475a6.5 6.5 0 012.486-.479c1.293 0 2.3.341 3.017 1.024.727.673 1.09 1.622 1.09 2.845 0 .31-.018.673-.053 1.09-.036.407-.089.886-.16 1.435l-.877 6.647h-2.858z\"></path></g></svg>" },
      cline: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(0.9679 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003v1.667l1.45 2.896a1.01 1.01 0 01-.002.909l-1.448 2.864v1.668c0 2.762-2.23 5.002-4.98 5.002H7.074c-2.751 0-4.98-2.24-4.98-5.002V17.33l-1.48-2.855a1.01 1.01 0 01-.003-.927l1.482-2.887V8.994c0-2.763 2.23-5.003 4.98-5.003h9.962zM8.265 9.6a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 004.547 0v-4.042A2.274 2.274 0 008.265 9.6zm7.326 0a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 104.548 0v-4.042A2.274 2.274 0 0015.59 9.6z\"></path><path d=\"M12.054 5.558a2.779 2.779 0 100-5.558 2.779 2.779 0 000 5.558z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 83.96 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 1) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M79.558 21.986c-1.13 0-2.167-.189-3.108-.565a7.128 7.128 0 01-2.403-1.569 6.933 6.933 0 01-1.554-2.331 7.876 7.876 0 01-.537-2.925v-.58c0-1.196.189-2.279.566-3.25.376-.97.894-1.798 1.554-2.486a6.84 6.84 0 012.289-1.582 7.005 7.005 0 012.797-.566c1.103 0 2.078.189 2.925.566.848.367 1.56.88 2.134 1.54.575.668 1.008 1.464 1.3 2.388.292.923.438 1.93.438 3.023v1.456H75.362v.07c.103.67.263 1.23.48 1.682.217.452.513.857.89 1.215.377.377.82.669 1.328.876.518.207 1.084.31 1.696.31.838 0 1.62-.16 2.346-.48a4.71 4.71 0 001.794-1.398l1.808 1.752c-.508.734-1.29 1.394-2.345 1.978-1.046.584-2.313.876-3.8.876zm-.41-13.113c-.48 0-.927.09-1.342.269-.405.17-.768.414-1.088.735-.32.33-.589.725-.805 1.187a6.25 6.25 0 00-.48 1.568h7.191v-.226c0-.443-.08-.88-.24-1.314a3.545 3.545 0 00-.678-1.159 3.004 3.004 0 00-1.074-.763c-.424-.198-.919-.297-1.484-.297zM55.043 21.703V6.415h3.052l.212 2.176c.207-.292.433-.56.678-.805.255-.255.523-.48.806-.679a5.555 5.555 0 013.179-.975 6.5 6.5 0 012.148.34 4.11 4.11 0 011.667 1.073c.461.49.82 1.117 1.074 1.88.254.753.381 1.667.381 2.74v9.538h-3.377v-9.48c0-.632-.07-1.16-.212-1.583-.141-.424-.348-.763-.621-1.018a2.3 2.3 0 00-.99-.537 4.736 4.736 0 00-1.328-.17c-.414 0-.8.057-1.158.17a3.421 3.421 0 00-1.611 1.004 4.282 4.282 0 00-.523.706v10.908h-3.377zM38.44 6.415h8.111v12.49h4.493v2.798H38.441v-2.797h4.705v-9.68H38.44V6.416zm4.395-3.956c0-.274.047-.523.141-.75a1.69 1.69 0 01.41-.607c.17-.16.372-.282.607-.367.245-.094.519-.141.82-.141.509 0 .918.131 1.23.395.32.254.503.584.55.99.066.414-.004.776-.212 1.087-.207.302-.508.504-.904.608a1.48 1.48 0 01-.706.353c-.273.057-.575.033-.905-.07a1.396 1.396 0 01-.777-.552 1.758 1.758 0 01-.254-.946zM20.934 0h8.238v18.906h4.634v2.797H20.934v-2.797h4.832V2.812h-4.832V0zM16.71 15.373c-.095.999-.33 1.908-.707 2.727a6.672 6.672 0 01-1.484 2.077 6.542 6.542 0 01-2.218 1.357c-.848.31-1.79.466-2.826.466-.848 0-1.63-.113-2.346-.339a6.467 6.467 0 01-1.893-.99 6.55 6.55 0 01-1.413-1.426 9.438 9.438 0 01-1.003-1.851c-.274-.66-.48-1.375-.622-2.148A14.34 14.34 0 012 12.83v-2.812c0-.8.066-1.573.198-2.317.132-.744.33-1.446.593-2.106A8.284 8.284 0 013.88 3.603a7.296 7.296 0 011.555-1.54 6.953 6.953 0 011.836-.904A7.256 7.256 0 019.49.834c1.083 0 2.049.16 2.896.48.858.32 1.588.773 2.19 1.357a6.337 6.337 0 011.442 2.147c.358.839.588 1.771.692 2.798h-3.391a6.568 6.568 0 00-.353-1.653c-.17-.5-.405-.923-.707-1.272a2.977 2.977 0 00-1.144-.791c-.453-.188-.994-.283-1.625-.283-.443 0-.843.062-1.201.184-.349.122-.66.297-.933.523a3.385 3.385 0 00-.947 1.074 7.033 7.033 0 00-.607 1.455c-.123.471-.217.975-.283 1.512a15.25 15.25 0 00-.084 1.625v2.84c0 .688.037 1.333.113 1.936.084.602.212 1.154.381 1.653.132.414.297.791.495 1.13.207.34.452.631.734.876.292.264.627.466 1.004.608.386.132.824.198 1.314.198.584 0 1.102-.085 1.554-.255.452-.17.838-.419 1.159-.749.31-.32.56-.72.748-1.2.189-.481.311-1.032.368-1.654h3.405z\"></path></g></svg>" },
      goose: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M21.595 23.61c1.167-.254 2.405-.944 2.405-.944l-2.167-1.784a12.124 12.124 0 01-2.695-3.131 12.127 12.127 0 00-3.97-4.049l-.794-.462a1.115 1.115 0 01-.488-.815.844.844 0 01.154-.575c.413-.582 2.548-3.115 2.94-3.44.503-.416 1.065-.762 1.586-1.159.074-.056.148-.112.221-.17.003-.002.007-.004.009-.007.167-.131.325-.272.45-.438.453-.524.563-.988.59-1.193-.061-.197-.244-.639-.753-1.148.319.02.705.272 1.056.569.235-.376.481-.773.727-1.171.165-.266-.08-.465-.086-.471h-.001V3.22c-.007-.007-.206-.25-.471-.086-.567.35-1.134.702-1.639 1.021 0 0-.597-.012-1.305.599a2.464 2.464 0 00-.438.45l-.007.009c-.058.072-.114.147-.17.221-.397.521-.743 1.083-1.16 1.587-.323.391-2.857 2.526-3.44 2.94a.842.842 0 01-.574.153 1.115 1.115 0 01-.815-.488l-.462-.794a12.123 12.123 0 00-4.049-3.97 12.133 12.133 0 01-3.13-2.695L1.332 0S.643 1.238.39 2.405c.352.428 1.27 1.49 2.34 2.302C1.58 4.167.73 3.75.06 3.4c-.103.765-.063 1.92.043 2.816.726.317 1.961.806 3.219 1.066-1.006.236-2.11.278-2.961.262.15.554.358 1.119.64 1.688.119.263.25.52.39.77.452.125 2.222.383 3.164.171l-2.51.897a27.776 27.776 0 002.544 2.726c2.031-1.092 2.494-1.241 4.018-2.238-2.467 2.008-3.108 2.828-3.8 3.67l-.483.678c-.25.351-.469.725-.65 1.117-.61 1.31-1.47 4.1-1.47 4.1-.154.486.202.842.674.674 0 0 2.79-.861 4.1-1.47.392-.182.766-.4 1.118-.65l.677-.483c.227-.187.453-.37.701-.586 0 0 1.705 2.02 3.458 3.349l.896-2.511c-.211.942.046 2.712.17 3.163.252.142.509.272.772.392.569.28 1.134.49 1.688.64-.016-.853.026-1.956.261-2.962.26 1.258.75 2.493 1.067 3.219.895.106 2.051.146 2.816.043a73.87 73.87 0 01-1.308-2.67c.811 1.07 1.874 1.988 2.302 2.34h-.001z\"></path></g></svg>", word: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 82.89 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(-2 -1) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M17.122 16.607c0 4.696-3.219 7.393-7.774 7.393-3.674 0-6.255-1.546-7.257-4.637l3.401-1.21c.486 1.786 1.852 2.907 3.856 2.907 2.46 0 4.13-1.211 4.13-4.12v-1.122c-.85 1.121-2.46 2-4.494 2C4.61 17.818 2 14.273 2 9.909 2 5.546 4.611 2 8.984 2c2.004 0 3.644.879 4.494 2V2.303h3.644v14.303zm-3.583-6.85c0-2.908-1.58-4.575-3.857-4.575-2.52 0-4.008 1.757-4.008 4.727 0 2.94 1.488 4.727 4.008 4.727 2.278 0 3.857-1.666 3.857-4.515v-.363zM35.546 10.273c0 4.94-3.188 8.273-7.683 8.273-4.494 0-7.682-3.334-7.682-8.273C20.181 5.333 23.37 2 27.863 2c4.495 0 7.683 3.333 7.683 8.273zm-11.69 0c0 3.242 1.548 5.212 4.007 5.212 2.46 0 4.009-1.97 4.009-5.212 0-3.243-1.549-5.212-4.009-5.212-2.46 0-4.008 1.97-4.008 5.212zM52.957 10.273c0 4.94-3.188 8.273-7.682 8.273s-7.682-3.334-7.682-8.273C37.593 5.333 40.78 2 45.275 2s7.682 3.333 7.682 8.273zm-11.69 0c0 3.242 1.548 5.212 4.008 5.212s4.008-1.97 4.008-5.212c0-3.243-1.549-5.212-4.008-5.212-2.46 0-4.008 1.97-4.008 5.212zM54.336 15.182L57.069 13c.941 1.546 2.763 2.576 4.615 2.576 1.549 0 2.976-.546 2.976-1.97 0-1.364-1.336-1.515-3.856-2.03-2.52-.515-5.405-1.152-5.405-4.546 0-2.909 2.55-5.03 6.224-5.03 2.794 0 5.284 1.242 6.438 3L65.6 7.212c-.91-1.424-2.429-2.242-4.19-2.242-1.488 0-2.46.666-2.46 1.727 0 1.152 1.154 1.364 3.158 1.788 2.703.576 6.104 1.151 6.104 4.788 0 3.211-2.946 5.273-6.56 5.273-2.945 0-5.89-1.182-7.317-3.364zM77.965 18.546c-4.555 0-7.743-3.364-7.743-8.273 0-4.667 3.157-8.273 7.59-8.273 4.616 0 7.076 3.485 7.076 7.849v1.212H73.713c.274 2.727 1.913 4.394 4.252 4.394 1.791 0 3.218-.91 3.704-2.546l3.128 1.182c-1.124 2.787-3.644 4.455-6.832 4.455zm-.183-13.485c-1.882 0-3.34 1.12-3.886 3.272h7.318c-.03-1.757-1.124-3.272-3.432-3.272z\"></path></g></svg>" },
      pi: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(0 0) scale(1)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path clip-rule=\"evenodd\" d=\"M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z\"></path><path d=\"M17.5 12H23v11h-5.5V12z\"></path></g></svg>", word: null },
      hermes: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(0.5417 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z\"></path><path d=\"M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z\"></path><path clip-rule=\"evenodd\" d=\"M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z\"></path></g></svg>", word: null },
      zcode: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z\"></path></g></svg>", word: null },
      dsh: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1.1558) scale(0.9167)\"><path d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\" fill=\"#4D6BFE\"></path></g></svg>", word: null },
      chatgpt: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1.0963) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path></g></svg>", word: null },
      mimocode: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 0.7433) scale(0.9167)\" fill=\"currentColor\" fill-rule=\"evenodd\"><path d=\"M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z\"></path></g></svg>", word: null },
      reasonix: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.0215)\"><g transform=\"scale(2.56)\">\n    <rect width=\"400\" height=\"400\" rx=\"126.37\" ry=\"126.37\" fill=\"#0153e5\"/>\n    <path fill=\"#fff\" d=\"M253.29,235.46l.02-.02c14.11-4.16,26.51-11.63,36.45-22.4v-.04c10.82-12.11,17.61-26.76,19.97-42.87,5.39-35.23-12.1-67.41-45.05-81.04-11.59-4.65-23.48-6.64-36.12-6.52l-122.5.04v234.74l60.22-.05v-79.23c6.57,2.11,13.49,3.25,20.59,3.22l19.71,27.21,35.83,48.92,71.52-.1-60.64-81.87ZM250.87,224.64c-8.21,2.71-17.01,2.31-25.39-.14-14.4-10.89-22.2-22.51-34.48-33.59-15.72-14.19-36.52-24.02-57.83-23.06,1.7-4.65,4.14-9.09,7.31-13.16,11-13.74,26-18.1,43.24-15.69,6.36.89,13.16-6.58,26.1-5.14.86.1,1.75.75,1.83,1.27.3,1.77-4.71,2.72-4.71,7.55,0,2.03.91,4.39,2.83,5.73,6.6,4.63,12.32,9.83,18.3,15.21,2.91,2.61,12.76,9.96,15.26,3.98,1.47-3.49,2.43-7.15,3.4-10.86.48-1.84-.54-2.93-2.02-3.8-10.17-6.03-13.99-18.56-10.02-29.67.38-1.07,1.38-1.59,2.22-1.63,3.41-.15,1.59,6.18,10.04,8.78,8.01,2.48,8.25,9.13,12.14,6.47,9.07-6.18,12.34-1.12,20.76-9.05.86-.81,2.36-.87,3.25-.25.56.38,1.04,1.38.99,2.55-.25,6.7-2.86,13.1-7.44,18.01-8.66,9.29-15.93,4.84-16.4,11.36-1.38,19.11-7.63,38.18-21.19,52.06-.44.45-.69,1.08-.62,1.51.07.45.61.89,1.2,1.08l11.42,3.89c1.61.55,2.79,2,2.58,3.54-.18,1.35-1.26,2.54-2.79,3.05Z\"/>\n  </g></g></svg>", word: null },
      continue: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1.7728) scale(0.8634)\" fill=\"none\"><path d=\"M20.5286 3.26811L19.1512 5.65694L22.6328 11.6849C22.6582 11.7306 22.6735 11.7866 22.6735 11.8374C22.6735 11.8882 22.6582 11.9441 22.6328 11.9899L19.1512 18.0229L20.5286 20.4117L25.4791 11.8374L20.5286 3.26303V3.26811ZM18.6176 5.3469L19.995 2.95807H17.2402L15.8628 5.3469H18.6227H18.6176ZM15.8577 5.96697L19.075 11.5324H21.8298L18.6176 5.96697H15.8577ZM18.6176 17.7179L21.8298 12.1474H19.075L15.8577 17.7179H18.6176ZM15.8577 18.338L17.2351 20.7167H19.9899L18.6125 18.338H15.8526H15.8577ZM6.52098 21.3063C6.46507 21.3063 6.41424 21.291 6.3685 21.2656C6.32276 21.2402 6.28209 21.1995 6.25668 21.1538L2.77002 15.1207H0.0152482L4.9657 23.69H14.8615L13.4841 21.3063H6.52606H6.52098ZM14.0178 20.9962L15.3952 23.38L16.7726 20.9911L15.3952 18.6023L14.0178 20.9911V20.9962ZM14.8615 18.2974H8.43712L7.05973 20.6862H13.4841L14.8615 18.2974ZM7.89836 17.9924L4.68108 12.4219L3.30369 14.8107L6.52098 20.3812L7.89836 17.9924ZM0.0101654 14.5007H2.76494L4.14232 12.1118H1.39263L0.0101654 14.5007ZM6.24143 2.5413C6.26685 2.49556 6.30751 2.4549 6.35325 2.42948C6.399 2.40407 6.4549 2.38882 6.50573 2.38882H13.474L14.8514 0H4.95045L0 8.57435H2.75477L6.23127 2.54638L6.24143 2.5413ZM4.14232 11.5782L2.76494 9.18934H0.0101654L1.38755 11.5782H4.14232ZM6.51081 3.31386L3.29861 8.8793L4.67599 11.2681L7.8882 5.70268L6.51081 3.31386ZM13.4791 3.00382H7.04448L8.42187 5.39264H14.8564L13.4791 3.00382ZM15.3952 5.0826L16.7675 2.69886L15.3952 0.310038L14.0178 2.69378L15.3952 5.0826Z\" fill=\"black\"></path></g></svg>", word: null },
      zed: { mark: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" style=\"height:1em;width:auto;display:block\"><g transform=\"translate(1 1) scale(0.2292)\" fill=\"none\"><g clip-path=\"url(#clip0_1957_1318)\">\n<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M9 6C7.34315 6 6 7.34315 6 9V75H0V9C0 4.02944 4.02944 0 9 0H89.3787C93.3878 0 95.3955 4.84715 92.5607 7.68198L43.0551 57.1875H57V51H63V58.6875C63 61.1728 60.9853 63.1875 58.5 63.1875H37.0551L26.7426 73.5H73.5V36H79.5V73.5C79.5 76.8137 76.8137 79.5 73.5 79.5H20.7426L10.2426 90H87C88.6569 90 90 88.6569 90 87V21H96V87C96 91.9706 91.9706 96 87 96H6.62132C2.61224 96 0.604504 91.1529 3.43934 88.318L52.7574 39H39V45H33V37.5C33 35.0147 35.0147 33 37.5 33H58.7574L69.2574 22.5H22.5V60H16.5V22.5C16.5 19.1863 19.1863 16.5 22.5 16.5H75.2574L85.7574 6H9Z\" fill=\"black\"/>\n</g>\n<defs>\n<clipPath id=\"clip0_1957_1318\">\n<rect width=\"96\" height=\"96\" fill=\"white\"/>\n</clipPath>\n</defs></g></svg>", word: null },
    };

    // 窄宽降级用内联 SVG 图标（stroke 风格，继承 currentColor 随按钮文字色走明暗主题）。
    function Icon({ name, size = 14, strokeWidth = 2 }) {
      const common = {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, style: { flex: "none", display: "block" },
      };
      const shapes = {
        checkSquare: React.createElement(React.Fragment, null,
          React.createElement("rect", { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
          React.createElement("path", { d: "m9 12 2 2 4-4" })),
        x: React.createElement(React.Fragment, null,
          React.createElement("path", { d: "M18 6 6 18M6 6l12 12" })),
        refresh: React.createElement(React.Fragment, null,
          React.createElement("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
          React.createElement("path", { d: "M21 3v6h-6" })),
        circle: React.createElement("circle", { cx: 12, cy: 12, r: 9 }),
        checkCircle: React.createElement(React.Fragment, null,
          React.createElement("circle", { cx: 12, cy: 12, r: 9 }),
          React.createElement("path", { d: "m9 12 2 2 4-4" })),
        chevronLeft: React.createElement("path", { d: "m15 18-6-6 6-6" }),
        chevronRight: React.createElement("path", { d: "m9 18 6-6-6-6" }),
        search: React.createElement(React.Fragment, null,
          React.createElement("circle", { cx: 11, cy: 11, r: 7 }),
          React.createElement("path", { d: "m21 21-4.3-4.3" })),
        check: React.createElement("path", { d: "m4.5 12.5 5 5 10.5-11" }),
        // 折叠箭头（分组头，悬停才出现；收起时整体 rotate(-90deg)）
        chevronDown: React.createElement("path", { d: "m6 9 6 6 6-6" }),
      };
      return React.createElement("svg", common, shapes[name]);
    }

    // 选中态遮罩：强调色亮（HSV V > 40）用固定黑遮罩，暗用固定白遮罩，保证勾选图标的
    // 对比。V 按 0-100 计（max(R,G,B)/255*100）。palette.accent 是 CSS 变量，借一个临时
    // 元素让浏览器解析成 rgb() 再算；结果按 accent 值缓存，主题切换时才重算。
    let accentOverlayCache = { accent: null, color: "#000" };
    function overlayColorForAccent(accent) {
      if (accentOverlayCache.accent === accent) return accentOverlayCache.color;
      let color = "#000";
      try {
        if (typeof document !== "undefined") {
          const probe = document.createElement("span");
          probe.style.color = accent;
          document.body.appendChild(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          const m = resolved.match(/rgba?\(([^)]+)\)/i);
          if (m) {
            const [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
            const v = (Math.max(r || 0, g || 0, b || 0) / 255) * 100;
            color = v > 40 ? "#000" : "#fff";
          }
        }
      } catch {
        // 解析失败按亮色处理（黑遮罩），与默认主题一致
      }
      accentOverlayCache = { accent, color };
      return color;
    }
    /** 品牌标：有 lobehub 官方标的来源（SOURCE_LOGOS，见 logos.js）直接内联官方 mark；
     *  其余回退 SOURCE_BADGES 的手绘卡——带 svg 的直接内联（多数自带白卡），只带 path 的套
     *  同一白卡（simple-icons 单色 brand 标），两者都没有的按格式首字母兜底。徽标卡（26px）
     *  与下拉行（16px）共用这一份绘制，尺寸与额外样式由调用方给。svg 是静态受信标记，经
     *  dangerouslySetInnerHTML 注入。mono 标（cursor / opencode / hermes / ZCode 等）用
     *  currentColor 随主题走；画在固定白卡上时由卡片把 color 钉成深色（见 SourceBadge）。 */
    function BrandMark({ id, format, size = 16, style }) {
      const key = format || SOURCE_MARK_KEY[id] || id;
      const box = { width: size, height: size, flex: "none", display: "block", ...(style || {}) };
      const logo = sourceLogo(key);
      if (logo) {
        return React.createElement("span", {
          style: { ...box, fontSize: size + "px", lineHeight: 0 },
          "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.mark },
        });
      }
      const badge = SOURCE_BADGES[key] || { color: "#64748B", text: String(key || "?").slice(0, 2).toUpperCase() };
      if (badge.svg) {
        return React.createElement("span", {
          style: box, "aria-hidden": true, dangerouslySetInnerHTML: { __html: badge.svg },
        });
      }
      if (badge.path) {
        return React.createElement("svg", {
          viewBox: "-4 -4 32 32", width: size, height: size, "aria-hidden": true, style: box,
        }, React.createElement("rect", { x: -4, y: -4, width: 32, height: 32, rx: 6, fill: "#fff" }),
          React.createElement("path", { d: badge.path, fill: badge.color }));
      }
      return React.createElement("span", {
        style: {
          ...box, borderRadius: "4px", background: "#ffffff", color: badge.color, fontWeight: 700,
          lineHeight: size + "px", textAlign: "center", letterSpacing: "-0.02em",
          fontSize: size * (badge.text.length <= 1 ? 0.46 : badge.text.length === 2 ? 0.4 : 0.34),
        },
        "aria-hidden": true,
      }, badge.text);
    }

    // 屏读器专用文本（视觉上不可见，但留在可访问树里）：字标是画出来的，名称必须仍有文字承担
    const srOnly = {
      position: "absolute", width: "1px", height: "1px", overflow: "hidden",
      clipPath: "inset(50%)", whiteSpace: "nowrap",
    };

    // 锁标的排版口径（固定值，不随品牌变）：品牌标占 16px 见方的槽位（与 selectMarkSlot
    // 同宽，无标行也占这一格），文字 / 字标一律从 16 + 8 = 24px 起——这就是「一排行文字对齐」
    // 的全部机制。字标渲染高 11px（logos.js 里 ink 已归一到 24 单位中的 22，字面高 ≈ 10px，
    // 与 13px 标签的字面高相当）。
    const LOCKUP_SLOT = 16;
    const LOCKUP_GAP = 8;
    const LOCKUP_WORD_H = 11;

    /** 品牌锁标：mark + 字标（或标签文本）。没有字标的品牌（Pi）、字标拼的不是我们展示的
     *  名字的（Hermes / ZCode / DSH 展示的是工具名而非厂商名）退回「品牌标 + 可见标签文本」。
     *  整块是装饰：字标行的名称由 srOnly 文本承担，图形自身 aria-hidden。没有官方品牌标的
     *  来源返回 null，调用方按原样画手绘卡 + 文本。 */
    function SourceLockup({ id, label, size = LOCKUP_SLOT }) {
      const logo = sourceLogo(id);
      if (!logo) return null;
      const mark = React.createElement("span", {
        style: { width: size + "px", height: size + "px", fontSize: size + "px", lineHeight: 0, flex: "none", display: "block" },
        "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.mark },
      });
      return React.createElement("span", {
        style: { display: "inline-flex", alignItems: "center", gap: LOCKUP_GAP + "px", flex: "0 0 auto", minWidth: 0 },
      },
        mark,
        logo.word
          ? React.createElement("span", {
            style: { height: LOCKUP_WORD_H + "px", fontSize: LOCKUP_WORD_H + "px", lineHeight: 0, flex: "none", display: "block" },
            "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.word },
          })
          : React.createElement("span", { style: { fontSize: "13px", lineHeight: "20px", whiteSpace: "nowrap" } }, label),
        logo.word ? React.createElement("span", { style: srOnly }, label) : null);
    }

    // 来源徽标：白色圆角卡 + 品牌标/缩写。它是**纯指示器**——身份是「来源标识 + 选中态
    // 指示」（选中时叠半透明黑/白遮罩 + 带环 tick，环/勾用强调色），勾选入口在消息体上
    // （见 discovery.js 的 SessionRow）。故这里不挂 checkbox 角色、不接收点击：多一个点不
    // 动的键盘停靠点只会让人以为它才是勾选位。path 条目套同一白卡渲染为单色 brand 标。
    function SourceBadge({ format, checked, size = 26, title, disabled, palette }) {
      const card = {
        // color 钉深色：卡片底色恒为白，mono 品牌标（currentColor）在暗色主题下才不会画成白
        width: size, height: size, borderRadius: "6px", background: "#ffffff", color: "#111216", flex: "none", alignSelf: "center",
        cursor: "default", display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative", overflow: "hidden",
        padding: 0, opacity: disabled ? 0.5 : 1,
      };
      const logo = React.createElement(BrandMark, { format, size });
      const overlay = checked
        ? React.createElement("div", { style: { position: "absolute", inset: 0, background: palette.overlay || overlayColorForAccent(palette.accent), opacity: 0.6 } })
        : null;
      const check = checked
        ? React.createElement("svg", {
          viewBox: "0 0 24 24", width: size, height: size, fill: "none",
          stroke: palette.accent, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
          style: { position: "absolute", inset: 0 }, "aria-hidden": true,
        }, React.createElement("circle", { cx: 12, cy: 12, r: 10 }), React.createElement("path", { d: "M7.5 12.5l3 3 6-7" }))
        : null;
      return React.createElement("div", {
        style: card, title, "aria-hidden": true, // 只作视觉指示；勾选控件在消息体上（有 aria-label / aria-checked）
      }, logo, overlay, check);
    }

    // 面板容器宽度跟踪：侧边栏可拖宽，面板随之变窄；ResizeObserver 不可用时回退
    // window resize（宽窄降级仍可用，只是不跟踪拖拽的每一帧）。初始 0 = 未知 → 按
    // 宽态渲染，测量后若低于阈值再降级（避免窄面板首帧先闪文字再跳图标）。
    function useContainerWidth() {
      const ref = useRef(null);
      const [width, setWidth] = useState(0);
      useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const update = () => setWidth(el.getBoundingClientRect().width);
        update();
        if (typeof ResizeObserver === "function") {
          const ro = new ResizeObserver(update);
          ro.observe(el);
          return () => ro.disconnect();
        }
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
      }, []);
      return [ref, width];
    }

    // 颜色一律走 DSH 标准设计令牌（--dsw-alias-* / --dsw-specific-*）：这些 CSS 变量
    // 由 ui-theme 挂在 body 上，随 data-ds-dark-theme 自动切换，插件不再自建明暗色板。
    // 文本用 label-primary/secondary/tertiary 语义色板；按钮/强调用 brand-primary 强调色
    //（即 DSH 主按钮 button-primary-fill 的预设），按钮文字用 label-primary-foreground 反色。
    const themeColors = () => ({
      bg: "var(--dsw-specific-menu)",
      // 宿主菜单面是**半透明**的（深色 #30313680 / 浅色 #f8f9fa94），它必须和宿主 Menu
      // 一样配一层背景模糊才是一块能读的卡片——少了 backdrop-filter，深色主题下弹层会
      // 真的透出后面的会话列表（浅色主题被皮肤定成了不透明白，所以只有深色会露馅）。
      menuBlur: "var(--dsw-menu-backdrop-filter)",
      elevation: "var(--dsw-elevation-prominent)",
      // 不透明明面：必须挡住下面内容的表面（sticky 分组头、模态卡片）用它，别用半透明的 bg
      surface: "var(--dsw-alias-bg-layer-3)",
      border: "var(--dsw-alias-border-l2)",
      field: "var(--dsw-alias-bg-layer-1)",
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      dimmer: "var(--dsw-alias-label-tertiary)",
      accent: "var(--dsw-alias-brand-primary)",
      accentForeground: "var(--dsw-alias-label-primary-foreground)",
      hover: "var(--dsw-alias-interactive-bg-hover)",
      success: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    });

    const makeStyles = (C) => ({
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border },
      // 无分隔线的选择行：来源 / 导入到 / 工作区三行同属一组，行间不画横线
      //（组与下方搜索区的分界由 searchRow 的 borderTop 一条线承担）
      // position: relative —— 下拉弹层对着这一行定位（触发器根节点不定位），弹层宽度 = 行宽，
      // 面板再窄也不会把弹层挤出左/右边界
      // alignItems: baseline —— 触发器与「从 / 导入到 / 工作区」这些 label 按文字基线对齐，
      // 三者的字形底边在同一条线上（居中会因为各自盒高不同而错开）
      rowPlain: { position: "relative", display: "flex", gap: "8px", alignItems: "baseline", padding: "8px 12px" },
      // 来源与落点之间的连接词（「导入到」），把两个下拉读成一句话
      rowJoin: { color: C.dim, flex: "none", fontSize: "13px", lineHeight: "20px", whiteSpace: "nowrap" },
      targetHint: { padding: "0 16px 10px", fontSize: "12px", color: C.dimmer, lineHeight: 1.5 },
      select: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "6px 8px", fontSize: "13px", outline: "none",
      },
      // 下拉触发器：无边框、无输入框外观（claude-style 模型选择器同款）——hover / 展开时
      // 由调用方补一层背景矩形（颜色走 colors.hover，即 --dsw-alias-interactive-bg-hover，
      // 皮肤里被重定向到它自己的 hover 色）。矩形的宽度贴着内容，所以这里不 flex-grow。
      // 触发器根节点：只做尺寸约束，不定位（弹层挂在行上），也不占满行——芯片贴着内容，
      // 同一行可以并排两个下拉
      selectRoot: { display: "flex", minWidth: 0, flex: "0 1 auto" },
      selectTrigger: {
        display: "inline-flex", alignItems: "center", gap: "6px", flex: "0 1 auto",
        maxWidth: "100%", minWidth: 0, height: "28px", padding: "0 6px",
        // 边框 / 圆角 / 文字色与工具栏（筛选）按钮同款：1px border-l2 + 8px 圆角 + label-primary
        background: "transparent", border: "1px solid " + C.border, borderRadius: "8px",
        color: C.text, font: "inherit", fontSize: "13px", fontWeight: 400, lineHeight: "20px",
        textAlign: "left", boxSizing: "border-box",
      },
      // 行首品牌标槽位：定宽 16px——没有品牌标的行（全部来源 / 工作区）也占住这一格，
      // 文字与有标行左对齐
      selectMarkSlot: {
        flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
        width: "16px", height: "16px", borderRadius: "4px", overflow: "hidden",
      },
      selectValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      // 弹层容器：12px 圆角 + 6px 内边距，行距 2px（二级弹层的尺寸口径）
      selectPopover: {
        position: "absolute", top: "calc(100% + 2px)", left: "12px", right: "12px", minWidth: "200px", zIndex: 30,
        display: "flex", flexDirection: "column", gap: "4px", boxSizing: "border-box",
        padding: "6px", background: C.bg, border: "1px solid " + C.border, borderRadius: "12px",
        // 宿主 Menu 同款三件套：半透明面 + 背景模糊 + 官方投影（见 themeColors 的注释）
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation,
      },
      selectSearchRow: { display: "flex", alignItems: "center", gap: "6px", padding: "2px 8px 4px" },
      // 搜索框与列表之间的横线：独立元素、撑满弹层（负外边距抵消容器 6px 内边距）。
      // 颜色用 border-l2——宿主自己的菜单分隔线（Menu.module.css .footer）就是这条，
      // l1 在菜单底色上几乎不可见。
      selectDivider: { height: "1px", flex: "none", background: C.border, margin: "0 -6px" },
      selectSearchIcon: { display: "inline-flex", alignItems: "center", flex: "none", color: C.dimmer },
      selectSearchInput: {
        flex: "1", minWidth: 0, background: "transparent", border: "none", outline: "none",
        color: C.text, fontSize: "13px", lineHeight: "20px", padding: "2px 0",
      },
      // maxHeight 由组件按可用窗口高度写内联（自适应，见 tabs.js），这里只管排版
      selectList: { display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto", overflowX: "hidden" },
      selectRow: {
        display: "flex", alignItems: "center", gap: "8px", width: "100%", minHeight: "30px",
        padding: "3px 8px", background: "transparent", border: "none", borderRadius: "6px",
        color: C.text, font: "inherit", fontSize: "13px", textAlign: "left", cursor: "pointer",
        boxSizing: "border-box",
      },
      // 主标签（文件夹名 / 来源名）不参与收缩：flex 分摊哪怕只压掉 0.0x px，Chromium 也会
      // 立刻画省略号。空间不够时先由副标题（shrink 1000）吃干净；只有标签自己就超过行宽时，
      // max-width 才把它压到行宽并截断。
      selectRowText: {
        flex: "0 0 auto", maxWidth: "100%", minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      // 副标题（工作区的绝对路径）：更淡更小，过长截断（全文留在 title 里）
      selectRowSub: {
        // shrink 取极大值：空间不够时先把副标题（路径）压到 0，再轮到主标签（文件夹名）——
        // flex 的收缩量按「shrink × 基准宽度」分摊，1000 对 1 等于路径先被吃干净
        flex: "0 1000 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: C.dimmer, fontSize: "12px",
      },
      selectCheck: { display: "inline-flex", alignItems: "center", flex: "none", marginLeft: "auto", color: C.accent },
      selectEmpty: { padding: "8px", color: C.dimmer, fontSize: "12px", textAlign: "center" },
      // 搜索行：输入 + 搜索/清除（query 服务端过滤标题/项目/路径）
      searchRow: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderTop: "1px solid " + C.border, borderBottom: "1px solid " + C.border },
      searchInput: {
        flex: "1", minWidth: "0", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none",
      },
      searchBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "5px 12px", fontSize: "13px", cursor: "pointer",
      },
      // 窄宽降级：搜索按钮只留放大镜图标（accent 底、26×26 居中）
      searchIconBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        width: "26px", height: "26px", padding: "0", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      // 工具栏：全选 / 清空 / 刷新 + 已选计数
      // position: relative —— 末位的工作区筛选在这里，弹层对着工具栏定位（触发器根节点不定位）
      toolbar: { position: "relative", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      toolBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "4px 10px", fontSize: "13px", cursor: "pointer",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
      // 动作按钮组：吃满芯片之外的全部宽度——它的实测宽度就是「按钮还能用多少地方」，
      // 降级判据取它而不是面板宽度（芯片宽度随工作区名变化）
      toolbarActions: { display: "flex", gap: "6px", alignItems: "center", flex: "1 1 auto", minWidth: 0 },
      // 量「文字形态五个按钮需要多宽」的隐藏探针：绝对定位（不参与排版）、不可见、不可点。
      // 用真的 button 元素，字体与真实按钮完全一致
      // width: max-content —— 绝对定位盒默认是 shrink-to-fit，会被工具栏宽度钳住，量出来的
      // 就是「钳制值」而不是「文字形态真正需要多宽」；max-content 让它按内容撑开
      toolbarProbe: {
        position: "absolute", left: 0, top: 0, width: "max-content",
        display: "flex", gap: "6px", visibility: "hidden", pointerEvents: "none", whiteSpace: "nowrap",
      },
      // 工具栏末位的工作区筛选：与左侧动作按钮用 auto 外边距分开；限宽保护按钮，
      // 且它不经 toolBtn（窄面板下也保持文字，不降级成图标）
      toolbarFilter: { marginLeft: "auto", display: "flex", minWidth: 0, maxWidth: "52%" },
      // 窄宽降级的方形图标按钮（工具栏/分页/清除共用，26×26 居中图标）
      iconBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", width: "26px", height: "26px", padding: "0", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", flex: "none",
      },
      // 导入操作条：面板底部的主操作区（列表/分页之下，贴面板底缘），
      // 与列表的分界走上边框；结果摘要紧贴其上方（见 resultBar）
      importBar: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", borderTop: "1px solid " + C.border, flexWrap: "wrap" },
      // 底部导入结果条：紧贴主按钮上方，导入反馈与触发它的按钮相邻
      resultBar: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderTop: "1px solid " + C.border, background: C.field },
      primaryBtn: {
        flex: "1", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "7px 10px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
      },
      // Toast（面板底部浮层）：跳过提示 + 强调色动作（「忽略警告」= force 重导）
      toast: {
        position: "absolute", left: "12px", right: "12px", bottom: "12px", zIndex: 40,
        display: "flex", alignItems: "center", gap: "8px", boxSizing: "border-box",
        padding: "8px 10px", background: C.bg, border: "1px solid " + C.border, borderRadius: "10px",
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation,
        fontSize: "12px", color: C.text,
      },
      toastText: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      toastAction: {
        flex: "none", background: "transparent", border: "none", padding: "2px 4px",
        color: C.accent, fontSize: "12px", fontWeight: 600, cursor: "pointer",
      },
      result: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderBottom: "1px solid " + C.border, background: C.field },
      // 顶部不留 padding：工作区分组头 sticky 到 top:0 后与列表顶缘齐平，背景
      // 完整盖住背后滚过的行，不再在顶部露出 8px 缝隙泄漏列表背后的内容。
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "0 8px 8px" },
      // 工作区分组头（对标皮肤工作区行）：28px 高、0 6px 内边距、6px 圆角；它是标题不是
      // 目标——悬停不浮背景矩形，提示靠文字变亮 + 悬停才露出的折叠箭头
      group: {
        display: "flex", alignItems: "center", gap: "4px", height: "28px", minHeight: "28px",
        padding: "0 6px", marginTop: "6px", borderRadius: "6px",
        fontSize: "13px", lineHeight: "18px", fontWeight: 500, color: C.dim,
        // 不透明明面：sticky 头必须挡住滚过来的行，半透明的菜单色会透字
        position: "sticky", top: 0, background: C.surface, zIndex: 1, cursor: "pointer",
      },
      groupLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color .12s ease" },
      groupChevron: { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "14px", height: "14px" },
      groupCount: { marginLeft: "auto", fontSize: "11px", fontWeight: 400, color: C.dimmer },
      // 会话行（对标皮肤会话行）：28px 高、0 6px 内边距、6px 圆角、行距 1px
      item: {
        display: "flex", alignItems: "center", height: "28px", minHeight: "28px",
        padding: "0 6px", borderRadius: "6px", marginTop: "1px",
        // 整行即勾选控件（点击 / Enter / 空格）：聚焦环向内收，避免与行的圆角/相邻行粘连
        outlineOffset: "-2px",
      },
      // itemMain 只是标题的布局槽：勾选入口是整行（见 discovery.js 的 SessionRow），
      // 手型 / 聚焦环挂在 item 上。
      itemMain: { flex: "1", minWidth: "0", display: "flex", alignItems: "center" },
      // 标题默认 label-secondary，悬停 / 选中才变 label-primary（皮肤里就是这条规则）
      itemTitle: {
        fontSize: "13px", lineHeight: "18px", margin: "0 4px", color: C.dim,
        transition: "color .12s ease", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      itemTitleActive: { color: C.text },
      // 历史面板仍是两行式条目（沿用旧行样式）
      historyItem: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 10px", borderRadius: "8px", marginBottom: "2px" },
      itemMeta: { color: C.dimmer, fontSize: "12px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      // 行右侧槽位：默认放相对时间，悬停时换成导入 / 同步按钮——同一个槽位互斥，布局不跳
      rowSlot: {
        position: "relative", flex: "none", display: "flex", alignItems: "center",
        justifyContent: "flex-end", minWidth: "56px", marginLeft: "auto",
      },
      rowTime: { color: C.dimmer, fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap" },
      // 未悬停 / 未聚焦时的按钮：绝对定位 + 不可见但仍可 Tab 到（聚焦即由行状态点亮）
      rowBtnIdle: {
        position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
        opacity: 0, pointerEvents: "none", background: "transparent", border: "none",
        color: "transparent", padding: "2px 8px", fontSize: "12px", whiteSpace: "nowrap",
      },
      importBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "2px 8px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
      },
      syncBtn: {
        flex: "none", background: "transparent", color: C.dim, border: "1px solid " + C.border,
        borderRadius: "8px", padding: "2px 8px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
      },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      error: { padding: "16px", textAlign: "center", color: C.error },
      // 分页条：上一页 / 页码 / 下一页
      pageBar: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", padding: "4px 12px", borderTop: "1px solid " + C.border },
      pageBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "4px 12px", fontSize: "13px", cursor: "pointer",
      },
      // 底栏状态文案占满中间弹性区，过长截断（title 里有全文）
      // 翻页：无框图标钮（hover 直接改 DOM 背景，不走 state）
      pageNavBtn: {
        flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: "26px", height: "26px", padding: 0, background: "transparent", border: "none",
        borderRadius: "6px", color: C.dim, cursor: "pointer",
      },
      // 页控件（点开是页码网格）：与筛选按钮同款边框
      pageChip: {
        flex: "none", display: "inline-flex", alignItems: "center", gap: "4px", height: "26px",
        padding: "0 8px", background: "transparent", border: "1px solid " + C.border,
        borderRadius: "8px", color: C.text, fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
      },
      // 页码网格（像选集）：贴着底栏向上弹，多页时自身滚动
      pageGrid: {
        position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 30,
        display: "grid", gridTemplateColumns: "repeat(6, 34px)", gap: "4px", maxHeight: "240px",
        overflowY: "auto", padding: "6px", background: C.bg, border: "1px solid " + C.border,
        borderRadius: "12px", boxSizing: "border-box",
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation,
      },
      pageCell: {
        height: "30px", padding: 0, background: "transparent", border: "none", borderRadius: "6px",
        color: C.text, fontSize: "12px", cursor: "pointer",
      },
      pageCellActive: { background: C.accent, color: C.accentForeground, fontWeight: 600 },
      // 工具栏里的两个筛选控件：标签 + 芯片
      toolbarFilter: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px", minWidth: 0, maxWidth: "60%" },
      filterGroup: { display: "flex", alignItems: "center", gap: "4px", minWidth: 0, flex: "0 1 auto" },
      pageInfo: {
        flex: "1 1 auto", minWidth: 0, textAlign: "center", color: C.dimmer, fontSize: "12px",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      pageSizeLabel: { flex: "none", color: C.dimmer, fontSize: "12px", marginLeft: "4px" },
    });

    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // 相对时间（列表项「最后活跃 / 导入时间」显示用）：<1 分钟「刚刚」、<1 小时
    // 「N 分钟前」、<24 小时「N 小时前」、<7 天「N 天前」，更早回退绝对时间。
    // 未来时间（时钟偏差）按「刚刚」兜底，不显示负值。绝对时间经 title 保留可查。
    function relTime(ts, t) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const diff = Date.now() - d.getTime();
      if (diff < 60_000) return t("time.justNow");
      if (diff < 3_600_000) return t("time.minutesAgo", { n: Math.floor(diff / 60_000) });
      if (diff < 86_400_000) return t("time.hoursAgo", { n: Math.floor(diff / 3_600_000) });
      if (diff < 7 * 86_400_000) return t("time.daysAgo", { n: Math.floor(diff / 86_400_000) });
      return fmtTime(ts);
    }

    // 上下文 token 数 → 紧凑显示（87K / 1.2M）；非法/缺失返回 null（调用方回退）。
    function fmtTokenCount(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1_000) return Math.round(n / 1_000) + "K";
      return String(Math.round(n));
    }

    const statusLabel = (st, t) => (st === "imported" ? t("status.imported") : st === "partial" ? t("status.partial") : st === "archived" ? t("status.archived") : t("status.notImported"));

    // 会话条目唯一键（format + sourcePath + sessionId；\u0000 不在路径中出现）
    const itemKey = (s) => s.format + "\u0000" + s.sourcePath + "\u0000" + s.sessionId;
    // 条目 → /api-import/import 的 items 项（client 来源 id + sourcePath + sessionId
    // + cwd：转投 claude 时导出器需要 cwd 算项目 slug，发现条目上就有）
    // 列表累积的去重合并（同键保留后到的那条）：宿主分块重发、同一会话在 DSH 里两代各一份、
    // 或扫描器重复产出，都不会让列表出现「成对的行」——那种行还共享 hover/选中态（两者按
    // itemKey 索引），看起来像鬼影。sort 为真时按时间倒序（扫描完成时一次排序）。
    const mergeItems = (prev, batch, sort) => {
      const byKey = new Map(prev.map((s) => [itemKey(s), s]))
      for (const s of batch) byKey.set(itemKey(s), s)
      const merged = [...byKey.values()]
      return sort ? merged.sort(byTimeDesc) : merged
    }

    const toItem = (s) => ({
      source: FORMAT_SOURCE[s.format] || s.format,
      sourcePath: s.sourcePath,
      sessionId: s.sessionId,
      ...(typeof s.cwd === "string" && s.cwd ? { cwd: s.cwd } : {}),
    });

    // 转投结果摘要（导入到 DSH 之外的目标）：条数 + 落点路径 + 目标工具的使用提示；
    // 「保留 N 个既有会话」是重要事实（转投不会删掉用户原有的 DSH 会话），失败要显式。
    function fmtTransferResult(results, target, t) {
      let files = 0; let kept = 0; let purged = 0; let failed = 0;
      let firstPath = ""; let hint = ""; let firstError = "";
      for (const r of results || []) {
        if (r.status === "failed" && !r.transferred) { failed++; if (!firstError && r.error) firstError = r.error; continue; }
        files += r.transferred || 0;
        kept += r.kept || 0;
        purged += r.purged || 0;
        failed += r.failed || 0;
        for (const f of r.files || []) {
          if (!firstPath && f.filePath) firstPath = f.filePath;
          if (!firstError && f.error) firstError = f.error;
        }
        if (!hint && r.hint) hint = r.hint;
      }
      const bits = [t("transfer.done", { n: files, target: t("target." + target) })];
      if (purged) bits.push(t("transfer.purged", { n: purged }));
      if (kept) bits.push(t("transfer.kept", { n: kept }));
      if (failed) bits.push(t("result.failed", { n: failed }));
      const tail = [firstPath, hint, firstError].filter(Boolean).join("\n");
      return bits.join(t("result.separator")) + (tail ? "\n" + tail : "");
    }

    // 批量结果摘要（single/batch 混合计数；t 为 useTranslate 返回的翻译函数）
    function fmtImportResult(results, t) {
      const c = { imported: 0, replaced: 0, already: 0, appended: 0, skipped: 0, failed: 0 };
      for (const r of results || []) {
        if (r.status === "failed") { c.failed++; continue; }
        if (r.mode === "batch") {
          c.imported += r.imported || 0;
          c.already += r.alreadyImported || 0;
          c.appended += r.appended || 0;
          c.skipped += r.skipped || 0;
          c.failed += r.failed || 0;
        } else if (r.status === "imported") c.imported++;
        else if (r.status === "replaced") c.replaced++;
        else if (r.status === "already-imported") c.already++;
        else if (r.status === "appended") c.appended++;
        else c.skipped++;
      }
      const bits = [];
      if (c.imported) bits.push(t("result.imported", { n: c.imported }));
      if (c.replaced) bits.push(t("result.replaced", { n: c.replaced }));
      if (c.appended) bits.push(t("result.appended", { n: c.appended }));
      if (c.already) bits.push(t("result.already", { n: c.already }));
      if (c.skipped) bits.push(t("result.skipped", { n: c.skipped }));
      if (c.failed) bits.push(t("result.failed", { n: c.failed }));
      return t("result.done", { bits: bits.length ? bits.join(t("result.separator")) : t("result.nochange") });
    }

    // 健壮 JSON 读取：先取文本再解析，空/非 JSON 响应返回 null——避免 resp.json()
    // 对空响应抛 "Failed to execute 'json'…Unexpected end of JSON input" 原始异常
    // （面板应给出可读错误，而不是把浏览器异常直接亮给用户）。
    const readJson = async (resp) => {
      try {
        return JSON.parse(await resp.text());
      } catch {
        return null;
      }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 面板内联解析 Worker（Blob）：把响应文本的 JSON.parse 移出主线程——主线程只
    // 接收已解析的小块数组（结构化克隆），扫描期滚轮 / 其余 UI 不被大 JSON 解析占
    // 用。Worker 被环境拦截（CSP 等）或运行时出错时逐次回退主线程解析，面板不受影响。
    let parseWorker = null;
    const ensureParseWorker = () => {
      if (parseWorker) return true;
      try {
        if (typeof Worker === "undefined") return false;
        const src = "self.onmessage=function(e){try{self.postMessage({ok:true,data:JSON.parse(e.data)})}catch(err){self.postMessage({ok:false,error:String(err&&err.message||err)})}};";
        const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
        worker.onerror = () => { parseWorker = null; };
        parseWorker = worker;
        return true;
      } catch {
        return false;
      }
    };
    const workerParse = (text) => new Promise((resolve) => {
      const worker = parseWorker;
      const done = (result) => {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        resolve(result);
      };
      const onMsg = (ev) => done(ev.data);
      const onErr = () => done({ ok: false, error: "worker error" });
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      worker.postMessage(text);
    });
    // 面板响应解析：优先 Worker 线程（零主线程大解析），不可用回退主线程
    const parsePanelResponse = async (resp) => {
      const text = await resp.text();
      if (ensureParseWorker()) {
        try {
          const r = await workerParse(text);
          if (r && r.ok === true) return r.data;
        } catch {
          // worker 会话异常 → 走主线程解析兜底
        }
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    // 排除目录输入 → 绝对路径数组（逗号/换行分隔，去空白与空项）
    const parseDirs = (text) => String(text || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

    function Toggle({ on, onChange, colors }) {
      return React.createElement("button", {
        type: "button",
        onClick: () => onChange(!on),
        style: {
          width: "40px", height: "22px", borderRadius: "999px", border: "none", cursor: "pointer",
          background: on ? colors.accent : colors.border, position: "relative", flex: "none",
        },
      }, React.createElement("span", {
        style: {
          position: "absolute", top: "2px", left: on ? "20px" : "2px", width: "18px", height: "18px",
          borderRadius: "50%", background: colors.accentForeground, transition: "left .12s ease",
        },
      }));
    }

    // 设置页「会话导入」分区。席位按宿主世代分流（对齐 dsh-claude-style）：
    //   0.1.7+ —— 插件设置搬到「设置 → 插件」的插件页（plugins.bundle.config 槽，
    //             键 = 包名 dsh-chat-import），值走客户端服务 configForms（命名空间 =
    //             本插件 profile 条目 id，控制器带值 + 写队列 + revision 栅栏）。
    //   旧宿主 —— settings.section 整页（设置页左侧导航「每功能一页」），值走宿主
    //             半边自建的 fenced 路由 /api-import/prefs（旧宿主 configForms 缺席，
    //             且 api-proxy 白名单不含插件自有命名空间）。
    // 两条传输携带同一组字段，组件只认下面的 loadPrefsView / savePrefsPatch。
    // injectTools 是三档（off/minimal/full）：服务端与客户端各做一次归一（客户端兜
    // 历史持久化 boolean：true→full / false→off），两端语义一致。

    // 客户端 ctx（entry.js 的 apply 注入）：configForms 是客户端服务，晚于 apply 也
    // 可能在，所以每次调用都现取，不缓存服务本身。
    let clientHostCtx = null;
    function setClientHostCtx(ctx) { clientHostCtx = ctx; }
    // 0.1.7+ 的官方配置表单服务；旧宿主没有 → null（回落 fenced 路由）。
    function hostConfigForms() {
      try {
        const forms = clientHostCtx && typeof clientHostCtx.get === "function" ? clientHostCtx.get("configForms") : null;
        return forms && typeof forms.get === "function" ? forms : null;
      } catch (_) { return null; }
    }
    // 浏览器侧插件条目的 id：宿主 loader 报 "<kind>:<id>"（取裸 id）；但浏览器 boot
    // 给每个插件条目生成的是**随机 id**（dsh-client-modules 的 create 只传 name），
    // 所以它只能当候选之一——真正可用的命名空间从 configForms 已服务的名单里挑。
    function settingsEntryId() {
      try {
        const entry = clientHostCtx && clientHostCtx.fiber ? clientHostCtx.fiber.entry : null;
        const id = entry ? entry.id : null;
        if (typeof id === "string" && id !== "") {
          const colon = id.lastIndexOf(":");
          return colon === -1 ? id : id.slice(colon + 1);
        }
      } catch (_) { /* 无条目（动态包 façade 不暴露 fiber）：回落 */ }
      return "import-claude";
    }
    // 本插件命名空间的候选：客户端条目 id、包名、patch 声明的裸条目 id（宿主半边用的
    // 就是最后这个）。宿主设置服务里只有一个是我们，挑出真正被服务的那一个。
    const SETTINGS_NAMESPACE_CANDIDATES = () => [settingsEntryId(), "dsh-chat-import", "import-claude"];
    function servedNamespace(forms, candidates) {
      try {
        const mirror = typeof forms.describe === "function" ? forms.describe() : null;
        const snap = mirror && typeof mirror.getSnapshot === "function" ? mirror.getSnapshot() : null;
        const view = snap && snap.view;
        const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : null;
        if (namespaces) {
          for (const c of candidates) {
            if (typeof c === "string" && c !== "" && namespaces.some((v) => v && v.ns === c)) return c;
          }
        }
      } catch (_) { /* 镜像不可读：按候选顺序赌 */ }
      return undefined;
    }
    function settingsForm() {
      const forms = hostConfigForms();
      if (!forms) return null;
      const candidates = SETTINGS_NAMESPACE_CANDIDATES();
      const ns = servedNamespace(forms, candidates) || "import-claude";
      try {
        const form = forms.get(ns);
        return form && typeof form.getSnapshot === "function" ? form : null;
      } catch (_) { return null; }
    }
    const CLIENT_PREFS_DEFAULT = { sidebarButton: true, importSystemPrompt: true, injectTools: "minimal" };
    function formReady(form) {
      if (!form) return null;
      const snap = form.getSnapshot();
      return snap && snap.status === "ready" && snap.value && typeof snap.value === "object" ? snap : null;
    }
    function loadPrefsViaRoute() {
      return fetch("/api-import/prefs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).then((resp) => readJson(resp));
    }
    function savePrefsViaRoute(patch) {
      return fetch("/api-import/prefs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      }).then((resp) => readJson(resp));
    }
    // 读当前偏好：官方表单 ready 时直接给值，否则走 fenced 路由（表单还没 ready 时不能
    // 停在默认值——那正是「选项显示但存不进去」的来源）。返回 { ok, value, revision, available }。
    function loadPrefsView() {
      const snap = formReady(settingsForm());
      if (snap) return Promise.resolve({ ok: true, value: snap.value, revision: snap.revision, available: true });
      return loadPrefsViaRoute();
    }
    // 写偏好：官方表单 ready 时逐字段 set（控制器自带写队列与 revision 栅栏），被拒或不可用
    // 则回落 fenced 路由（同一份宿主命名空间，路由走 settings.update）。返回 { ok, value, revision, error? }。
    function savePrefsPatch(patch) {
      const form = settingsForm();
      const snap = formReady(form);
      if (!snap) return savePrefsViaRoute(patch);
      const keys = Object.keys(patch);
      let run = Promise.resolve(true);
      for (const key of keys) {
        run = run.then((accepted) => {
          if (accepted === false) return false;
          let pending;
          try { pending = form.set(key, patch[key]); } catch (_) { return false; }
          return pending && typeof pending.then === "function" ? pending.then((ok) => ok === true) : true;
        });
      }
      return run.then((accepted) => {
        if (accepted === false) return savePrefsViaRoute(patch);
        const next = formReady(form);
        return {
          ok: true,
          value: next && next.value ? next.value : { ...CLIENT_PREFS_DEFAULT },
          revision: next ? next.revision : undefined,
          available: !!next,
        };
      });
    }
    const normalizeMode = (v) => {
      if (v === "off" || v === "minimal" || v === "full") return v;
      if (v === true) return "full";
      if (v === false) return "off";
      return "minimal";
    };
    function ImportSettingsSection() {
      const t = useTranslate();
      const colors = themeColors();
      const [state, setState] = useState({ sidebarButton: cachedSidebarButton, importSystemPrompt: true, injectTools: "minimal", saving: false, error: null });
      const readPrefs = (data) => ({
        sidebarButton: data && data.value && typeof data.value.sidebarButton === "boolean" ? data.value.sidebarButton : true,
        // 缺字段按默认 true（宿主 Config 默认）；显式 false 才算关。
        importSystemPrompt: !(data && data.value) || data.value.importSystemPrompt !== false,
        injectTools: normalizeMode(data && data.value && data.value.injectTools),
      });
      const adopt = (data) => {
        const prefs = readPrefs(data);
        setSidebarButton(prefs.sidebarButton);
        setState((s) => ({ ...s, ...prefs, error: null }));
      };
      const load = () => {
        loadPrefsView()
          .then((data) => {
            if (data && data.ok === true) adopt(data);
            else setState((s) => ({ ...s, error: (data && data.error) || t("error.load") }));
          })
          .catch((err) => setState((s) => ({ ...s, error: "导入偏好读取失败：" + String((err && err.message) || err) })));
      };
      useEffect(() => {
        load();
        // 0.1.7 官方表单：订阅宿主侧变更（另一处改了值 / 写入回流）后重读。
        const form = settingsForm();
        if (form && typeof form.subscribe === "function") {
          let off;
          try {
            off = form.subscribe(() => {
              const snap = form.getSnapshot();
              if (snap && snap.status === "ready") adopt({ ok: true, value: snap.value });
            });
          } catch (_) { off = undefined; }
          return () => { try { if (off) off(); } catch (_) {} };
        }
        return undefined;
      }, []);
      const applyPref = (patch) => {
        setState((s) => ({ ...s, saving: true, error: null }));
        Promise.resolve(savePrefsPatch(patch))
          .then((data) => {
            if (data && data.ok === true) {
              adopt(data);
              setState((s) => ({ ...s, saving: false }));
            } else {
              // 写失败（含 revision 冲突）：显示错误并重读权威值
              setState((s) => ({ ...s, saving: false, error: (data && data.error) || t("error.route") }));
              load();
            }
          })
          .catch(() => { setState((s) => ({ ...s, saving: false, error: t("error.route") })); });
      };
      const toggleCard = (title, description, on, patchKey) => React.createElement("div", {
        style: {
          display: "flex", alignItems: "flex-start", gap: "12px",
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "12px",
        },
      },
        React.createElement("div", { style: { flex: "1", minWidth: "0" } },
          React.createElement("div", { style: { fontSize: "13px", color: colors.text, lineHeight: "1.5", fontWeight: 600 } }, title),
          React.createElement("div", { style: { fontSize: "12px", color: colors.dimmer, marginTop: "4px", lineHeight: "1.5" } }, description)),
        React.createElement(Toggle, { on, colors, onChange: (next) => { if (!state.saving) applyPref({ [patchKey]: next }); } }));
      // 三档选择卡片（injectTools）：横向 segmented 按钮，选中项 accent 底色；
      // 点击即应用（与 toggleCard 同一保存通路），saving 期间禁点。
      const choiceCard = (title, description, value, options, patchKey) => React.createElement("div", {
        style: {
          display: "flex", alignItems: "flex-start", gap: "12px",
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "12px",
        },
      },
        React.createElement("div", { style: { flex: "1", minWidth: "0" } },
          React.createElement("div", { style: { fontSize: "13px", color: colors.text, lineHeight: "1.5", fontWeight: 600 } }, title),
          React.createElement("div", { style: { fontSize: "12px", color: colors.dimmer, marginTop: "4px", lineHeight: "1.5" } }, description)),
        React.createElement("div", { style: { display: "flex", flex: "none", gap: "0", borderRadius: "10px", border: "1px solid " + colors.border, overflow: "hidden" } },
          options.map((opt) => React.createElement("button", {
            key: opt.value, type: "button", disabled: !!state.saving,
            onClick: () => { if (!state.saving && opt.value !== value) applyPref({ [patchKey]: opt.value }); },
            style: {
              padding: "6px 12px", fontSize: "12px", cursor: state.saving ? "default" : "pointer",
              border: "none", fontWeight: opt.value === value ? 600 : 400,
              background: opt.value === value ? colors.accent : "transparent",
              color: opt.value === value ? colors.accentForeground : colors.dimmer,
            },
          }, opt.label))));
      return React.createElement("div", { style: { padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "640px" } },
        React.createElement("div", { style: { fontSize: "15px", fontWeight: 600, color: colors.text } }, t("settings.tab")),
        toggleCard(t("settings.sidebarButton.title"), t("settings.sidebarButton.description"), state.sidebarButton, "sidebarButton"),
        toggleCard(t("settings.systemPrompt.title"), t("settings.systemPrompt.description"), state.importSystemPrompt, "importSystemPrompt"),
        choiceCard(t("settings.injectTools.title"), t("settings.injectTools.description"), state.injectTools,
          [{ value: "off", label: t("settings.injectTools.off") }, { value: "minimal", label: t("settings.injectTools.minimal") }, { value: "full", label: t("settings.injectTools.full") }],
          "injectTools"),
        state.error && React.createElement("div", { style: { fontSize: "12px", color: colors.error } }, state.error),
        // 双向同步内容并入「会话导入」设置页：横线分隔，控件风格同设置页
        React.createElement("div", { style: { height: "1px", background: colors.border, marginTop: "8px" } }),
        React.createElement("div", { style: { fontSize: "14px", fontWeight: 600, color: colors.text } }, t("sync.panel.title")),
        React.createElement(SyncSettingsContent, null));
    }

    // 同步来源/目标格式复选框（设置页控件风格：卡片内 checkbox 组）。
    function FormatChecks({ value, onChange, colors }) {
      const set = new Set(value || []);
      return React.createElement("div", { style: { display: "flex", gap: "16px", flexWrap: "wrap" } },
        ["claude", "codex", "grokbuild"].map((f) => React.createElement("label", {
          key: f, style: { display: "flex", gap: "6px", alignItems: "center", cursor: "pointer", color: colors.text, fontSize: "13px" },
        },
          React.createElement("input", {
            type: "checkbox", checked: set.has(f),
            style: { accentColor: colors.accent, cursor: "pointer" },
            onChange: () => {
              const next = new Set(set);
              if (next.has(f)) next.delete(f); else next.add(f);
              onChange([...next]);
            },
          }),
          f)));
    }

    // 排除目录行（设置页控件风格：卡片内标签 + 输入，失焦保存）。
    function DirsRow({ label, hint, dirs, colors, onSave }) {
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
        React.createElement("span", { style: { fontSize: "13px", fontWeight: 600, color: colors.text } }, label),
        React.createElement("input", {
          style: {
            width: "100%", boxSizing: "border-box", background: colors.field,
            border: "1px solid " + colors.border, color: colors.text, borderRadius: "8px",
            padding: "6px 8px", fontSize: "13px", outline: "none",
          },
          placeholder: hint,
          defaultValue: (dirs || []).join(", "),
          onBlur: (e) => onSave(parseDirs(e.target.value)),
        }));
    }

    // 双向同步内容（嵌入「会话导入」设置分区，横线分隔）：入站/出站开关 + 来源/目标
    // 格式 + 排除目录 + 间隔 + 立即同步。配置经面板 fenced 路由 /api-import/sync
    // 读写（与设置命名空间无关，无白名单问题）；控件风格对齐设置页（卡片化分组 +
    // 统一按钮/输入/开关），不重复外层分区容器与页标题。
    function SyncSettingsContent() {
      const t = useTranslate();
      const colors = themeColors();
      const [config, setConfig] = useState(null);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);

      const load = () => {
        fetch("/api-import/sync").then((r) => readJson(r)).then((data) => {
          if (data && data.ok) { setConfig(data.config); setStatus(data.status); setError(null); }
          else setError((data && data.error) || t("error.load"));
        }).catch((err) => setError(String((err && err.message) || err)));
      };
      useEffect(() => { load(); }, []);

      const save = async (patch) => {
        setBusy(true);
        try {
          const resp = await fetch("/api-import/sync", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
          });
          const data = await readJson(resp);
          if (data && data.ok) { setConfig(data.config); setStatus(data.status); setNote(null); }
          else setError((data && data.error) || t("error.route"));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(false); }
      };

      const runNow = async () => {
        setBusy(true);
        setNote(null);
        try {
          const resp = await fetch("/api-import/sync", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runNow: true }),
          });
          const data = await readJson(resp);
          if (data && data.ok) {
            setConfig(data.config);
            setStatus(data.status);
            const inn = (data.result && data.result.inbound) || {};
            const out = (data.result && data.result.outbound) || {};
            setNote(t("sync.result", {
              scanned: inn.scanned || 0, imported: inn.imported || 0, appended: inn.appended || 0,
              skipped: inn.skipped || 0, failed: inn.failed || 0,
              synced: out.synced || 0, outSkipped: out.skipped || 0, outFailed: out.failed || 0,
            }));
          } else setError((data && data.error) || t("error.route"));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(false); }
      };

      if (!config) {
        return React.createElement("div", { style: { padding: "12px 0", color: colors.dimmer, fontSize: "13px" } }, error || t("loading"));
      }
      const last = config.lastRun && config.lastRun.at ? fmtTime(config.lastRun.at) : "";
      // 卡片化分组（对齐设置页 ImportSettingsSection 的控件风格）：标题 + 提示 + 控件
      const card = (title, hint, control) => React.createElement("div", {
        style: {
          display: "flex", alignItems: "flex-start", gap: "12px",
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "12px",
        },
      },
        React.createElement("div", { style: { flex: "1", minWidth: "0" } },
          React.createElement("div", { style: { fontSize: "13px", color: colors.text, lineHeight: "1.5", fontWeight: 600 } }, title),
          React.createElement("div", { style: { fontSize: "12px", color: colors.dimmer, marginTop: "4px", lineHeight: "1.5" } }, hint)),
        control);
      const groupCard = (children) => React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", gap: "10px",
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "12px",
        },
      }, children);
      const numInput = {
        width: "90px", background: colors.field, border: "1px solid " + colors.border, color: colors.text,
        borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none",
      };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } },
        card(t("sync.inbound"), t("sync.inbound.hint"),
          React.createElement(Toggle, { on: !!config.inbound.enabled, colors, onChange: (on) => save({ inbound: { ...config.inbound, enabled: on } }) })),
        groupCard(
          React.createElement(FormatChecks, { value: config.inbound.formats, colors, onChange: (formats) => save({ inbound: { ...config.inbound, formats } }) }),
          React.createElement(DirsRow, {
            label: t("sync.excludeDirs"), hint: t("sync.excludeDirs.hint"),
            dirs: config.inbound.excludeDirs, colors,
            onSave: (dirs) => save({ inbound: { ...config.inbound, excludeDirs: dirs } }),
          })),
        card(t("sync.outbound"), t("sync.outbound.hint"),
          React.createElement(Toggle, { on: !!config.outbound.enabled, colors, onChange: (on) => save({ outbound: { ...config.outbound, enabled: on } }) })),
        groupCard(
          React.createElement(FormatChecks, { value: config.outbound.targets, colors, onChange: (targets) => save({ outbound: { ...config.outbound, targets } }) }),
          React.createElement(DirsRow, {
            label: t("sync.excludeDirs"), hint: t("sync.excludeDirs.hint"),
            dirs: config.outbound.excludeDirs, colors,
            onSave: (dirs) => save({ outbound: { ...config.outbound, excludeDirs: dirs } }),
          })),
        card(t("sync.interval"), status && status.timerActive ? t("sync.timer.on") : t("sync.timer.off"),
          React.createElement("input", {
            type: "number", min: 15, max: 3600, value: Math.round((config.intervalMs || 60000) / 1000),
            style: numInput,
            onChange: (e) => setConfig({ ...config, intervalMs: Math.max(15, Number(e.target.value) || 60) * 1000 }),
            onBlur: () => save({ intervalMs: config.intervalMs }),
          })),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
          React.createElement("button", {
            style: {
              background: colors.accent, color: colors.accentForeground, border: "none", borderRadius: "8px",
              padding: "7px 18px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              opacity: busy ? 0.55 : 1,
            },
            disabled: busy, onClick: runNow,
          }, busy ? t("sync.running") : t("sync.run")),
          React.createElement("span", { style: { fontSize: "12px", color: colors.dimmer } }, last ? t("sync.last", { when: last }) : t("sync.never"))),
        note && React.createElement("div", { style: { fontSize: "12px", color: colors.dim } }, note),
        error && React.createElement("div", { style: { fontSize: "12px", color: colors.error } }, error));
    }

    // 「导入会话」内容（tab 栏 + 导入/历史两个子视图）：不含遮罩/header/关闭按钮，
    // 供原生右侧栏 tab 复用同一份内容（embedded 模式）。
    function ImportTabContent() {
      const t = useTranslate();
      const colors = themeColors();
      const [tab, setTab] = useState("import");
      const tabBtn = (id, label) => React.createElement("button", {
        type: "button",
        onClick: () => setTab(id),
        style: {
          flex: "1", padding: "8px 0", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600,
          background: tab === id ? colors.field : "transparent",
          color: tab === id ? colors.text : colors.dim,
          borderBottom: tab === id ? "2px solid " + colors.accent : "2px solid transparent",
        },
      }, label);
      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { display: "flex", flexShrink: 0, borderBottom: "1px solid " + colors.border } },
          tabBtn("import", t("tab.import")),
          tabBtn("history", t("tab.history"))),
        tab === "import"
          ? React.createElement(DiscoveryPanel, null)
          : React.createElement(HistoryPanel, null));
    }

    /** 原生右侧栏「导入会话」tab 面板主体（sidebar.right.pane.tab 槽，session 作用域、
     *  keyed by 类型 id）：全高容器内嵌 ImportTabContent（embedded 内容自带滚动与配色）。
     *  面板的标题与关闭由右侧栏 tab 条自己呈现（注册表 title 文本 + strip ✕），组件
     *  不需要再画一个头。 */
    function SidebarImportTab() {
      return React.createElement("div", {
        style: { display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" },
      },
        React.createElement(ImportTabContent, null));
    }

    /** 导入历史面板：读取 imports.json 展平列表，支持单条/全部删除 */
    function HistoryPanel() {
      const t = useTranslate();
      const colors = themeColors();
      const style = makeStyles(colors);
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [confirm, setConfirm] = useState(null); // { kind:'all'|'one', sessionId?, count? }

      const load = () => {
        setLoading(true);
        setError(null);
        fetch("/api-import/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          .then((r) => readJson(r))
          .then((data) => {
            if (data && data.ok === true) {
              setEntries(Array.isArray(data.entries) ? data.entries : []);
              setError(null);
            } else {
              setError((data && data.error) || t("error.load"));
            }
          })
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setLoading(false));
      };
      useEffect(() => { load(); }, []);

      const runPurge = async (body) => {
        setBusy(true);
        setNote(null);
        try {
          const resp = await fetch("/api-import/purge", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true, ...body }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            const r = data.result || {};
            setNote(t("history.purge.done", { deleted: r.deleted || 0, failed: r.failed || 0 }));
            load();
          } else {
            setError((data && data.error) || t("error.route"));
          }
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
          setConfirm(null);
        }
      };

      const confirmDialog = confirm && React.createElement("div", {
        style: {
          position: "absolute", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 2,
          display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
        },
      },
        React.createElement("div", {
          style: {
            background: colors.surface, border: "1px solid " + colors.border, borderRadius: "12px",
            padding: "16px", maxWidth: "360px", width: "100%",
          },
        },
          React.createElement("div", { style: { fontWeight: 600, marginBottom: "8px" } }, t("history.confirm.title")),
          React.createElement("div", { style: { fontSize: "13px", color: colors.dim, marginBottom: "14px", lineHeight: 1.5 } },
            confirm.kind === "all"
              ? t("history.confirm.all", { n: confirm.count || 0 })
              : t("history.confirm.one", { id: confirm.sessionId || "" })),
          React.createElement("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
            React.createElement("button", {
              style: style.toolBtn, disabled: busy,
              onClick: () => setConfirm(null),
            }, t("history.confirm.cancel")),
            React.createElement("button", {
              style: { ...style.primaryBtn, flex: "none", width: "auto", padding: "6px 14px" },
              disabled: busy,
              onClick: () => runPurge(confirm.kind === "all" ? { all: true } : { sessionId: confirm.sessionId }),
            }, t("history.confirm.ok")))));

      const body = React.createElement(React.Fragment, null,
        React.createElement("div", { style: { ...style.toolbar, justifyContent: "space-between" } },
          React.createElement("span", { style: { fontWeight: 600, color: colors.text } }, t("history.title")),
          React.createElement("div", { style: { display: "flex", gap: "6px" } },
            React.createElement("button", { style: style.toolBtn, onClick: load, disabled: busy || loading }, t("refresh")),
            React.createElement("button", {
              style: { ...style.toolBtn, color: colors.error, borderColor: colors.error },
              disabled: busy || loading || entries.length === 0,
              title: t("history.purgeAll.title"),
              onClick: () => setConfirm({ kind: "all", count: entries.length }),
            }, t("history.purgeAll")))),
        note && React.createElement("div", { style: style.result }, note),
        error && React.createElement("div", { style: style.error }, error),
        loading && React.createElement("div", { style: style.status }, t("history.loading")),
        !loading && !error && entries.length === 0 && React.createElement("div", { style: style.status }, t("history.empty")),
        !loading && entries.length > 0 && React.createElement("div", { style: { ...style.list, paddingTop: "8px" } },
          entries.map((e) => React.createElement("div", {
            key: e.sessionId + "\u0000" + e.sourcePath,
            style: { ...style.historyItem, flexDirection: "column", alignItems: "stretch", gap: "4px" },
          },
            React.createElement("div", { style: { fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              e.title || t("noTitle")),
            React.createElement("div", { style: { fontSize: "11px", color: colors.dimmer, wordBreak: "break-all" } }, e.sourcePath),
            React.createElement("div", { style: style.itemMeta },
              React.createElement("span", null, e.sessionId),
              React.createElement("span", { title: fmtTime(e.importedAt) }, relTime(e.importedAt, t) || t("timeUnknown")),
              React.createElement("span", null, (typeof e.turns === "number" ? e.turns : "—") + " / " + (typeof e.events === "number" ? e.events : "—"))),
            React.createElement("button", {
              style: { ...style.toolBtn, alignSelf: "flex-end", color: colors.error, borderColor: colors.error, marginTop: "4px" },
              disabled: busy,
              title: t("history.purgeOne.title"),
              onClick: () => setConfirm({ kind: "one", sessionId: e.sessionId }),
            }, t("history.purgeOne"))))));

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, position: "relative" } },
        body, confirmDialog);
    }

    /** 可搜索下拉（combobox）：触发器按皮肤里模型选择器的形态重绘——没有边框也没有
     *  输入框外观，只有「品牌标 + 当前项文本 + 细箭头」，hover / 展开时浮出一层背景矩形
     *  （矩形贴着内容，所以按钮不 flex-grow）；前缀文本（来源 / 导入到 / 工作区）留在行里
     *  当标签。弹层是同一套二级弹层口径：12px 圆角容器、30px 行高、6px 行圆角、品牌标 +
     *  名称 + 当前项末尾 ✓，顶部保留搜索框（自动聚焦）。替代原生 <select>：来源 / 目标 /
     *  工作区选项多时既好看也能检索。受控组件：value + onChange；点击外部 / Esc 关闭。 */
    function SearchableSelect({ value, options, onChange, disabled, title, colors, searchPlaceholder, noMatchLabel, searchable = true, triggerLabel }) {
      const style = makeStyles(colors);
      const [open, setOpen] = useState(false);
      const [filter, setFilter] = useState("");
      const [hover, setHover] = useState(null);
      const [hot, setHot] = useState(false); // 触发器 hover 态（内联样式没有 :hover）
      const [listMax, setListMax] = useState(260); // 列表可用高度（开弹层时按窗口实测）
      const rootRef = useRef(null);
      const inputRef = useRef(null);
      const popRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setFilter(""); } };
        // Esc 在此截断冒泡：面板级 Esc 关闭监听挂在 window 上，不 stopPropagation
        // 会连面板一起关掉（原生 select 弹层吞按键，本组件需自行隔离）。
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setFilter(""); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        // 短菜单（searchable: false）不渲染搜索框，自然也没有需要聚焦的输入
        if (inputRef.current) inputRef.current.focus();
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);
      // 弹层高度自适应：列表上限 = 视口底部到弹层顶端的距离，再扣掉弹层自己的头部
      //（搜索行 + 分隔线 + 内外边距 ≈ 46px）与底部留白。锚点在上方、弹层只向下长，
      // 所以这轮测量不受上一次结果影响，不会来回抖。用 layout effect：首帧就是最终高度。
      useLayoutEffect(() => {
        if (!open) return undefined;
        const measure = () => {
          const node = popRef.current;
          if (!node) return;
          const top = node.getBoundingClientRect().top;
          setListMax(Math.max(180, Math.round(window.innerHeight - top - 20 - 46)));
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
      }, [open]);
      const current = options.find((o) => o.value === value);
      // 整份选项都没有品牌标（例如工作区）时不再留 16px 槽位——文字直接贴左边，不被白占
      const hasMarks = options.some((o) => o.mark);
      const needle = filter.trim().toLowerCase();
      const shown = !needle ? options : options.filter((o) =>
        String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle)
        || String(o.sub || "").toLowerCase().includes(needle));
      const pick = (v) => { onChange(v); setOpen(false); setFilter(""); };
      const lit = open || (hot && !disabled); // 背景矩形：hover 或展开时出现
      return React.createElement("div", { ref: rootRef, style: style.selectRoot, title },
        React.createElement("button", {
          type: "button", disabled,
          "aria-haspopup": "listbox", "aria-expanded": open,
          style: {
            ...style.selectTrigger,
            background: lit ? colors.hover : "transparent",
            opacity: disabled ? 0.55 : 1,
            cursor: disabled ? "default" : "pointer",
          },
          onMouseEnter: () => setHot(true),
          onMouseLeave: () => setHot(false),
          onClick: () => { setOpen(!open); setFilter(""); setHover(null); },
        },
          React.createElement("span", { style: style.selectValue },
            triggerLabel !== undefined ? triggerLabel : (current ? current.label : ""))),
        open && React.createElement("div", { ref: popRef, style: style.selectPopover },
          searchable ? React.createElement("div", { style: style.selectSearchRow },
            React.createElement("span", { style: style.selectSearchIcon }, React.createElement(Icon, { name: "search", size: 13 })),
            React.createElement("input", {
              ref: inputRef, value: filter, placeholder: searchPlaceholder,
              onChange: (e) => { setFilter(e.target.value); setHover(null); },
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  const idx = hover !== null && shown.some((o) => o.value === hover) ? shown.findIndex((o) => o.value === hover) : 0;
                  const target = shown[idx >= 0 ? idx : 0];
                  if (target) pick(target.value);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (shown.length === 0) return;
                  const idx = hover !== null ? shown.findIndex((o) => o.value === hover) : -1;
                  const next = e.key === "ArrowDown"
                    ? Math.min(shown.length - 1, idx + 1)
                    : Math.max(0, idx <= 0 ? 0 : idx - 1);
                  setHover(shown[next].value);
                }
              },
              style: style.selectSearchInput,
            })) : null,
          searchable ? React.createElement("div", { style: style.selectDivider }) : null,
          React.createElement("div", { style: { ...style.selectList, maxHeight: listMax + "px" }, role: "listbox" },
            shown.length === 0 && React.createElement("div", { style: style.selectEmpty }, noMatchLabel),
            shown.map((o) => {
              // 来源行画品牌锁标（mark + 字标，整块替换名称文本）；没有官方品牌标、或该下拉
              // 没开锁标（导入目标 / 工作区）的行保持「槽位 + 文本」
              const lockup = o.lockup === true && o.mark ? sourceLogo(o.mark) : null;
              return React.createElement("button", {
                key: o.value, type: "button", role: "option", "aria-selected": o.value === value,
                onClick: () => pick(o.value),
                onMouseEnter: () => setHover(o.value),
                onMouseLeave: () => setHover((h) => (h === o.value ? null : h)),
                style: {
                  ...style.selectRow,
                  fontWeight: o.value === value ? 500 : 400,
                  background: hover === o.value ? colors.hover : "transparent",
                },
              },
                lockup
                  ? React.createElement(SourceLockup, { id: o.mark, label: o.label })
                  : React.createElement(React.Fragment, null,
                    hasMarks
                      ? React.createElement("span", { style: style.selectMarkSlot },
                        o.mark ? React.createElement(BrandMark, { id: o.mark, size: 16 }) : null)
                      : null,
                    React.createElement("span", { style: style.selectRowText }, o.label)),
              o.sub ? React.createElement("span", { style: style.selectRowSub, title: o.sub }, o.sub) : null,
              React.createElement("span", { style: style.selectCheck },
                o.value === value ? React.createElement(Icon, { name: "check", size: 13 }) : null));
            }))));
    }

    // 列表窗口化的尺寸常量：行高 28px + 行距 1px，分组头 28px + 组间距 6px（见 styles.js）。
    // 固定高度 → 可见区间是纯算术，不需要测量每一行。
    const LIST_ROW_H = 29;
    const LIST_HEAD_H = 34;
    // 视口上下各多渲染「一屏」（原来的 ±10 行在快滚时会露白，观感像「停下来才渲染」）
    const LIST_OVERSCAN_MIN = 10;

    /** 页控件：显示「第 x / y 页」，点开在底栏之上弹出页码网格（像选集），点数字直接跳页。
     *  页多时网格自身滚动，并停在当前页附近。 */
    function PageJump({ page, totalPages, colors, style, onPick }) {
      const t = useTranslate();
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      const gridRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);
      // 打开时把当前页滚进可视区（网格每行 6 格、每行 34px）
      useEffect(() => {
        if (open && gridRef.current) {
          gridRef.current.scrollTop = Math.max(0, Math.floor(page / 6) * 34 - 68);
        }
      }, [open, page]);
      const cells = [];
      for (let i = 0; i < totalPages; i += 1) {
        cells.push(React.createElement("button", {
          key: i, type: "button", style: { ...style.pageCell, ...(i === page ? style.pageCellActive : null) },
          onClick: () => { onPick(i); setOpen(false); },
          onMouseEnter: (e) => { if (i !== page) e.currentTarget.style.background = colors.hover; },
          onMouseLeave: (e) => { if (i !== page) e.currentTarget.style.background = "transparent"; },
        }, String(i + 1)));
      }
      return React.createElement("span", {
        ref: rootRef, style: { position: "relative", display: "inline-flex", flex: "none" },
      },
        React.createElement("button", {
          type: "button", style: style.pageChip, "aria-haspopup": "true", "aria-expanded": open,
          title: t("page.jump.title"),
          onClick: () => setOpen((v) => !v),
        }, t("page.jump", { page: page + 1, pages: totalPages }),
          React.createElement(Icon, { name: "chevronDown", size: 12, strokeWidth: 1.5 })),
        open && React.createElement("div", { ref: gridRef, style: style.pageGrid, role: "menu" }, cells));
    }

    /** 会话行（memo）：悬停 / 勾选一次只影响自己这一行——父级重渲染时其余行直接复用上次的
     *  元素树，不再重建（大档位下这是主要开销）。比较字段全是标量，回调由父级 useCallback
     *  固定引用。 */
    const SessionRow = React.memo(function SessionRow(props) {
      const { s, style, colors, badgeOverlay, label, time, tip, checked, hot, importing, onToggle, onImport, groupName } = props;
      const imported = s.importStatus === "imported";
      const lit = hot || checked;
      const key = itemKey(s);
      // 勾选入口 = **整行**（点行内任意处，含来源标 / 时间 / 空白），不再要求瞄准 22px 的
      // 方图或某一段文字。因此行的外层容器即勾选控件（role=checkbox + 键盘切换）；行内
      // 的导入 / 同步按钮是唯一例外——它必须 stopPropagation，否则点按钮会连带切换勾选。
      // 徽标仍作选中态的视觉指示（遮罩 + 勾），不再承担点击。
      const rowStyle = {
        ...style.item,
        background: hot ? colors.hover : "transparent",
        cursor: importing ? "default" : "pointer",
      };
      return React.createElement("div", {
        style: rowStyle,
        title: tip,
        role: "checkbox",
        "aria-checked": checked,
        "aria-label": (s.title || props.noTitle) + " · " + props.multiSelectTitle,
        "aria-disabled": importing || undefined,
        tabIndex: importing ? -1 : 0,
        onClick: importing ? undefined : () => onToggle(key),
        onKeyDown: importing ? undefined : (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(key); }
        },
        onFocus: () => props.onHot(key, null, groupName),
        onBlur: () => props.onHot(null, key, groupName),
        onMouseEnter: () => props.onHot(key, null, groupName),
        onMouseLeave: () => props.onHot(null, key, groupName),
      },
        React.createElement(SourceBadge, {
          format: s.format, checked, disabled: importing, size: 22,
          title: label,
          palette: { border: colors.border, accent: colors.accent, text: colors.text, overlay: badgeOverlay },
        }),
        React.createElement("div", { style: style.itemMain },
          React.createElement("div", {
            style: { ...style.itemTitle, ...(lit ? style.itemTitleActive : null) },
          }, s.title || props.noTitle)),
        React.createElement("div", { style: style.rowSlot },
          hot ? null : React.createElement("span", { style: style.rowTime }, time),
          React.createElement("button", {
            style: hot ? (imported ? style.syncBtn : style.importBtn) : style.rowBtnIdle,
            disabled: importing,
            // 行本身可勾选 → 按钮必须拦住冒泡，否则「点导入」会顺带勾上这一行
            onClick: (e) => { e.stopPropagation(); onImport(s); },
            onFocus: () => props.onHot(key, null, groupName),
            onBlur: () => props.onHot(null, key, groupName),
            title: imported ? props.syncTitle : props.importTitle,
          }, imported ? props.syncLabel : props.importLabel)));
    }, (a, b) => a.s === b.s && a.checked === b.checked && a.hot === b.hot && a.importing === b.importing
      && a.label === b.label && a.time === b.time && a.tip === b.tip
      && a.colors === b.colors && a.badgeOverlay === b.badgeOverlay && a.style === b.style
      && a.onToggle === b.onToggle && a.onImport === b.onImport && a.onHot === b.onHot);

    /** 发现 + 导入面板：来源过滤 + 按工作区文件夹分组 + 单选/多选导入 */
    function DiscoveryPanel() {
      const t = useTranslate();
      // colors / style 引用必须稳定：它们是 memo 行的 props，每次新建会让 memo 失效
      const colors = useMemo(() => themeColors(), []);
      const badgeOverlay = overlayColorForAccent(colors.accent);
      const style = useMemo(() => makeStyles(colors), [colors]);
      // 容器宽度（侧边栏可拖宽）：低于阈值时按钮/分页降级为图标、页码压缩为 1/N。
      const [rootRef, panelWidth] = useContainerWidth();
      const narrow = panelWidth !== 0 && panelWidth < NARROW_MAX_WIDTH;
      const [source, setSource] = useState(SOURCES[0]);
      // 「导入到」：dsh3 / dsh4 = 建指定代次的 DSH 会话（默认按探测到的宿主版本）；
      // claude / codex / kimi / opencode → 转投到目标工具格式
        // "" = 未定：首个扫描响应带回 dshVersion 后按宿主版本定项（见扫描循环）
    const [target, setTarget] = useState("");
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [timeFilter, setTimeFilter] = useState(TIME_FILTERS[0]); // '' = 不筛选
      const [items, setItems] = useState([]); // 流式累计缓冲（scan 逐条按发现顺序插入）
      const [stream, setStream] = useState({ done: false, cursor: 0, total: 0, started: false });
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(new Map()); // key → 会话条目
      const [importing, setImporting] = useState(false);
      const [result, setResult] = useState(null);
      // 已导入跳过的会话 → Toast（「忽略警告」用 force 再导一次）
      const [skippedToast, setSkippedToast] = useState(null);
      const [epoch, setEpoch] = useState(0); // 刷新 / 导入后自增 → 服务端新扫描键
      const [queryInput, setQueryInput] = useState(""); // 搜索框输入（未提交）
      const [query, setQuery] = useState(""); // 已提交的搜索词（请求用）
      const [page, setPage] = useState(0); // 当前页（0 基）
      // 每页条数：默认 25（列表视口约 16 行 → 25 行≈1.6 屏、渲染约 3ms；50 行要滚 3 屏才够到分页条）
      // 每页条数：默认 500（窗口化后档位大小不影响渲染开销，放大只是少翻几次页）
      const [pageSize, setPageSize] = useState(500);
      const [collapsed, setCollapsed] = useState(new Set()); // 已折叠的工作区分组名
      // 工具栏动作按钮的降级判据：看「动作按钮组」实测到的可用宽度，而不是面板宽度——
      // 工作区筛选芯片也在这条工具栏上，它会按工作区名吃掉宽度，只看面板宽度会让按钮在
      // 中间那一段宽度里被压扁/折行。探针量出文字形态需要多宽，两者一比即可（字体大小
      // 随主题偏好变化，所以不写死阈值）。
      const [toolsRef, toolsWidth] = useContainerWidth();
      const toolsProbeRef = useRef(null);
      const [toolsNeed, setToolsNeed] = useState(0);
      const [hotKey, setHotKey] = useState(null); // 点亮中的会话行（悬停或行内按钮聚焦）
      const [hotKeyGroup, setHotKeyGroup] = useState(null); // 该行所属分组（组头随之变亮，O(1)）
      const [hotGroup, setHotGroup] = useState(null); // 悬停的工作区分组头

      // 流式加载：后台扫描 + after 游标轮询——会话按发现顺序逐条 append 到缓冲，
      // 首屏不被全量扫描阻塞；每次请求只取 cursor 之后的增量（服务端 seq 去重）。
      // 同来源 + 同搜索词的再次扫描（导入后 epoch 自增触发的刷新）不清空旧列表：旧数据留在
      // 屏幕上，新扫描的首批到达时整批替换——避免「清空 → 重填」那一下闪烁。换来源 / 换
      // 搜索词才是真的换了数据集，照旧清空。
      const scanKeyRef = useRef(null);
      useEffect(() => {
        let cancelled = false;
        const scanKey = source + "\u0000" + query;
        const isRefresh = scanKeyRef.current === scanKey;
        scanKeyRef.current = scanKey;
        (async () => {
          if (!isRefresh) setItems([]);
          let firstBatch = isRefresh;
          setStream({ done: false, cursor: 0, total: 0, started: false });
          setError(null);
          setResult(null);
          setPage(0);
          let after = 0;
          let done = false;
          let failed = null;
          let seen = { done: false, total: 0, started: false }; // 已渲染的流状态（防空轮询重渲染）
          while (!cancelled && !done && !failed) {
            let data = null;
            try {
              const resp = await fetch("/api-import/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source, query, epoch, after }),
              });
              data = await parsePanelResponse(resp);
            } catch (err) {
              failed = "导入面板请求失败：" + String((err && err.message) || err);
              break;
            }
            if (cancelled) return;
            if (!data || data.ok !== true) {
              failed = (data && data.error) || t("error.load");
              break;
            }
            after = typeof data.cursor === "number" ? data.cursor : after;
            done = data.done === true;
            // 「导入到」的默认目标跟随探测到的宿主会话格式版本：用户没选过（state 为空）时
            // 首次扫描响应到达即定项——V4 宿主默认 DSH（V4 会话格式），V3 宿主默认 V3。
            if (typeof data.dshVersion === "number") {
              setTarget((cur) => (cur ? cur : (data.dshVersion >= 4 ? "dsh4" : "dsh3")));
            }
            const batch = Array.isArray(data.sessions) ? data.sessions : [];
            if (batch.length > 0) {
              // 流式期间纯追加（发现顺序，行不跳动、页面稳定）；扫描完成时一次性
              // 重排回时间倒序（单次排序事件，之后恒定）——不做每块全量重排
              // 刷新场景：首批整批替换（旧列表在新数据到达前一直可见）；其余照旧追加
              setItems((prev) => mergeItems(firstBatch ? [] : prev, batch, done));
              firstBatch = false;
            }
            // 只在状态变化时更新流元信息（首帧 / done 翻转 / total 更新）——
            // 扫描中每 250ms 的空轮询不触发重渲染，面板保持稳定
            const nextStream = { done, cursor: after, total: typeof data.total === "number" ? data.total : 0, started: true };
            if (!seen.started || seen.done !== done || seen.total !== nextStream.total) {
              seen = nextStream;
              setStream(nextStream);
            }
            if (done && typeof data.error === "string" && data.error) {
              failed = data.error;
              break;
            }
            if (!done) {
              // 每块处理完显式让出一个宏任务：浏览器在块间绘制 / 响应输入——
              // 若不让出，连续大块的主线程同步处理会让滚轮与其余 UI 长时间无响应
              await sleep(0);
              // 扫描已完成但条目未排干（total 为数值）→ 排干节奏；扫描中常规频率。
              // 节奏不能比块处理耗时更密（否则主线程被持续占用，块间无响应窗口）。
              await sleep(typeof data.total === "number" ? 120 : 250);
            }
          }
          if (!cancelled && failed) setError(failed);
        })();
        return () => { cancelled = true; };
      }, [source, query, epoch]);

      useEffect(() => {
        const node = toolsProbeRef.current;
        if (!node) return undefined;
        const update = () => setToolsNeed(node.getBoundingClientRect().width);
        update();
        if (typeof ResizeObserver === "function") {
          const ro = new ResizeObserver(update);
          ro.observe(node);
          return () => ro.disconnect();
        }
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
      }, []);

      // 来源/搜索词/工作区变化 → 清空跨页选择（换页/刷新保留选择，支持跨页多选）
      useEffect(() => { setSelected(new Map()); }, [source, query, workspaceFilter, timeFilter]);

      // 显式选了 DSH 来源与 DSH 目标且**代次不同**（V3 ↔ V4）→ 底部多一个「导入所选并
      // 归档旧会话」按钮：导入按目标代次建新会话，同时把源会话在宿主里归档（迁移的收尾）。
      const srcVersion = source === "dsh" ? 3 : source === "dsh4" ? 4 : 0;
      const targetVersion = target === "dsh3" ? 3 : target === "dsh4" ? 4 : 0;
      const migrate = srcVersion !== 0 && targetVersion !== 0 && srcVersion !== targetVersion;

      // 执行导入（单选/多选共用）：POST /api-import/import → 摘要 → 重取列表刷新状态
      const doImport = async (items, { replace = false, force = false, archiveSources = false } = {}) => {
        if (!items || items.length === 0 || importing) return;
        setImporting(true);
        setResult(null);
        try {
          const resp = await fetch("/api-import/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items, replace: replace === true, force: force === true, archiveSources: archiveSources === true, target }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            const summary = data.target && !String(data.target).startsWith("dsh")
              ? fmtTransferResult(data.results, data.target, t)
              : fmtImportResult(data.results, t);
            // 归档旧会话的结果如实附在摘要后（宿主没有归档 API 时点名，不假装成功；
            // 导入未成功的条目不会被归档，条数经 archiveSkipped 单独说明——归档不可逆，
            // 不能让用户以为「已归档」等于「已迁移」）
            const archiveNote = archiveSources
              ? [
                data.archiveUnsupported
                  ? t("archive.unsupported")
                  : typeof data.archived === "number" ? t("archive.done", { n: data.archived }) : "",
                typeof data.archiveSkipped === "number" && data.archiveSkipped > 0
                  ? t("archive.skipped", { n: data.archiveSkipped }) : "",
              ].filter(Boolean).map((line) => "\n" + line).join("")
              : "";
            setResult(summary + archiveNote);
            // 兜底不再静默：被幂等跳过（already-imported）的条目单独出 Toast，用户点
            // 「忽略警告」即用 force 再导一次（另铸新会话）。force 轮本身不再重复提示。
            const alreadyPaths = new Set((data.results || [])
              .filter((r) => r && r.status === "already-imported")
              .map((r) => r.sourcePath));
            const skipped = force ? [] : items.filter((it) => alreadyPaths.has(it.sourcePath));
            setSkippedToast(skipped.length > 0 ? { count: skipped.length, items: skipped } : null);
            setSelected(new Map());
            // 单条导入（非 force / 非转投 / 非多会话）本地把该行标成已导入即可，不重扫：
            // 重扫只为刷新状态，而这条路径的状态变化是可确定的（multi 源的 partial 语义、
            // force 另铸 id 都不在这里）。其余情况仍走 epoch 重扫，但不清空旧列表。
            const only = (data.results || []).length === 1 ? data.results[0] : null;
            const donePath = only && typeof only.sourcePath === "string" ? only.sourcePath : "";
            const localPatch = only && only.status === "imported" && only.mode === "single"
              && !force && !archiveSources && donePath !== "";
            if (localPatch) {
              setItems((prev) => prev.map((s) => (s.sourcePath === donePath ? { ...s, importStatus: "imported" } : s)));
            } else {
              setEpoch((n) => n + 1);
            }
          } else if (data && data.error) {
            setResult(data.error);
          } else {
            setResult(t("error.route"));
          }
        } catch (err) {
          setResult(t("error.import", { msg: String((err && err.message) || err) }));
        } finally {
          setImporting(false);
        }
      };

      const toggleAll = () => {
        if (!sessions || sessions.length === 0) return;
        const allKeys = sessions.map(itemKey);
        const allSelected = allKeys.every((k) => selected.has(k));
        setSelected(allSelected ? new Map() : new Map(allKeys.map((k, i) => [k, sessions[i]])));
      };

      // 搜索：提交词 + 回到第一页；来源/搜索词变化由上方 effect 清空跨页选择
      const applySearch = () => {
        setQuery(queryInput.trim());
        setPage(0);
        setEpoch((n) => n + 1);
      };
      const clearSearch = () => {
        setQueryInput("");
        setQuery("");
        setPage(0);
        setEpoch((n) => n + 1);
      };
      // 以下派生数据全部 memo：悬停 / 勾选引起的重渲染（每行一次）不再重算过滤、分组、排序。
      // 大档位（几百上千行）时这一步才是真正的热点。
      // 列表窗口：只挂载可见区间那几十行（大档位下元素创建 / DOM / 布局都不再随档位线性增长）
      const [listEl, setListEl] = useState(null);
      const [win, setWin] = useState({ top: 0, h: 600 });
      useEffect(() => {
        if (!listEl) return undefined;
        let frame = 0;
        const sync = () => {
          frame = 0;
          const next = { top: listEl.scrollTop, h: listEl.clientHeight };
          setWin((prev) => (prev.top === next.top && prev.h === next.h ? prev : next));
        };
        const onScroll = () => { if (frame === 0) frame = requestAnimationFrame(sync); };
        sync();
        listEl.addEventListener("scroll", onScroll, { passive: true });
        let ro = null;
        if (typeof ResizeObserver === "function") { ro = new ResizeObserver(sync); ro.observe(listEl); }
        return () => {
          listEl.removeEventListener("scroll", onScroll);
          if (frame) cancelAnimationFrame(frame);
          if (ro) ro.disconnect();
        };
      }, [listEl]);
      // 换页 / 改每页条数 → 回到列表顶部（否则从第 3 屏切到新页会停在半空）
      useEffect(() => { if (listEl) listEl.scrollTop = 0; }, [listEl, page, pageSize]);

      // memo 行的回调：实现随每次渲染更新，但暴露给行的函数引用恒定（否则 memo 白做）
      const rowActions = useRef({});
      rowActions.current = {
        hot: (key, only, group) => {
          if (key !== null) { setHotKey(key); setHotKeyGroup(group || null); return; }
          setHotKey((k) => (k === only ? null : k));
          setHotKeyGroup((current) => (only && current === null ? null : current));
        },
        toggle: (key) => {
          setSelected((prev) => {
            const next = new Map(prev);
            if (next.has(key)) { next.delete(key); return next; }
            for (const s of items) {
              if (itemKey(s) === key) { next.set(key, s); break; }
            }
            return next;
          });
        },
        import: (s) => doImport([toItem(s)]),
      };
      const onHot = useCallback((key, only, group) => rowActions.current.hot(key, only, group), []);
      const onToggle = useCallback((key) => rowActions.current.toggle(key), []);
      const onImport = useCallback((s) => rowActions.current.import(s), []);

      // 路径筛选（工作区）+ 时间筛选（最后活跃/创建时间落在窗口内）叠加
      const filteredItems = useMemo(() => {
        const byPath = filterByWorkspace(items, workspaceFilter);
        const span = TIME_FILTER_MS[timeFilter];
        if (!span) return byPath;
        const floor = Date.now() - span;
        return byPath.filter((s) => ((s.lastActiveAt || s.createdAt) || 0) >= floor);
      }, [items, workspaceFilter, timeFilter]);
      const allRows = pageSize === ALL_PAGE_SIZE;
      const totalPages = allRows ? 1 : Math.max(1, Math.ceil(filteredItems.length / pageSize));
      // 当前页窗口 = 工作区筛选后的缓冲切片（服务端不再分页；翻页零重扫）；「全部」档不分页
      const sessions = useMemo(
        () => (allRows ? filteredItems : filteredItems.slice(page * pageSize, (page + 1) * pageSize)),
        [filteredItems, page, pageSize, allRows],
      );
      // 未导入/已导入条目（跨页全量，供「仅选未导入 / 仅选已导入」批量勾选）
      const importableFiltered = useMemo(
        () => (stream.done ? importableSessions(items, workspaceFilter) : []),
        [items, workspaceFilter, stream.done],
      );
      const refreshableFiltered = useMemo(
        () => (stream.done ? refreshableSessions(items, workspaceFilter) : []),
        [items, workspaceFilter, stream.done],
      );
      const workspaceOptions = useMemo(() => buildWorkspaceOptions(items), [items]);
      // 分页文案总数：扫描完成后用服务端 total（过滤后总数）；扫描中显示已发现数
      const displayTotal = filteredItems.length;
      // 底部一条的状态文案：扫描中报进度，扫描完成报「第 x / y 页 · 共 N 个」（合并掉原来
      // 列表上方那条独立状态行）；「全部」档没有页码，只报总数。
      const scanning = !error && stream.started && !stream.done;
      const barText = scanning
        ? t("scan.status.progress", { n: items.length })
        : t("count.total", { n: displayTotal });

      // 组内最新会话的最后编辑时间（组排序键：最近活跃的工作区置顶）
      const groupLatest = (list) => list.reduce((m, s) => Math.max(m, s.lastActiveAt ?? s.createdAt ?? 0), 0);
      // 按工作区文件夹（project）分组：组按组内最新会话的最后编辑时间降序（最近活跃
      // 的工作区置顶，时间并列按工作区名升序稳定），组内按最后编辑时间降序；未分组钉最后
      const groups = useMemo(() => {
        const out = [];
        if (!sessions || sessions.length === 0) return out;
        const byProject = new Map();
        for (const s of sessions) {
          const key = workspaceKey(s);
          if (!byProject.has(key)) byProject.set(key, []);
          byProject.get(key).push(s);
        }
        const names = [...byProject.keys()].sort((a, b) => {
          if (a === NO_WORKSPACE_KEY) return 1;
          if (b === NO_WORKSPACE_KEY) return -1;
          return (groupLatest(byProject.get(b)) - groupLatest(byProject.get(a))) || a.localeCompare(b);
        });
        for (const name of names) out.push({ name, list: [...byProject.get(name)].sort(byTimeDesc) });
        return out;
      }, [sessions]);

      // allSelected 是 O(页大小)：无分页时每次渲染都要扫一遍 10 万行 → memo 到 selected/sessions
      const allSelected = useMemo(
        () => sessions && sessions.length > 0 && sessions.every((s) => selected.has(itemKey(s))),
        [sessions, selected],
      );

      // 每组在列表中的纵向偏移（固定行高 → 纯算术；折叠组只算组头）
      const laid = useMemo(() => {
        let cursor = 0;
        return groups.map((group) => {
          const rowsTop = cursor + LIST_HEAD_H;
          cursor += LIST_HEAD_H + (collapsed.has(group.name) ? 0 : group.list.length * LIST_ROW_H);
          return { group, rowsTop };
        });
      }, [groups, collapsed]);

      const renderGroup = (entry) => {
        const group = entry.group;
        const isCollapsed = collapsed.has(group.name);
        const toggleGroup = () => {
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(group.name)) next.delete(group.name);
            else next.add(group.name);
            return next;
          });
        };
        // 窗口切片：只把可见区间（上下各 LIST_OVERSCAN 行）交给 React，其余用等高占位块撑住，
        // 滚动条长度与分组头 sticky 行为都不变
        let visible = [];
        let padTop = 0;
        let padBottom = 0;
        if (!isCollapsed) {
          const total = group.list.length * LIST_ROW_H;
          const pad = Math.max(LIST_OVERSCAN_MIN, Math.ceil(win.h / LIST_ROW_H));
          const first = Math.max(0, Math.floor((win.top - entry.rowsTop) / LIST_ROW_H) - pad);
          const last = Math.min(group.list.length, Math.ceil((win.top + win.h - entry.rowsTop) / LIST_ROW_H) + pad);
          if (last > first) {
            visible = group.list.slice(first, last);
            padTop = first * LIST_ROW_H;
            padBottom = total - padTop - visible.length * LIST_ROW_H;
          } else {
            padTop = Math.min(total, Math.max(0, first * LIST_ROW_H));
            padBottom = total - padTop;
          }
        }
        const rows = visible.map((s) => {
          const key = itemKey(s);
          const ts = s.lastActiveAt || s.createdAt;
          const ctxTok = fmtTokenCount(s.contextTokens);
          // 行内只留「工具标 + 标题 + 时间」；来源 / 上下文 / 分支 / 导入状态 / 绝对时间
          // 收进悬停提示（行内信息越少越好扫）
          const tip = [
            sourceLabel(s.format),
            ctxTok ? t("count.contextTokens", { n: ctxTok }) : null,
            s.gitBranch ? s.gitBranch + (s.gitDirty ? " ✗" : "") : null,
            statusLabel(s.importStatus, t),
            fmtTime(ts),
          ].filter(Boolean).join(" · ");
          return React.createElement(SessionRow, {
            key,
            s,
            style,
            colors,
            badgeOverlay,
            groupName: group.name,
            label: sourceLabel(s.format),
            time: relTime(ts, t) || t("timeUnknown"),
            tip: (s.title || t("noTitle")) + (tip ? "\n" + tip : ""),
            checked: selected.has(key),
            hot: hotKey === key,
            importing,
            onToggle,
            onImport,
            onHot,
            noTitle: t("noTitle"),
            multiSelectTitle: t("multiSelect.title"),
            syncLabel: t("sync"),
            syncTitle: t("sync.title"),
            importLabel: t("import.one"),
            importTitle: t("import.one.title"),
          });
        });
        // 分组头：与皮肤一致——悬停（或组内任意行悬停）时文字变亮并露出折叠箭头，
        // 不浮背景矩形（它是标题不是目标）
        const headHot = hotGroup === group.name || hotKeyGroup === group.name;
        return React.createElement(React.Fragment, { key: group.name },
          React.createElement("div", {
            style: { ...style.group, ...(headHot ? { color: colors.text } : null) },
            onClick: toggleGroup,
            title: isCollapsed ? t("group.expand") : t("group.collapse"),
            onMouseEnter: () => setHotGroup(group.name),
            onMouseLeave: () => setHotGroup((g) => (g === group.name ? null : g)),
          },
            React.createElement("span", { style: style.groupLabel }, workspaceLabel(group.name, t)),
            React.createElement("span", {
              style: {
                ...style.groupChevron, opacity: headHot ? 1 : 0,
                transform: isCollapsed ? "rotate(-90deg)" : "none",
                transition: "opacity .12s ease, transform .15s ease",
              },
            }, React.createElement(Icon, { name: "chevronDown", size: 12, strokeWidth: 1.5 })),
            React.createElement("span", { style: style.groupCount }, t("count.sessions", { n: group.list.length }))),
          padTop > 0 ? React.createElement("div", { key: "pad-top", "aria-hidden": true, style: { height: padTop + "px" } }) : null,
          rows,
          padBottom > 0 ? React.createElement("div", { key: "pad-bottom", "aria-hidden": true, style: { height: padBottom + "px" } }) : null);
      };

      // 工具栏/分页按钮：宽态文字、窄态图标（title 保留说明，aria-label 保留可访问名；
      // extra.title 可覆盖默认的「文字即标题」，如刷新的详细提示）。
      const toolBtn = (label, icon, extra, asIcon) => {
        const iconOnly = asIcon === undefined ? narrow : asIcon;
        return React.createElement("button", {
          style: iconOnly ? style.iconBtn : style.toolBtn,
          title: label,
          "aria-label": label,
          ...(extra || {}),
        }, iconOnly ? React.createElement(Icon, { name: icon }) : label);
      };
      const selectAllLabel = allSelected ? t("deselectAll") : t("selectAll");
      // 动作按钮降级：窄面板一律图标；否则看动作按钮组的实测宽度够不够放文字形态
      const toolsIcon = narrow || (toolsWidth !== 0 && toolsNeed !== 0 && toolsWidth < toolsNeed);

      const body = React.createElement(React.Fragment, null,
          // 来源与落点读成一行：「从 全部来源 导入到 DSH 会话环境」——「从」与「导入到」都是
          // 连接词，两个下拉的触发器只显文本（品牌标 / 锁标只在下拉弹层里出现），否则这句话
          // 会被两段 logo 切成读不通的碎片
          React.createElement("div", { style: style.rowPlain },
            React.createElement("span", { style: style.rowJoin }, t("from")),
            React.createElement(SearchableSelect, {
              value: source, title: t("source.title"), colors,
              disabled: importing,
              searchPlaceholder: t("combobox.search.source"),
              noMatchLabel: t("combobox.noMatch"),
              // lockup: true —— 来源行画品牌锁标（mark + 字标），只有这个下拉开：导入目标
              // 与工作区行仍然只画「品牌标 + 文本」（目标的 DSH 不是品牌名，工作区没有品牌）
              // DSH 两代的展示名带「会话格式」字样，走 i18n；其余是产品名（不翻译）
              options: SOURCES.map((s) => ({ value: s, label: s ? (s === "dsh" || s === "dsh4" ? t("source." + s) : (SOURCE_LABELS[s] || s)) : t("allSources"), mark: s || null, lockup: true })),
              onChange: (v) => {
                setSource(v);
                setWorkspaceFilter("");
                setPage(0);
                setQuery("");
                setQueryInput("");
              },
            }),
            React.createElement("span", { style: style.rowJoin }, t("importTo")),
            React.createElement(SearchableSelect, {
              value: target, title: t("importTo.title"), colors,
              disabled: importing,
              searchPlaceholder: t("combobox.search.target"),
              noMatchLabel: t("combobox.noMatch"),
              // dsh3 / dsh4 共用 DSH 品牌标（mark 键仍是 dsh）
              options: IMPORT_TARGETS.map((v) => ({ value: v, label: t("target." + v), mark: String(v).startsWith("dsh") ? "dsh" : v })),
              onChange: (v) => setTarget(v),
            })),
          // DSH 目标（含未定）不显示落点提示；只有转投目标才有
          target === "" || String(target).startsWith("dsh")
            ? null
            : React.createElement("div", { style: style.targetHint }, t("target.hint." + target)),
          // 筛选层：搜索词（搜索按钮 / Enter 提交）
          React.createElement("div", { style: style.searchRow },
            React.createElement("input", {
              style: style.searchInput, value: queryInput, placeholder: t("search.placeholder"),
              onChange: (e) => setQueryInput(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") applySearch(); },
            }),
            React.createElement("button", {
              style: narrow ? style.searchIconBtn : style.searchBtn,
              onClick: applySearch, title: t("search"), "aria-label": t("search"),
            }, narrow ? React.createElement(Icon, { name: "search" }) : t("search")),
            React.createElement("button", {
              style: narrow ? style.iconBtn : style.toolBtn,
              onClick: clearSearch, disabled: (!queryInput && !query) || importing,
              title: t("clearSearch"), "aria-label": t("clearSearch"),
            }, narrow ? React.createElement(Icon, { name: "x" }) : t("clearSearch"))),
          React.createElement("div", { style: style.toolbar },
            React.createElement("div", { ref: toolsRef, style: style.toolbarActions },
              toolBtn(selectAllLabel, "checkSquare", { onClick: toggleAll, disabled: filteredItems.length === 0 || importing }, toolsIcon),
              toolBtn(t("clearSelection"), "x", { onClick: () => setSelected(new Map()), disabled: selected.size === 0 || importing }, toolsIcon),
              toolBtn(t("refresh"), "refresh", { onClick: () => setEpoch((n) => n + 1), disabled: importing, title: t("refresh.title") }, toolsIcon),
              toolBtn(t("selectImportable"), "circle", {
                disabled: importableFiltered.length === 0 || importing || !stream.done,
                onClick: () => setSelected(new Map(importableFiltered.map((s) => [itemKey(s), s]))),
              }, toolsIcon),
              toolBtn(t("selectImported"), "checkCircle", {
                disabled: refreshableFiltered.length === 0 || importing || !stream.done,
                onClick: () => setSelected(new Map(refreshableFiltered.map((s) => [itemKey(s), s]))),
              }, toolsIcon)),
            // 探针：与真实按钮同款文字、同款 button 元素，只为量出「文字形态需要多宽」；
            // 绝对定位 + 不可见，不参与排版也不可交互（tabIndex -1 保证不进键盘序）
            React.createElement("div", { ref: toolsProbeRef, "aria-hidden": true, style: style.toolbarProbe },
              [selectAllLabel, t("clearSelection"), t("refresh"), t("selectImportable"), t("selectImported")]
                .map((label) => React.createElement("button", {
                  key: label, type: "button", tabIndex: -1, style: style.toolBtn,
                }, label))),
            // 工作区筛选挂在工具栏末位：与动作按钮分组，且不走 toolBtn——窄面板下工具按钮
            // 降级成图标时它仍保持文字
            React.createElement("span", { style: style.toolbarFilter },
              // 标签本身就是按钮：默认只写「筛选：路径」，选中后补「· 值」，避免「标签 + 芯片」两段
              React.createElement(SearchableSelect, {
                value: workspaceFilter, title: t("workspace.title"), colors,
                triggerLabel: workspaceFilter
                  ? t("filter.path") + " · " + workspaceLabel(workspaceFilter, t)
                  : t("filter.path"),
                disabled: items.length === 0 || importing,
                searchPlaceholder: t("combobox.search.workspace"),
                noMatchLabel: t("combobox.noMatch"),
                options: [{ value: "", label: t("filter.all") }].concat(
                  workspaceOptions.map((o) => {
                    const label = workspaceLabel(o.key, t);
                    // 路径与显示名不同才当副标题（同名时画一遍就够）
                    return { value: o.key, label, sub: o.path && o.path !== label ? o.path : null };
                  })),
                onChange: (v) => { setWorkspaceFilter(v); setPage(0); },
              })),
            // 「筛选：时间」：短菜单（4 项）不挂搜索框
            React.createElement("span", { style: style.filterGroup },
              React.createElement(SearchableSelect, {
                value: timeFilter, title: t("filter.time"), colors,
                searchable: false,
                triggerLabel: timeFilter
                  ? t("filter.time") + " · " + t("filter.time." + timeFilter)
                  : t("filter.time"),
                disabled: items.length === 0 || importing,
                options: TIME_FILTERS.map((v) => ({ value: v, label: t("filter.time." + (v || "all")) })),
                onChange: (v) => { setTimeFilter(v); setPage(0); },
              }))),
          // 还没拿到第一批数据：居中显示连接提示（拿到数据后状态就交给底部那条）
          !stream.started && !error && React.createElement("div", { style: style.status }, t("scan.hint.start")),
          error && React.createElement("div", { style: style.error }, error),
          stream.done && !error && filteredItems.length === 0 && React.createElement("div", { style: style.status }, query || workspaceFilter ? t("noMatch") : t("noSessions")),
          // 列表容器**恒渲染**（flex:1 撑满剩余高度）：此前 items 为空时整个容器不存在，
          // 底部操作区（结果摘要 + 导入按钮）就会被内容顶到上面去；空列表时它只是没有行。
          !error && React.createElement("div", { ref: setListEl, style: style.list },
            items.length > 0 ? laid.map(renderGroup) : null),
          items.length > 0 && React.createElement("div", { style: style.pageBar },
            // 翻页只留图标、不套框；页码由页控件承担（点开是网格）。只有一页时整组不显示
            totalPages > 1 && React.createElement("button", {
              type: "button", style: style.pageNavBtn, disabled: page === 0 || importing,
              onClick: () => setPage((p) => Math.max(0, p - 1)),
              title: t("previous"), "aria-label": t("previous"),
              onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
            }, React.createElement(Icon, { name: "chevronLeft", size: 16 })),
            totalPages > 1 && React.createElement(PageJump, {
              page, totalPages, colors, style, onPick: (p) => setPage(p),
            }),
            totalPages > 1 && React.createElement("button", {
              type: "button", style: style.pageNavBtn, disabled: page >= totalPages - 1 || importing,
              onClick: () => setPage((p) => Math.min(totalPages - 1, p + 1)),
              title: t("next"), "aria-label": t("next"),
              onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
            }, React.createElement(Icon, { name: "chevronRight", size: 16 })),
            React.createElement("span", { style: style.pageInfo, title: barText }, barText),
            // 总数不足最小档（500）时换档没有意义，连选择器一起隐藏；翻页组同理看页数
            displayTotal >= 500 && React.createElement("span", { style: style.pageSizeLabel }, t("pageSize")),
            displayTotal >= 500 && React.createElement("select", {
              style: { ...style.select, flex: "none", width: "86px", padding: "4px 6px", fontSize: "12px" },
              value: pageSize,
              disabled: importing,
              onChange: (e) => {
                const v = e.target.value;
                setPageSize(v === ALL_PAGE_SIZE ? ALL_PAGE_SIZE : Number(v));
                setPage(0);
              },
            }, PAGE_SIZES.map((n) => React.createElement("option", {
              key: n, value: n,
            }, n === ALL_PAGE_SIZE ? t("pageSizeAll") : String(n))))),
          // 底部主操作区：导入结果 + 导入所选（列表与分页之外的固定区，滚动时始终可见）
          result && React.createElement("div", { style: style.resultBar }, result),
          // 兜底不再静默：被幂等跳过的会话出 Toast，点「忽略警告」用 force 再导一次
          skippedToast && React.createElement("div", { style: style.toast, role: "status" },
            React.createElement("span", { style: style.toastText }, t("toast.skipped", { n: skippedToast.count })),
            React.createElement("button", {
              type: "button", style: style.toastAction, disabled: importing,
              onClick: () => {
                const items = skippedToast.items;
                setSkippedToast(null);
                doImport(items, { force: true });
              },
            }, t("toast.ignore"))),
          React.createElement("div", { style: style.importBar },
            migrate && React.createElement("button", {
              style: {
                ...style.primaryBtn,
                background: colors.accentForeground,
                color: colors.accent,
                border: "1px solid " + colors.accent,
                // 两个按钮并排：允许收缩、绝不换行（窄了走省略号），窄面板用短标签
                flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis",
                opacity: selected.size === 0 || importing ? 0.55 : 1,
              },
              disabled: selected.size === 0 || importing,
              title: t("import.selectedArchive.title"),
              onClick: () => doImport([...selected.values()].map(toItem), { archiveSources: true }),
            }, importing ? t("importing") : (narrow
              ? t("import.selectedArchive.short", { n: selected.size })
              : t("import.selectedArchive", { n: selected.size }))),
            React.createElement("button", {
              style: { ...style.primaryBtn, opacity: selected.size === 0 || importing ? 0.55 : 1 },
              disabled: selected.size === 0 || importing,
              onClick: () => doImport([...selected.values()].map(toItem)),
            }, importing ? t("importing") : t("import.selected", { n: selected.size }))));
      return React.createElement("div", { ref: rootRef, style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, position: "relative" } },
        body);
    }

    /** 插件 logo（assets/import.svg 内联，跟随 currentColor 适配明暗主题） */
    function LogoIcon({ size }) {
      const s = size || 16;
      return React.createElement("svg", {
        width: s, height: s, viewBox: "0 0 1024 1024", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: { flex: "none" },
        "aria-hidden": true,
      },
        React.createElement("path", {
          d: "M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z",
          fill: "currentColor" }),
        React.createElement("path", {
          d: "M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z",
          fill: "currentColor" }));
    }

    /** 右侧栏 guide 胶囊图标（tab 类型注册的 guide entry icon，组件面收 {size} 按需
     *  缩放；胶囊内以 currentColor 呈现，随主题与选中态自动适配）。 */
    function ImportGlyph(props) {
      const size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return React.createElement(LogoIcon, { size });
    }

    const SETTINGS_NAV_MARKER = "data-dsh-chat-import-settings-nav";
    const SETTINGS_NAV_STYLE_ID = "dsh-chat-import-settings-nav-style";

    /** 动态注入设置页导航图标遮罩 CSS：把宿主写死回落的齿轮 SVG 隐藏，并用 ::before
     *  伪元素配合 CSS mask 绘制本插件功能图标（currentColor 随主题与选中高亮色自动同步）。 */
    function ensureSettingsNavStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(SETTINGS_NAV_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = SETTINGS_NAV_STYLE_ID;
      const maskSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Cpath d='M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z' fill='black'/%3E%3Cpath d='M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z' fill='black'/%3E%3C/svg%3E";
      style.textContent = "\n" +
        "[" + SETTINGS_NAV_MARKER + "] > svg:first-child {\n" +
        "  display: none !important;\n" +
        "}\n" +
        "[" + SETTINGS_NAV_MARKER + "]::before {\n" +
        "  content: '';\n" +
        "  flex: none;\n" +
        "  width: 16px;\n" +
        "  height: 16px;\n" +
        "  background: currentColor;\n" +
        "  -webkit-mask: url(\"" + maskSvg + "\") center / contain no-repeat;\n" +
        "  mask: url(\"" + maskSvg + "\") center / contain no-repeat;\n" +
        "}\n";
      const target = document.head || document.documentElement || document.body;
      if (target) target.appendChild(style);
    }

    /** 监听设置弹窗导航行，给匹配当前插件分区文案的按钮添加属性标记（对齐 omdsh-dev/DSH-better-sidebar 实践）。
     *  不篡改 React DOM 结构，安全无崩溃；销毁时解绑监听并清空属性。 */
    function registerSettingsNavIcon(labelResolver) {
      if (typeof document === "undefined") return () => {};
      ensureSettingsNavStyle();
      let disposed = false;

      const sync = () => {
        if (disposed) return;
        const currentLabel = typeof labelResolver === "function" ? labelResolver().trim() : "";
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (const button of buttons) {
          const matches = currentLabel.length > 0 && button.textContent && button.textContent.trim() === currentLabel;
          if (matches) button.setAttribute(SETTINGS_NAV_MARKER, "");
          else button.removeAttribute(SETTINGS_NAV_MARKER);
        }
      };

      sync();
      let observer = null;
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }

      return () => {
        disposed = true;
        if (observer) observer.disconnect();
        try {
          const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
          for (const el of marked) el.removeAttribute(SETTINGS_NAV_MARKER);
        } catch (_) {}
      };
    }

    /** 触发按钮：三种形态按可用宽度自适应（判定纯函数见 lib/footer-layout.mjs，
     * bundle 不做构建、只能内联同款副本）。
     *
     * footer 槽是宿主 ui-sidebar 的一条不换行 flex 行（`.footerActions`），同槽条目之间
     * 抢这条行。此前按①选择器白名单认「占用者是谁」②按 `[data-slot=...]` 槽元素内容被裁
     * 判定，两条都已失效：锚点并不是本按钮——DSH 的 slot 出口是 ui-renderer 的
     * `SlotOutlet`，一个 `display:contents` 外壳（所有条目都渲染在它内部、外壳自己没有
     * 盒子：Chromium 实测 clientWidth/scrollWidth = 0/0、rect 全 0、父元素 children = 1），
     * 于是「内容被裁」恒为 false、「同槽条目」恒为 0 个，判定在生产里恒不命中
     * （#31 / #35 / #39 / #43 同一类问题的四次复发）。
     *
     * 现在只按布局事实判定，与「占用者是谁」无关：以本按钮自己的 ref 为锚点上溯到真正的
     * flex 行，量「还剩多少宽度给我」（available = 行内容宽 − 同槽其它条目占位 − 行间距 −
     * 行内边距）与「完整形态需要多宽」（needed，由按钮内一个脱离文档流的隐藏镜像量出，
     * 与按钮当前形态无关，因此判定不会自我振荡）：
     *   share — 放得下 → `flex: 1 1 auto` 与同槽条目共享一行（issue #31 的预期行为）；
     *   icon  — 放不下 → 36×36 圆钮（图标保留，文字进 title / aria-label），绝不截断、
     *           不遮挡、不动宿主布局；rail（wide=false）态同款；
     *   row   — 换行容器 / 纵排容器（issue #25）/ 找不到可共享的行 → 整宽自占一行。
     * 唯一的宿主写操作：连 36px 图标都放不下时（同槽有不可收缩的整宽条目）才把行换成
     * `wrap`、自己独占一行（0.10.1 起对整宽占用者的既有处理），卸载时还原；该判定用
     * 「不换行时能分到多少」的反事实口径，因此在「已注入 wrap → 空间仍不足」之间稳定。
     * 样式对齐设置按钮（透明底、12px 圆角、16px 图标 + 文字、悬停浅底），图标用插件 logo。
     */
    /** 图标形态宽度（与 rail 态同款 36×36 圆钮；与 lib/footer-layout.mjs 同步） */
    const FOOTER_ICON_WIDTH = 36;
    /** 完整形态左右内边距之和（对齐「设置」按钮 padding: 0 10px 0 8px） */
    const FOOTER_LABEL_PADDING = 18;
    /** 量「完整形态需要多宽」的隐藏镜像：脱离文档流 + visibility:hidden（仍参与布局计算）
     * + max-content 宽，因此与按钮当前形态/宽度无关。 */
    const FOOTER_PROBE_STYLE = {
      position: "absolute", visibility: "hidden", pointerEvents: "none",
      width: "max-content", display: "flex", alignItems: "center", gap: "8px",
      fontSize: "14px", lineHeight: "22px", left: 0, top: 0,
    };
    // —— 与 lib/footer-layout.mjs 同步的判定副本（bundle 不 import 模块，各存一份）——
    /** 「整宽条目」判据：同槽条目占到半行以上（半宽入口如 78px 的「检查更新」远低于此线） */
    const FOOTER_WIDE_OCCUPANT_RATIO = 0.5;
    /** 行内条目是否占位：浮层（fixed/absolute）不占行内空间，零尺寸条目（隐藏）不计 */
    const occupiesFooterLane = (entry) => !!entry
      && entry.position !== "fixed" && entry.position !== "absolute"
      && entry.width > 0 && entry.height > 0;
    /** 同槽条目是否本来就是「整宽条目」：与本按钮同处一行只会互相压扁，该换行各占一行 */
    const claimsFooterRow = (entry, rowWidth) => !!entry
      && Number.isFinite(rowWidth) && rowWidth > 0
      && entry.width >= rowWidth * FOOTER_WIDE_OCCUPANT_RATIO;
    /** 行内还剩多少宽度给本按钮（量不到行宽返回 NaN，调用方按「维持现状」处理） */
    const footerLaneAvailable = ({ rowWidth, padding = 0, occupiedWidth = 0, gap = 0, itemCount = 1 }) => (Number.isFinite(rowWidth)
      ? rowWidth - padding - occupiedWidth - gap * Math.max(0, itemCount - 1)
      : NaN);
    /** 形态：'share'（与同槽共享一行）| 'icon'（36×36 圆钮）| 'row'（整宽自占一行） */
    const resolveFooterSize = (facts) => {
      if (facts.rail === true) return "icon";
      if (facts.lane !== true || facts.wrapped === true) return "row";
      const available = Number(facts.available);
      const needed = Number(facts.needed);
      // 量不到（未挂载 / 镜像未渲染）→ 维持共享一行的既有形态
      if (!Number.isFinite(available) || !Number.isFinite(needed) || needed <= 0) return "share";
      return available >= needed ? "share" : "icon";
    };
    /** 是否要把宿主行换成 wrap 让各方各占一整行：同槽有整宽条目而本按钮放不下，或连
     * 36px 图标都放不下（反事实口径，因此在「已注入 wrap → 空间仍不足」之间稳定） */
    const needsFooterWrap = (facts) => {
      if (facts.rail === true || facts.lane !== true) return false;
      const available = Number(facts.available);
      if (!Number.isFinite(available)) return false;
      if (available < FOOTER_ICON_WIDTH) return true;
      const needed = Number(facts.needed);
      if (Number.isFinite(needed) && needed > 0 && available >= needed) return false;
      return facts.wideOccupant === true;
    };
    /** 量出本按钮所在的 footer 行：{ row, lane, wrapped, available, needed, wideOccupant }。
     * 锚点是本按钮自己（ref）——`[data-slot=...]` 槽出口是 display:contents 外壳、没有
     * 盒子，量不到任何东西（见 lib/footer-layout.mjs 的说明）。向上找第一条 flex 行时
     * 跳过 display:contents 外壳（多级嵌套也跳过）与单子元素的普通包裹层；行内条目经
     * 同款展开收集（跳过浮层 / 零尺寸 / 本按钮所在条目），并回报同槽是否有整宽条目。
     * `lane` 表示这条行是横向的：纵排容器（issue #25）与换行容器都如实回报，判定侧按
     * 「不换行时能分到多少」的反事实口径使用。 */
    const footerLaneFacts = (button, probe) => {
      const facts = { row: null, lane: false, wrapped: false, available: NaN, needed: NaN, wideOccupant: false };
      if (!button || typeof getComputedStyle !== "function") return facts;
      const probeRect = probe && probe.getBoundingClientRect();
      if (probeRect && probeRect.width > 0) facts.needed = probeRect.width + FOOTER_LABEL_PADDING;
      let node = button;
      while (node && node.parentElement) {
        const row = node.parentElement;
        const cs = getComputedStyle(row);
        if (cs.display === "contents") { node = row; continue; }
        if (cs.display !== "flex" && cs.display !== "inline-flex") {
          // 单子元素的普通包裹层不是行本身，真正的行还在上面
          if (row.children.length === 1) { node = row; continue; }
          return facts;
        }
        facts.row = row;
        facts.lane = cs.flexDirection.startsWith("row");
        facts.wrapped = cs.flexWrap !== "nowrap";
        if (!facts.lane) return facts;
        let occupiedWidth = 0;
        let itemCount = 1; // 本按钮自己
        let wideOccupant = false;
        const collect = (container) => {
          for (const child of container.children) {
            const childCs = getComputedStyle(child);
            // 槽出口（display:contents）把条目摊进行里：继续展开，别把它当成一个条目
            if (childCs.display === "contents") { collect(child); continue; }
            if (child.contains(button)) continue; // 本按钮所在的条目（含包裹层）不算「其它」
            const rect = child.getBoundingClientRect();
            if (!occupiesFooterLane({ position: childCs.position, width: rect.width, height: rect.height })) continue;
            const marginBox = rect.width + (parseFloat(childCs.marginLeft) || 0) + (parseFloat(childCs.marginRight) || 0);
            occupiedWidth += marginBox;
            itemCount += 1;
            if (claimsFooterRow({ width: marginBox }, row.clientWidth)) wideOccupant = true;
          }
        };
        collect(row);
        facts.wideOccupant = wideOccupant;
        facts.available = footerLaneAvailable({
          rowWidth: row.clientWidth,
          padding: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
          occupiedWidth,
          gap: parseFloat(cs.columnGap) || 0,
          itemCount,
        });
        return facts;
      }
      return facts;
    };

    function ImportButton({ wide }) {
      const t = useTranslate();
      const rail = wide === false;
      const label = t("trigger.label");
      const buttonRef = useRef(null);
      const probeRef = useRef(null);
      const [visible, setVisible] = useState(cachedSidebarButton);
      useEffect(() => {
        const listener = (val) => setVisible(val);
        sidebarButtonListeners.add(listener);
        // 0.1.7 走客户端 configForms，旧宿主走 fenced 路由（loadPrefsView 分流）。
        loadPrefsView()
          .then((d) => {
            if (d && d.ok && d.value && typeof d.value.sidebarButton === "boolean") {
              setSidebarButton(d.value.sidebarButton);
            }
          })
          .catch(() => {});
        return () => { sidebarButtonListeners.delete(listener); };
      }, []);
      // 形态：'share' / 'icon' / 'row'（判定见 lib/footer-layout.mjs）。首帧按共享一行
      // 渲染，mount 后立刻按实测宽度修正（两种形态同高，不留可见跳动）。
      const [mode, setMode] = useState("share");
      // 观测面只有「本按钮 + 它所在的那条渲染行」：ResizeObserver 跟行/按钮尺寸变化
      // （侧边栏拖宽、同槽条目增减导致的重新分配），MutationObserver 只看这条行的子树
      // （条目挂载/卸载、宿主或其它插件改 style/class）。不再观察整个文档——那会在每次
      // 消息流式渲染时触发强制布局。判定结果做等值比较，避免观察自身改动造成重渲染循环。
      // 用 layout effect 而非 effect：首帧就按实测宽度落形态，不留一帧被挤压的样子。
      useLayoutEffect(() => {
        const button = buttonRef.current;
        if (!button) return undefined;
        let observed = null; // 正在观测的宿主行
        let injected = null; // 我们注入 wrap 的行（null = 未注入）
        let restore = ""; // 注入前的 inline flex-wrap
        let ro = null;
        let mo = null;
        const check = () => {
          const facts = footerLaneFacts(button, probeRef.current);
          const next = resolveFooterSize({ rail, ...facts });
          // 连 36px 图标都放不下（同槽有不可收缩的整宽条目）→ 把行换成 wrap、自己独占
          // 一行（0.10.1 起对整宽占用者的既有处理），让 footArea 高度随内容增长。判定用
          // 「不换行时能分到多少」的反事实口径，因此在已注入 wrap 的状态下仍成立、不来回
          // 抖；占用者消失后 available 回升即还原。只写我们自己注入的那一次，其它插件
          // 注入的 wrap 不碰（写入 inline style 会触发 MutationObserver 再跑 check，但
          // `injected !== facts.row` 守卫使其不重复赋值、不形成循环）。
          if (facts.row && needsFooterWrap({ rail, ...facts })) {
            if (injected !== facts.row) {
              if (injected) injected.style.flexWrap = restore;
              injected = facts.row;
              restore = injected.style.flexWrap || "";
              injected.style.flexWrap = "wrap";
            }
          } else if (injected) {
            injected.style.flexWrap = restore;
            injected = null;
          }
          setMode((prev) => (prev === next ? prev : next));
          if (facts.row === observed) return;
          if (ro) ro.disconnect();
          if (mo) mo.disconnect();
          ro = null;
          mo = null;
          observed = facts.row;
          if (!observed) return;
          if (typeof ResizeObserver === "function") {
            ro = new ResizeObserver(check);
            ro.observe(observed);
            ro.observe(button);
          }
          if (typeof MutationObserver === "function") {
            mo = new MutationObserver(check);
            mo.observe(observed, {
              childList: true, subtree: true, attributes: true,
              attributeFilter: ["style", "class", "hidden"],
            });
          }
        };
        check();
        window.addEventListener("resize", check);
        return () => {
          window.removeEventListener("resize", check);
          if (ro) ro.disconnect();
          if (mo) mo.disconnect();
          if (injected) injected.style.flexWrap = restore;
        };
      }, [rail, label]);
      // 图标形态：rail（收起）态与宽态被挤到放不下文字时同款——36×36 圆钮、单图标
      // 18px 居中，文字保留在 title / aria-label 里（绝不截断、不遮挡、不动宿主布局）。
      const iconOnly = mode === "icon";
      // 视觉逐项对齐侧边栏「设置」按钮（ui-settings-general 的
      // SettingsRoot.module.css .trigger）：宽态 height 42px、padding
      // 0 10px 0 8px、gap 8px、圆角 12px、14px/400 lh22、overflow hidden、
      // 16×16 图标；图标形态 36×36、圆角 50%、单图标 18px 居中。颜色/悬停走
      // 侧边栏同一 CSS 变量（--dsw-alias-label-primary /
      // --dsw-alias-interactive-bg-hover），明暗主题下与设置按钮一致。
      const baseStyle = {
        boxSizing: "border-box",
        display: "flex", alignItems: "center",
        justifyContent: iconOnly ? "center" : undefined,
        gap: iconOnly ? "0" : "8px",
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "inherit",
        borderRadius: iconOnly ? "50%" : "12px",
        padding: iconOnly ? "0" : "0 10px 0 8px",
        height: iconOnly ? "36px" : "42px",
        fontSize: "14px", lineHeight: "22px",
        cursor: "pointer",
        overflow: "hidden",
      };
      // 行内尺寸按形态三分派：
      // - share：flex: 1 1 auto + width: auto + min-width: 0，与同槽其它入口（如
      //   dsh-web-all 的「检查更新/远程访问」）共享一行、按比例分配宽度（issue #31）。
      //   早期用 width: 100% + flex: 0 0 auto 独占整行，把同槽条目挤出 280px 侧栏被
      //   overflow: hidden 裁剪；仅本插件一个入口时 flex-grow 仍撑满整行，视觉一致。
      // - icon：36×36 且 flex: 0 0 auto（不收缩），同槽条目再多也压不没图标。
      // - row：整宽自占一行——wrap 容器（tokenledger 注入或本插件注入）里各整宽条目
      //   各自成行、order 决定堆叠，auto 宽 + grow 的条目会挤到同一行破坏堆叠；纵排
      //   容器（issue #25）的 flex-basis 沿主轴=高度解析，grow: 1 会把按钮整高拉伸
      //   压住同槽按钮 → 同样保持 flex: 0 0 auto + width: 100%。
      const triggerStyle = {
        ...baseStyle,
        ...(iconOnly
          ? { flex: "0 0 auto", width: FOOTER_ICON_WIDTH + "px", minWidth: FOOTER_ICON_WIDTH + "px" }
          : mode === "share"
            ? { flex: "1 1 auto", width: "auto", minWidth: 0 }
            : { flex: "0 0 auto", width: "100%" }),
        whiteSpace: "nowrap",
      };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      if (!visible) return null;
      return React.createElement("button", {
        ref: buttonRef,
        style: triggerStyle, title: t("trigger.title"),
        "aria-label": t("trigger.label"),
        onClick: () => {
          // 打开「导入会话」右侧栏 tab：tab 在右栏内展开、对话区保留（接入侧栏接口
          // 而非覆盖主区）。openNativeImportTab 每次点击重证 sidebarRight 服务
          //（无挂载会话 / HMR 换服务时返回 false，本次点击无动作——依赖门槛保证
          // 受支持版本服务恒存在，无回落链）。
          openNativeImportTab();
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
        onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
      },
        React.createElement(LogoIcon, { size: iconOnly ? 18 : 16 }),
        !iconOnly && label,
        // 完整形态宽度镜像：绝对定位 + hidden，但仍参与布局计算——判定用的 needed
        // 取自它，因此与按钮当前形态无关（缩成图标后仍能算出「文字形态需要多宽」）。
        React.createElement("span", { ref: probeRef, "aria-hidden": true, style: FOOTER_PROBE_STYLE },
          React.createElement(LogoIcon, { size: 16 }),
          React.createElement("span", null, label)));
    }

    const name = "import-claude";
    // locale 是晚挂载服务（dsh-client-locale 自身依赖 connection/remote），声明进
    // inject 让 apply 期 ctx.get('locale') 就绪（面板 i18n + 字典注册）。sidebarRightTabs
    // 是官方原生右侧栏的 tab 注册服务（dsh ≥ 0.1.5-rc.1 恒有，peerDependencies 已抬
    // 门槛）：声明进 inject = 激活即服务就绪，右侧栏为硬依赖，无回落链。
    const inject = ["slots", "locale", "sidebarRightTabs"];

    function apply(ctx) {
      // 交给 settings.js 的传输层：0.1.7 的设置值走客户端 configForms，需要客户端 ctx。
      setClientHostCtx(ctx);
      // locale 服务（@deepseek-ai/dsh-client-locale）：已声明进 inject，apply 期就绪；
      // 注册面板字典并随 DSH web 语言切换（缺失时 useTranslate 降级内置 zh 字典）。
      const locale = ctx.get("locale");
      if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
        localeSvc = locale;
        ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }));
      }
      // 官方原生右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right，DSH ≥ 0.1.5-rc.1）是硬
      // 依赖：inject 声明 sidebarRightTabs + peerDependencies 抬门槛，apply 期服务必
      // 就绪——无回落链（better-sidebar 集成与自绘 ShellPanel 已随依赖抬升一并删除）。
      // 注册 tab 类型（id/kind = chat-import，title 供 chip 与 guide 标题）与 guide 胶囊
      //（图标 + 标题 + 描述）；面板主体走 sidebar.right.pane.tab 槽（session 作用域、
      // keyed by 类型 id）。该槽由 ui-sidebar-right 的 rightbar.session 条目声明，晚于
      // 本插件 apply 期 → slots.inject 挂到声明就绪时注册（时序机制，不是回落）。
      const tabs = ctx.get("sidebarRightTabs");
      const label = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("trigger.label") : (DICT.zh["trigger.label"] || "导入会话"));
      const guideDescription = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("sidebar.guide.description") : (DICT.zh["sidebar.guide.description"] || ""));
      ctx.effect(() => tabs.register({
        id: IMPORT_TAB_TYPE,
        kind: IMPORT_TAB_TYPE,
        title: label,
        guide: [{
          order: 20, // guide 页排在官方 Files（order 10）之后
          title: label,
          description: guideDescription,
          icon: ImportGlyph,
        }],
      }), "dsh-chat-import: 右侧栏 tab 类型注册");
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register(
          { name: "sidebar.right.pane.tab", key: IMPORT_TAB_TYPE },
          SidebarImportTab,
        ));
      // footer 按钮的右栏打开面：每次点击重证 sidebarRight 服务——无挂载会话、服务被
      // HMR 换掉等失败返回 false，本次点击无动作（依赖门槛保证受支持版本服务恒存在；
      // 参照 dsh-context 的 openContextSidebar；空 catch 吞掉的就是「本次打开」这一下，
      // 下一击重新尝试）。
      openNativeImportTab = () => {
        try {
          const face = ctx.get("sidebarRight");
          if (!face || typeof face.openTab !== "function") return false;
          face.openTab(IMPORT_TAB_TYPE);
          return true;
        } catch (_) {
          return false;
        }
      };
      // 裸 slots.register 要求槽在 apply 期已被 ui-sidebar 声明，advanced shell 下
      // 声明时序不保证先于本插件 -> fiber 抛错、renderer boot 判失败（白屏）。
      // slots.inject 挂起等声明就绪（官方 ui-cordis / dsh-community-market 同款）。
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "chat-import", order: 0 },
          ImportButton,
        ));
      // 设置席位按宿主世代分流（对齐 dsh-claude-style）：
      //   0.1.7+ —— 插件页 plugins.bundle.config（键 = 包名），由 ui-plugin-manager 声明，
      //             渲染在「设置 → 插件 → dsh-chat-import」；值走客户端 configForms。
      //   旧宿主 —— settings.section 整页（设置页左侧导航「每功能一页」）；值走 fenced
      //             路由 /api-import/prefs。
      // 两个 slots.inject 都是惰性的：槽被声明才触发（旧宿主不声明 plugins.bundle.config，
      // 新宿主仍声明 settings.section），再用 configForms 是否存在否决整页在新宿主上的
      // 重复注册——否则同一个设置会在两处各长一份。label 用 thunk 跟随语言切换。
      const settingsLabel = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("settings.tab") : (DICT.zh["settings.tab"] || "会话导入"));
      ctx.effect(
        () => registerSettingsNavIcon(settingsLabel),
        "dsh-chat-import: settings navigation icon",
      );
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: "dsh-chat-import", label: settingsLabel },
          ImportSettingsSection,
        ));
      ctx.slots.inject("settings.section", () => {
        if (hostConfigForms()) return undefined;
        return ctx.slots.register(
          { name: "settings.section", id: "chat-import", order: 21, label: settingsLabel, locale: LOCALE_NS, inject: () => ({}) },
          ImportSettingsSection,
        );
      });
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
})
