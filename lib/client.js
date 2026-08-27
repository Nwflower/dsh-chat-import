/* global window, document, fetch, getComputedStyle, MutationObserver, setTimeout, Worker, Blob */
// lib/client.js — dsh-chat-import 的 Browser 侧 bundle（手写 CJS factory，供 dsh web
// 客户端 ModuleLoader 注入）。REQ-41：侧边栏底部「导入会话」按钮 → 滑出面板。
// Stage 1：被动会话发现（POST /api-import/sessions，12 来源下拉）。
// Stage 2：按工作区文件夹（project）分组浏览 + 单选/多选导入（POST /api-import/import，
// 复用 host 工具层同一套导入编排——幂等/增量/force/预算语义与 import_* 工具一致）。
// Stage 3：搜索（query 服务端过滤标题/项目/路径）+ 分页（offset/limit，跨页多选保留）。
// i18n：面板文案注册到自有 ns "chat-import" 字典（zh/en 双语），经 @deepseek-ai/
// dsh-client-locale 的 LocaleRuntime 随 DSH web 语言设置切换；locale 服务缺失时
// 降级内置 zh 字典（保持原中文行为）。
// 纯前端：不 import 任何 DSH host 模块，只消费注入的 slots 服务、locale 服务与 react。
// 结构对齐同类生态插件 dsh-plugin-session-import（ModuleLoader.load + module.exports
// {name,inject,apply} + ctx.slots.register）。
window.__ModuleLoader__.load({
  id: "dsh-chat-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect } = React;

    // 面板文案字典（自有 ns "chat-import"；zh 为现状中文，en 为翻译）。
    // 查键链：chat-import → chat-import.zh → common → 键本身（locale 服务负责）。
    const LOCALE_NS = "chat-import";
    // 未分组桶的稳定键（排序钉最后；显示时经 t("ungrouped") 翻译）
    const UNGROUPED = "(未分组)";
    const DICT = {
      zh: {
        "trigger.title": "从其他工具导入会话（发现 + 单选/多选导入）",
        "trigger.label": "导入会话",
        "panel.title": "导入会话",
        "source": "来源",
        "allSources": "全部来源",
        "clearSearch": "清除",
        "search.placeholder": "搜索标题 / 工作区 / 路径…",
        "selectAll": "全选",
        "deselectAll": "取消全选",
        "clearSelection": "清空",
        "refresh": "刷新",
        "selected.count": "已选 {n}",
        "importing": "导入中…",
        "import.selected": "导入所选 ({n})",
        "status.imported": "已导入",
        "status.partial": "部分",
        "status.archived": "已归档",
        "status.notImported": "未导入",
        "noTitle": "(无标题)",
        "count.messages": "{n} 条",
        "count.sessions": "{n} 个会话",
        "timeUnknown": "时间未知",
        "noMatch": "没有匹配的会话",
        "noSessions": "没有找到会话",
        "loading": "加载中…",
        "scanning": "正在扫描… 已发现 {n} 个会话",
        "pagination": "第 {page} / {pages} 页 · 共 {total} 个",
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
        "result.appended": "续写 {n}",
        "result.already": "已存在 {n}",
        "result.skipped": "跳过 {n}",
        "result.failed": "失败 {n}",
        "result.separator": "，",
        "result.done": "导入完成：{bits}",
        "result.nochange": "无变化",
        "tab.import": "导入",
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
        "settings.systemPrompt.description": "把源会话的 system / developer 提示词作为「上下文注入」保留。默认关闭；开启后注入正文会附环境变更提示，工具、权限与执行指令以 DSH 当前会话为准。",
        "settings.tab": "会话导入",
      },
      en: {
        "trigger.title": "Import sessions from other tools (discover + single/multi select)",
        "trigger.label": "Import Sessions",
        "panel.title": "Import Sessions",
        "source": "Source",
        "allSources": "All sources",
        "clearSearch": "Clear",
        "search.placeholder": "Search title / workspace / path…",
        "selectAll": "Select all",
        "deselectAll": "Clear selection",
        "clearSelection": "Clear",
        "refresh": "Refresh",
        "selected.count": "{n} selected",
        "importing": "Importing…",
        "import.selected": "Import selected ({n})",
        "status.imported": "Imported",
        "status.partial": "Partial",
        "status.archived": "Archived",
        "status.notImported": "Not imported",
        "noTitle": "(untitled)",
        "count.messages": "{n} messages",
        "count.sessions": "{n} sessions",
        "timeUnknown": "Time unknown",
        "noMatch": "No matching sessions",
        "noSessions": "No sessions found",
        "loading": "Loading…",
        "scanning": "Scanning… {n} sessions found",
        "pagination": "Page {page} / {pages} · {total} total",
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
        "result.appended": "{n} appended",
        "result.already": "{n} already existed",
        "result.skipped": "{n} skipped",
        "result.failed": "{n} failed",
        "result.separator": ", ",
        "result.done": "Import done: {bits}",
        "result.nochange": "no change",
        "tab.import": "Import",
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
        "settings.systemPrompt.description": "Keep the source session's system/developer prompt as a \"context injection\". Off by default; when on, the injected body carries a note that the environment changed and tools, permissions, and instructions now follow DSH.",
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
      "", "claude-code", "codex", "chatgpt", "cursor", "gemini", "reasonix",
      "opencode", "mimocode", "zcode", "grokbuild", "openclaw", "pi", "hermes", "kimi", "qoder", "workbuddy", "dsh",
    ];
    // discovery format 短名 → 客户端来源 id（构建 /api-import/import 的 items）。
    const FORMAT_SOURCE = {
      claude: "claude-code", codex: "codex", chatgpt: "chatgpt", cursor: "cursor",
      gemini: "gemini", reasonix: "reasonix", opencode: "opencode", mimocode: "mimocode", zcode: "zcode",
      grokbuild: "grokbuild", openclaw: "openclaw", pi: "pi", hermes: "hermes",
      kimi: "kimi", qoder: "qoder", workbuddy: "workbuddy", dsh: "dsh",
    };
    // 分页大小：流式加载下为客户端窗口大小（累计缓冲切片，翻页零重扫、瞬时完成）
    const PAGE_SIZE = 50;
    // 时间倒序比较（对齐服务端 discoverSessions 的 lastActiveAt 降序）：
    // 流式期间缓冲按发现顺序纯追加（行不跳动、页面稳定），扫描完成时一次性重排
    //（单次排序事件之后恒定——不做每块全量重排，巨库加载不再占主线程）
    const byTimeDesc = (a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0);

    // 滑入动画（一次性注入，幂等防重复）
    if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-import-slide]")) {
      const tag = document.createElement("style");
      tag.dataset.dshImportSlide = "1";
      tag.textContent = "@keyframes dsh-import-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }";
      document.head.appendChild(tag);
    }

    // 明暗主题自适应（对齐同类生态插件：body 的 data-ds-dark-theme 属性判定）
    const isDark = () => typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme");
    const themeColors = () => (isDark()
      ? { bg: "#1b1f27", border: "#2a3040", field: "#14181f", text: "#e4e8ee", dim: "#9aa3b2", dimmer: "#7a8394", accent: "#4f8cff", hover: "#1f2530" }
      : { bg: "#ffffff", border: "#d8dee6", field: "#f5f6f8", text: "#1f2328", dim: "#57606a", dimmer: "#6e7781", accent: "#0969da", hover: "#eef1f5" });

    const makeStyles = (C) => ({
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998, display: "flex", justifyContent: "flex-end" },
      panel: {
        // top 让出桌面端原生标题栏高度（Windows 窗口控制按钮 —□✕ 约 40px，
        // 原生层恒在页面之上），否则面板头的 ✕ 与窗口 ✕ 重叠且点不到。
        position: "fixed", top: "40px", right: 0, bottom: 0, width: "460px", maxWidth: "94vw",
        background: C.bg, borderLeft: "1px solid " + C.border, color: C.text,
        font: "13px/1.6 system-ui, sans-serif", zIndex: 9999, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        animation: "dsh-import-slide-in .18s ease-out",
      },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid " + C.border },
      title: { fontSize: "14px", fontWeight: 600 },
      close: { background: "transparent", border: "none", color: C.dim, fontSize: "16px", cursor: "pointer", padding: "2px 6px", borderRadius: "4px" },
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border },
      label: { color: C.dim, flex: "none" },
      select: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "6px 8px", fontSize: "13px", outline: "none",
      },
      // 搜索行：输入 + 搜索/清除（query 服务端过滤标题/项目/路径）
      searchRow: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      searchInput: {
        flex: "1", minWidth: "0", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "5px 8px", fontSize: "12.5px", outline: "none",
      },
      searchBtn: {
        flex: "none", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "5px 12px", fontSize: "12.5px", cursor: "pointer",
      },
      // 工具栏：全选 / 清空 / 刷新 + 已选计数
      toolbar: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      toolBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer",
      },
      count: { marginLeft: "auto", color: C.dimmer, fontSize: "12px", flex: "none" },
      // 导入操作条：多选导入主按钮 + 结果摘要
      importBar: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      primaryBtn: {
        flex: "1", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "7px 10px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer",
      },
      result: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderBottom: "1px solid " + C.border, background: C.field },
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "8px" },
      // 工作区文件夹分组头
      group: {
        display: "flex", alignItems: "center", gap: "6px", padding: "8px 10px 4px",
        fontSize: "12px", fontWeight: 600, color: C.dim, position: "sticky", top: 0,
        background: C.bg, zIndex: 1,
      },
      groupCount: { marginLeft: "auto", fontSize: "11px", fontWeight: 400, color: C.dimmer },
      item: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 10px", borderRadius: "6px", marginBottom: "2px" },
      checkbox: { marginTop: "3px", flex: "none", accentColor: C.accent, cursor: "pointer" },
      itemMain: { flex: "1", minWidth: "0" },
      itemTitle: { fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      itemMeta: { color: C.dimmer, fontSize: "11px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      fmt: { fontSize: "10px", padding: "0 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      badge: { marginLeft: "auto", fontSize: "10px", padding: "1px 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      git: { fontSize: "10px", padding: "0 6px", borderRadius: "8px", border: "1px dashed " + C.border, color: C.dim, flex: "none" },
      importBtn: {
        flex: "none", background: C.accent, color: "#ffffff", border: "none", borderRadius: "6px",
        padding: "3px 10px", fontSize: "11.5px", cursor: "pointer", marginTop: "2px",
      },
      importedTag: { flex: "none", fontSize: "11px", color: "#1a7f37", marginTop: "2px", whiteSpace: "nowrap" },
      syncBtn: {
        flex: "none", background: "transparent", color: C.dim, border: "1px solid " + C.border,
        borderRadius: "6px", padding: "2px 8px", fontSize: "11px", cursor: "pointer", marginTop: "2px",
      },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      scanning: { padding: "8px 12px", color: C.dimmer, fontSize: "12px" },
      error: { padding: "16px", textAlign: "center", color: "#cf222e" },
      // 分页条：上一页 / 页码 / 下一页
      pageBar: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", padding: "8px 12px", borderTop: "1px solid " + C.border },
      pageBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "6px", padding: "4px 12px", fontSize: "12px", cursor: "pointer",
      },
      pageInfo: { color: C.dimmer, fontSize: "12px" },
    });

    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    const statusLabel = (st, t) => (st === "imported" ? t("status.imported") : st === "partial" ? t("status.partial") : st === "archived" ? t("status.archived") : t("status.notImported"));
    const statusColor = (st, colors) => (st === "imported" ? "#1a7f37" : st === "partial" ? "#9a6700" : st === "archived" ? "#8250df" : colors.dimmer);

    // 会话条目唯一键（format + sourcePath + sessionId；\u0000 不在路径中出现）
    const itemKey = (s) => s.format + "\u0000" + s.sourcePath + "\u0000" + s.sessionId;
    // 条目 → /api-import/import 的 items 项（client 来源 id + sourcePath + sessionId）
    const toItem = (s) => ({ source: FORMAT_SOURCE[s.format] || s.format, sourcePath: s.sourcePath, sessionId: s.sessionId });

    // 批量结果摘要（single/batch 混合计数；t 为 useTranslate 返回的翻译函数）
    function fmtImportResult(results, t) {
      const c = { imported: 0, already: 0, appended: 0, skipped: 0, failed: 0 };
      for (const r of results || []) {
        if (r.status === "failed") { c.failed++; continue; }
        if (r.mode === "batch") {
          c.imported += r.imported || 0;
          c.already += r.alreadyImported || 0;
          c.appended += r.appended || 0;
          c.skipped += r.skipped || 0;
          c.failed += r.failed || 0;
        } else if (r.status === "imported") c.imported++;
        else if (r.status === "already-imported") c.already++;
        else if (r.status === "appended") c.appended++;
        else c.skipped++;
      }
      const bits = [];
      if (c.imported) bits.push(t("result.imported", { n: c.imported }));
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
          borderRadius: "50%", background: "#fff", transition: "left .12s ease",
        },
      }));
    }

    // 设置页「会话导入」分区（settings.section 槽 = 设置页左侧导航的「每功能一页」；
    // 宿主留给插件设置页的正确 Hook；settings.plugins.tab 只是「插件」分区内的子页，
    // 非插件设置入口）。开关值经面板 fenced 路由 /api-import/prefs 读写——DSH 配置
    // 客户端（settingsScope）只能访问 api-proxy 暴露白名单内的命名空间，插件自有
    // chat-import 不在其列（对齐 dsh-better-sidebar 的 settingsGet/settingsUpdate
    // 模式）；settings 服务缺席或路由失败时回退默认并显示错误行，分区照常渲染。
    function ImportSettingsSection() {
      const t = useTranslate();
      const colors = themeColors();
      const [state, setState] = useState({ on: false, saving: false, error: null });
      const load = () => {
        fetch("/api-import/prefs", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        })
          .then((resp) => readJson(resp))
          .then((data) => {
            if (data && data.ok === true) {
              setState((s) => ({ ...s, on: !!(data.value && data.value.importSystemPrompt), error: null }));
            } else {
              setState((s) => ({ ...s, error: (data && data.error) || t("error.load") }));
            }
          })
          .catch((err) => setState((s) => ({ ...s, error: "导入偏好读取失败：" + String((err && err.message) || err) })));
      };
      useEffect(() => { load(); }, []);
      const applyPref = (next) => {
        setState((s) => ({ ...s, saving: true, error: null }));
        fetch("/api-import/prefs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ importSystemPrompt: next }),
        })
          .then((resp) => readJson(resp))
          .then((data) => {
            if (data && data.ok === true) {
              setState((s) => ({ ...s, on: next, saving: false }));
            } else {
              // 写失败（含 settings-conflict）：显示错误并重读服务端权威值
              setState((s) => ({ ...s, saving: false, error: (data && data.error) || t("error.route") }));
              load();
            }
          })
          .catch(() => { setState((s) => ({ ...s, saving: false, error: t("error.route") })); });
      };
      return React.createElement("div", { style: { padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "640px" } },
        React.createElement("div", { style: { fontSize: "15px", fontWeight: 600, color: colors.text } }, t("settings.tab")),
        React.createElement("div", {
          style: {
            display: "flex", alignItems: "flex-start", gap: "12px",
            padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "10px",
          },
        },
          React.createElement("div", { style: { flex: "1", minWidth: "0" } },
            React.createElement("div", { style: { fontSize: "13px", color: colors.text, lineHeight: "1.5", fontWeight: 600 } }, t("settings.systemPrompt.title")),
            React.createElement("div", { style: { fontSize: "12px", color: colors.dimmer, marginTop: "4px", lineHeight: "1.5" } }, t("settings.systemPrompt.description"))),
          React.createElement(Toggle, { on: state.on, colors, onChange: (next) => { if (!state.saving) applyPref(next); } })),
        state.error && React.createElement("div", { style: { fontSize: "12px", color: "#cf222e" } }, state.error),
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
          key: f, style: { display: "flex", gap: "6px", alignItems: "center", cursor: "pointer", color: colors.text, fontSize: "12.5px" },
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
            border: "1px solid " + colors.border, color: colors.text, borderRadius: "6px",
            padding: "6px 8px", fontSize: "12.5px", outline: "none",
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
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "10px",
        },
      },
        React.createElement("div", { style: { flex: "1", minWidth: "0" } },
          React.createElement("div", { style: { fontSize: "13px", color: colors.text, lineHeight: "1.5", fontWeight: 600 } }, title),
          React.createElement("div", { style: { fontSize: "12px", color: colors.dimmer, marginTop: "4px", lineHeight: "1.5" } }, hint)),
        control);
      const groupCard = (children) => React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", gap: "10px",
          padding: "12px 14px", border: "1px solid " + colors.border, borderRadius: "10px",
        },
      }, children);
      const numInput = {
        width: "90px", background: colors.field, border: "1px solid " + colors.border, color: colors.text,
        borderRadius: "6px", padding: "5px 8px", fontSize: "12.5px", outline: "none",
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
              background: colors.accent, color: "#ffffff", border: "none", borderRadius: "6px",
              padding: "7px 18px", fontSize: "12.5px", fontWeight: 600, cursor: "pointer",
              opacity: busy ? 0.55 : 1,
            },
            disabled: busy, onClick: runNow,
          }, busy ? t("sync.running") : t("sync.run")),
          React.createElement("span", { style: { fontSize: "12px", color: colors.dimmer } }, last ? t("sync.last", { when: last }) : t("sync.never"))),
        note && React.createElement("div", { style: { fontSize: "12px", color: colors.dim } }, note),
        error && React.createElement("div", { style: { fontSize: "12px", color: "#cf222e" } }, error));
    }

    function ShellPanel({ onClose }) {
      const t = useTranslate();
      const colors = themeColors();
      const style = makeStyles(colors);
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      return React.createElement("div", { style: style.overlay, onClick: onClose },
        React.createElement("div", { style: style.panel, onClick: (e) => e.stopPropagation() },
          React.createElement("div", { style: style.header },
            React.createElement("span", { style: style.title }, t("panel.title")),
            React.createElement("button", { style: style.close, onClick: onClose, title: t("close") }, "✕")),
          React.createElement(DiscoveryPanel, { onClose, embedded: true })));
    }

    /** 发现 + 导入面板：来源过滤 + 按工作区文件夹分组 + 单选/多选导入 */
    function DiscoveryPanel({ onClose, embedded }) {
      const t = useTranslate();
      const colors = themeColors();
      const style = makeStyles(colors);
      const [source, setSource] = useState(SOURCES[0]);
      const [items, setItems] = useState([]); // 流式累计缓冲（scan 逐条按发现顺序插入）
      const [stream, setStream] = useState({ done: false, cursor: 0, total: 0, started: false });
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(new Map()); // key → 会话条目
      const [importing, setImporting] = useState(false);
      const [result, setResult] = useState(null);
      const [epoch, setEpoch] = useState(0); // 刷新 / 导入后自增 → 服务端新扫描键
      const [queryInput, setQueryInput] = useState(""); // 搜索框输入（未提交）
      const [query, setQuery] = useState(""); // 已提交的搜索词（请求用）
      const [page, setPage] = useState(0); // 当前页（0 基）
      const [collapsed, setCollapsed] = useState(new Set()); // 已折叠的工作区分组名

      // 流式加载：后台扫描 + after 游标轮询——会话按发现顺序逐条 append 到缓冲，
      // 首屏不被全量扫描阻塞；每次请求只取 cursor 之后的增量（服务端 seq 去重）。
      useEffect(() => {
        let cancelled = false;
        (async () => {
          setItems([]);
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
            const batch = Array.isArray(data.sessions) ? data.sessions : [];
            if (batch.length > 0) {
              // 流式期间纯追加（发现顺序，行不跳动、页面稳定）；扫描完成时一次性
              // 重排回时间倒序（单次排序事件，之后恒定）——不做每块全量重排
              setItems((prev) => (done ? prev.concat(batch).sort(byTimeDesc) : prev.concat(batch)));
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

      // 来源/搜索词变化 → 清空跨页选择（换页/刷新保留选择，支持跨页多选）
      useEffect(() => { setSelected(new Map()); }, [source, query]);

      // Esc 关闭面板（全屏 overlay 打开时会挡住页面其它操作，必须可键盘退出）
      useEffect(() => {
        if (embedded) return undefined;
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose, embedded]);

      // 执行导入（单选/多选共用）：POST /api-import/import → 摘要 → 重取列表刷新状态
      const doImport = async (items) => {
        if (!items || items.length === 0 || importing) return;
        setImporting(true);
        setResult(null);
        try {
          const resp = await fetch("/api-import/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setResult(fmtImportResult(data.results, t));
            setSelected(new Map());
            setEpoch((n) => n + 1);
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

      const toggle = (s) => {
        const key = itemKey(s);
        setSelected((prev) => {
          const next = new Map(prev);
          if (next.has(key)) next.delete(key);
          else next.set(key, s);
          return next;
        });
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
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      // 当前页窗口 = 累计缓冲切片（服务端不再分页；翻页零重扫、瞬时完成）
      const sessions = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      // 分页文案总数：扫描完成后用服务端 total（过滤后总数）；扫描中显示已发现数
      const displayTotal = stream.done ? stream.total : items.length;

      // 组内最新会话的最后编辑时间（组排序键：最近活跃的工作区置顶）
      const groupLatest = (list) => list.reduce((m, s) => Math.max(m, s.lastActiveAt ?? s.createdAt ?? 0), 0);
      // 按工作区文件夹（project）分组：组按组内最新会话的最后编辑时间降序（最近活跃
      // 的工作区置顶，时间并列按工作区名升序稳定），组内按最后编辑时间降序；未分组钉最后
      const groups = [];
      if (sessions && sessions.length > 0) {
        const byProject = new Map();
        for (const s of sessions) {
          const key = s.project || UNGROUPED;
          if (!byProject.has(key)) byProject.set(key, []);
          byProject.get(key).push(s);
        }
        const names = [...byProject.keys()].sort((a, b) => {
          if (a === UNGROUPED) return 1;
          if (b === UNGROUPED) return -1;
          return (groupLatest(byProject.get(b)) - groupLatest(byProject.get(a))) || a.localeCompare(b);
        });
        for (const name of names) groups.push({ name, list: [...byProject.get(name)].sort(byTimeDesc) });
      }

      const allSelected = sessions && sessions.length > 0 && sessions.every((s) => selected.has(itemKey(s)));

      const renderGroup = (group) => {
        const isCollapsed = collapsed.has(group.name);
        const toggleGroup = () => {
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(group.name)) next.delete(group.name);
            else next.add(group.name);
            return next;
          });
        };
        const rows = isCollapsed ? [] : group.list.map((s) => {
          const key = itemKey(s);
          const checked = selected.has(key);
          const ts = s.lastActiveAt || s.createdAt;
          const badgeColor = statusColor(s.importStatus, colors);
          const imported = s.importStatus === "imported";
          return React.createElement("div", {
            key,
            style: style.item,
            onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
          },
            React.createElement("input", {
              type: "checkbox", style: style.checkbox, checked,
              onChange: () => toggle(s), disabled: importing, title: t("multiSelect.title"),
            }),
            React.createElement("div", { style: style.itemMain },
              React.createElement("div", { style: style.itemTitle }, s.title || t("noTitle")),
              React.createElement("div", { style: style.itemMeta },
                React.createElement("span", { style: style.fmt }, s.format),
                React.createElement("span", null, t("count.messages", { n: typeof s.messageCount === "number" ? s.messageCount : "—" })),
                ...(s.gitBranch ? [React.createElement("span", { style: style.git }, s.gitBranch + (s.gitDirty ? " ✗" : ""))] : []),
                React.createElement("span", null, fmtTime(ts) || t("timeUnknown")),
                React.createElement("span", { style: { ...style.badge, color: badgeColor, borderColor: badgeColor } }, statusLabel(s.importStatus, t)))),
            imported
              ? React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                React.createElement("span", { style: style.importedTag }, t("status.imported")),
                React.createElement("button", {
                  style: style.syncBtn, disabled: importing,
                  onClick: () => doImport([toItem(s)]),
                  title: t("sync.title"),
                }, t("sync")))
              : React.createElement("button", {
                style: style.importBtn, disabled: importing,
                onClick: () => doImport([toItem(s)]),
                title: t("import.one.title"),
              }, t("import.one")));
        });
        return React.createElement(React.Fragment, { key: group.name },
          React.createElement("div", {
            style: style.group, onClick: toggleGroup, title: isCollapsed ? t("group.expand") : t("group.collapse"),
          },
            React.createElement("span", { style: { flex: "none" } }, isCollapsed ? "▸" : "▾"),
            React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, group.name === UNGROUPED ? t("ungrouped") : group.name),
            React.createElement("span", { style: style.groupCount }, t("count.sessions", { n: group.list.length }))),
          rows);
      };

      const body = React.createElement(React.Fragment, null,
          React.createElement("div", { style: style.row },
            React.createElement("span", { style: style.label }, t("source")),
            React.createElement("select", {
              style: style.select, value: source,
              onChange: (e) => { setSource(e.target.value); setPage(0); setQuery(""); setQueryInput(""); },
            },
              SOURCES.map((s) => React.createElement("option", { key: s, value: s }, s ? s : t("allSources"))))),
          React.createElement("div", { style: style.searchRow },
            React.createElement("input", {
              style: style.searchInput, value: queryInput, placeholder: t("search.placeholder"),
              onChange: (e) => setQueryInput(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") applySearch(); },
            }),
            React.createElement("button", { style: style.searchBtn, onClick: applySearch }, t("search")),
            React.createElement("button", { style: style.toolBtn, onClick: clearSearch, disabled: (!queryInput && !query) || importing }, t("clearSearch"))),
          React.createElement("div", { style: style.toolbar },
            React.createElement("button", { style: style.toolBtn, onClick: toggleAll, disabled: items.length === 0 || importing }, allSelected ? t("deselectAll") : t("selectAll")),
            React.createElement("button", { style: style.toolBtn, onClick: () => setSelected(new Map()), disabled: selected.size === 0 || importing }, t("clearSelection")),
            React.createElement("button", { style: style.toolBtn, onClick: () => setEpoch((n) => n + 1), disabled: importing }, t("refresh")),
            React.createElement("span", { style: style.count }, t("selected.count", { n: selected.size }))),
          React.createElement("div", { style: style.importBar },
            React.createElement("button", {
              style: { ...style.primaryBtn, opacity: selected.size === 0 || importing ? 0.55 : 1 },
              disabled: selected.size === 0 || importing,
              onClick: () => doImport([...selected.values()].map(toItem)),
            }, importing ? t("importing") : t("import.selected", { n: selected.size }))),
          result && React.createElement("div", { style: style.result }, result),
          !stream.started && !error && React.createElement("div", { style: style.status }, t("loading")),
          error && React.createElement("div", { style: style.error }, error),
          stream.started && !stream.done && !error && items.length > 0
            && React.createElement("div", { style: style.scanning }, t("scanning", { n: items.length })),
          stream.done && !error && items.length === 0 && React.createElement("div", { style: style.status }, query ? t("noMatch") : t("noSessions")),
          !error && items.length > 0
            && React.createElement("div", { style: style.list }, groups.map(renderGroup)),
          totalPages > 1 && React.createElement("div", { style: style.pageBar },
            React.createElement("button", { style: style.pageBtn, disabled: page === 0 || importing, onClick: () => setPage((p) => Math.max(0, p - 1)) }, t("previous")),
            React.createElement("span", { style: style.pageInfo }, t("pagination", { page: page + 1, pages: totalPages, total: displayTotal })),
            React.createElement("button", { style: style.pageBtn, disabled: page >= totalPages - 1 || importing, onClick: () => setPage((p) => Math.min(totalPages - 1, p + 1)) }, t("next"))));
      if (embedded) {
        return React.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } }, body);
      }
      return React.createElement("div", { style: style.overlay, onClick: onClose },
        React.createElement("div", { style: style.panel, onClick: (e) => e.stopPropagation() },
          React.createElement("div", { style: style.header },
            React.createElement("span", { style: style.title }, t("panel.title")),
            React.createElement("button", { style: style.close, onClick: onClose, title: t("close") }, "✕")),
          body));
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

    /** 触发按钮：两种布局模式自适应。
     * 1) 槽容器已被其它插件（如 dsh-tokenledger）注入 flex-wrap:wrap → 落回
     *    行内独占一行，order 决定堆叠（tokenledger -10 / 本按钮 0 / 插件市场
     *    10），无任何浮层；
     * 2) 容器 nowrap 且行内出现整行占用者（官方 cordis 徽标 / 内置插件市场
     *    launcher）→ fixed 浮动（脱离 footer.action 行布局），锚定到占用者
     *    正上方独占一行、左缘与宽度对齐，形成并行两行；无占用者时落回行内。
     * footerActions 默认是不换行的 256px flex 行；cordis 徽标 `flex:0 0 auto;
     * width:256px`、市场 launcher `flex:none; width:calc(100% + 4px)` 均不可
     * 收缩、占满整行，nowrap 时会把同槽其它条目挤出容器并被侧边栏
     * overflow:hidden 裁剪、或挤成竖排窄条（实测）。fixed + z-index 1（与侧
     * 边栏内容同层，低于一切弹层/遮罩——第三方插件弹层 30/40、shell 弹层
     * 100、市场/设置模态 1000）让 footer occupant 挡不住、任何弹出框体打开
     * 时都被自然盖住（压暗且点击被拦截）；样式对齐设置按钮（透明底、12px
     * 圆角、16px 图标 + 文字、悬停浅底），图标用插件 logo；rail（wide=false）
     * 态只显图标。
     */
    /** 检测 footer 行内的「整行占用者」：官方 cordis 徽标（[data-cordis-badge]，
     * `flex:none; width:256px`）与内置插件市场 launcher（.dshMarketLauncher，
     * `flex:none; width:calc(100% + 4px)`）都会占满不换行的 footer flex 行，
     * 把同槽其它条目挤成窄条/竖排文字。返回最靠上的一个可见占用者的视口坐标
     * （{top,left,width,height}），无则 null —— 用于把本按钮浮到其上方独占
     * 一行、左缘与宽度对齐，与占用者形成并行两行布局。 */
    const footerOccupantRect = () => {
      if (typeof document === "undefined") return null;
      let best = null;
      for (const sel of ["[data-cordis-badge]", ".dshMarketLauncher"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (!best || r.top < best.top) best = { top: r.top, left: r.left, width: r.width, height: r.height };
      }
      return best;
    };

    /** 槽容器是否已被其它插件（如 dsh-tokenledger）注入 flex-wrap:wrap：
     * wrap 时整行宽条目各自成行（order 决定上下顺序），本按钮落回行内即
     * 可、无需浮层。经 data-slot 锚点的父元素判定，不依赖 CSS-module 哈希类。 */
    const footerWraps = () => {
      if (typeof document === "undefined") return false;
      const marker = document.querySelector("[data-slot='sidebar.footer.action']");
      if (!marker || !marker.parentElement) return false;
      return getComputedStyle(marker.parentElement).flexWrap === "wrap";
    };

    function ImportButton({ wide }) {
      const t = useTranslate();
      const [open, setOpen] = useState(false);
      const rail = wide === false;
      // 槽容器已 wrap（tokenledger 等插件注入 flex-wrap）→ 落回行内独占一行，
      // order 决定上下（tokenledger -10 / 本按钮 0 / 插件市场 10）；
      // nowrap 且有整行占用者（cordis 徽标 / 插件市场 launcher）→ fixed 浮层
      // 独占一行，锚定到占用者正上方、左缘与宽度与之对齐；
      // nowrap 且无占用者 → 行内全宽条目。MutationObserver（观察根元素，含
      // head 里样式表的增删）+ resize 跟踪占用者与 wrap 状态变化；状态更新做
      // 等值比较防止观察自身 DOM 变化造成重渲染循环。
      const [wraps, setWraps] = useState(() => footerWraps());
      const [anchor, setAnchor] = useState(() => footerOccupantRect());
      useEffect(() => {
        const check = () => {
          setWraps(footerWraps());
          const next = footerOccupantRect();
          setAnchor((prev) => {
            if (!prev && !next) return prev;
            if (prev && next && prev.top === next.top && prev.left === next.left
              && prev.width === next.width && prev.height === next.height) return prev;
            return next;
          });
        };
        check();
        const mo = new MutationObserver(check);
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["data-cordis-badge", "style", "class"],
        });
        window.addEventListener("resize", check);
        return () => { mo.disconnect(); window.removeEventListener("resize", check); };
      }, []);
      const floating = !wraps && !!anchor;
      // 视觉逐项对齐侧边栏「设置」按钮（实测基准）：行高 22px、内边距
      // 6px 2px 6px 10px、gap 8px、圆角 12px、16×16 图标；颜色/悬停用侧边栏同一
      // CSS 变量（--dsw-alias-label-primary / interactive-bg-hover），明暗主题下与
      // 设置按钮完全一致。rail（wide=false）态对齐同列图标按钮（设置/用量）：
      // 36×36、justify-content 居中、圆角 50% 圆形、单图标无内边距。
      const baseStyle = {
        boxSizing: "border-box",
        display: "flex", alignItems: "center",
        justifyContent: rail ? "center" : undefined,
        gap: rail ? "0" : "8px",
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary)",
        borderRadius: rail ? "50%" : "12px", padding: rail ? "0" : "6px 2px 6px 10px",
        fontSize: "14px", lineHeight: "22px", fontWeight: 400,
        cursor: "pointer",
      };
      const triggerStyle = floating
        ? {
          ...baseStyle, position: "fixed",
          left: Math.round(anchor.left) + "px",
          bottom: Math.round(window.innerHeight - anchor.top + 6) + "px",
          // 层级 1：与侧边栏普通内容同层，低于一切弹层/遮罩（第三方插件
          // 弹层 30/40、shell 弹层 100、插件市场/设置模态 1000）。任何弹出
          // 框体打开时都自然盖住本按钮——压暗且点击被遮罩拦截，与其余 UI
          // 行为一致；不能用高 z-index 浮在弹层上。
          zIndex: 1,
          width: rail ? "36px" : Math.round(anchor.width) + "px",
          height: rail ? "36px" : "34px",
          whiteSpace: "nowrap",
        }
        : {
          // flex-basis 不能写成 100%（row 容器=全宽可，flex-direction: column
          // 容器如 dsh-usage-stats 强制纵排时沿主轴=整高撑满 footer 并压住同槽
          // 其它按钮，issue #25）：flex: 0 0 auto + width: 100% 在 row/column/
          // wrap 三种容器下都只占全宽、高度随内容；rail 态固定 36×36 圆钮。
          ...baseStyle, flex: "0 0 auto",
          width: rail ? "36px" : "100%",
          height: rail ? "36px" : undefined,
          minHeight: rail ? undefined : "34px",
          whiteSpace: "nowrap",
        };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      // 按钮常显：面板打开时全屏遮罩（z 9998）盖在内容层按钮之上，无需卸载；
      // 行内布局下卸载会让整行消失、footer 堆叠跳动（早期 z-index 10000 时代
      // 按钮会浮在自己的面板上才卸载，层级降到 1 后该保护已多余）。
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          style: triggerStyle, title: t("trigger.title"),
          "aria-label": t("trigger.label"),
          onClick: () => setOpen(true),
          onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        },
          React.createElement(LogoIcon, { size: 16 }),
          !rail && t("trigger.label")),
        open && React.createElement(ShellPanel, { onClose: () => setOpen(false) }));
    }

    const name = "import-claude";
    // locale 是晚挂载服务（dsh-client-locale 自身依赖 connection/remote），
    // 声明进 inject 让 apply 期 ctx.get('locale') 就绪（面板 i18n + 字典注册）。
    const inject = ["slots", "locale"];

    function apply(ctx) {
      // locale 服务（@deepseek-ai/dsh-client-locale）：已声明进 inject，apply 期就绪；
      // 注册面板字典并随 DSH web 语言切换（缺失时 useTranslate 降级内置 zh 字典）。
      const locale = ctx.get("locale");
      if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
        localeSvc = locale;
        ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }));
      }
      // 裸 slots.register 要求槽在 apply 期已被 ui-sidebar 声明，advanced shell 下
      // 声明时序不保证先于本插件 -> fiber 抛错、renderer boot 判失败（白屏）。
      // slots.inject 挂起等声明就绪（官方 ui-cordis / dsh-community-market 同款）。
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "chat-import", order: 0 },
          ImportButton,
        ));
      // 设置页「会话导入」分区：settings.section 槽（设置页左侧导航的「每功能一页」）
      // 承载「导入系统提示词」开关（默认关）——宿主留给插件设置页的正确 Hook
      //（settings.plugins.tab 是「插件」分区内部的子页，非插件设置入口）。开关值经
      // 面板 fenced 路由 /api-import/prefs 读写（DSH 配置客户端 settingsScope 只
      // 服务暴露白名单命名空间，插件自有 chat-import 不在其列——对齐
      // dsh-better-sidebar 的 settingsGet/settingsUpdate 模式）。该槽由
      // ui-settings-general 声明，晚于本插件 apply 期；slots.inject 惰性挂到槽被
      // 声明时，无设置页的 profile 则回调永不执行、不报错。label 用 thunk 跟随
      // 语言切换（同 agent-presets / plugins 等官方分区写法）。
      ctx.slots.inject("settings.section", () => {
        const t = localeSvc ? localeSvc.bind(LOCALE_NS) : (key) => DICT.zh[key] || key;
        return ctx.slots.register(
          { name: "settings.section", id: "chat-import", order: 21, label: () => t("settings.tab"), locale: LOCALE_NS, inject: () => ({}) },
          ImportSettingsSection,
        );
      });
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
