    // 「从文件导入」折叠区（ImportTabContent 导入子视图顶部，默认展开）：三条给文件的路径——
    // 拖放 / 选择文件走上传通道（浏览器拿不到本地路径）、路径输入 + 「浏览…」面板内浏览器、
    // 粘贴路径回车预览——外加格式覆盖、预览卡片与目录批处理。
    //
    // 后端契约（lib/panel.mjs）：
    //   POST /api-import/file   { path? | uploadId?, preview }：preview=true 零
    //                          副作用（识别 + 规模 + 降级计数），false 走导入编排；目录 → batch。
    //   POST /api-import/browse { mode: info | pick | list }：native 后端弹宿主系统框，
    //                          browse / fs 后端给一层目录清单（crumbs + entries）。
    //   POST /api-import/upload/{init,chunk,complete}：同 (sha256,size) 幂等；分片只追加、
    //                          offset 必须对齐（细节见 lib/upload.mjs 文件头）。
    //
    // 片段契约：本文件是 bundle 的一个片段，禁 import/export；前面片段声明的 useTranslate /
    // themeColors / SearchableSelect / readJson / showAppToast / fmtImportResult 直接用。
    // 子文件夹询问用的宿主 UI 预设组件（@deepseek-ai/dsh-client-ui-primitives 的 Modal /
    // Button）：与导入落点 Toast（src/client/toast.js）同一条 require 通道，旧宿主缺该包
    // 或换 API 时退回面板自绘弹层——一句询问不值得把面板拖垮（例外记在 architecture D17）。
    let HostModal = null;
    let HostButton = null;
    try {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      HostModal = primitives && typeof primitives.Modal === "function" ? primitives.Modal : null;
      HostButton = primitives && typeof primitives.Button === "function" ? primitives.Button : null;
    } catch {
      // 旧宿主没有该包：保持 null，renderSubfolderDialog 走自绘兜底
      HostModal = null;
      HostButton = null;
    }

    // 识别失败时指给用户的「Skill」：interchange 转换指南（Agent 用，双语）。URL 按界面
    // 语言走 i18n 键 fileImport.failures.guideUrl（zh → .zh-CN.md，en → .md），不写死常量。
    const FILE_AREA_COLLAPSED_KEY = "chat-import.fileArea.collapsed";
    const FILE_AREA_ID = "chat-import-file-area";
    const FILE_FAILURES_ID = "chat-import-file-failures";
    // 目录批处理的渲染步进：一次最多放 200 行，其余交给「显示更多」（与列表窗口化同思路）
    const FILE_BATCH_PAGE = 200;
    // 分片下限：服务端起始 640KB，413 逐次减半；减到这里仍被拒就报错，不静默丢文件
    const UPLOAD_MIN_CHUNK = 64 * 1024;
    // 面板只做「自动识别 → 导入为 DSH 会话」：格式覆盖与「导入到」（转投）是低频的
    // 精确控制，留在工具 / 命令面（import_chat 的 parseFormat / target），面板不摆按钮。
    // 降级计数 → 文案键：>0 才显示（键与 lib/file-import.mjs 的预览条目同口径）
    const FILE_DEGRADE_KEYS = [
      ["imagesDegraded", "fileImport.degraded.images"],
      ["skippedBlocks", "fileImport.degraded.blocks"],
      ["malformedTurns", "fileImport.degraded.malformedTurns"],
      ["malformedSteps", "fileImport.degraded.malformedSteps"],
      ["droppedToolResults", "fileImport.degraded.toolResults"],
      ["usageDropped", "fileImport.degraded.usage"],
      ["secrets", "fileImport.degraded.secrets"],
    ];
    // detectedBy 的已知依据（后端取值：override / marker / path-hint / content）
    const FILE_DETECTED_BY = { override: true, marker: true, "path-hint": true, content: true };
    // 目录分隔符（\ 与 /）：写成一个字符，避免片段里出现反斜杠转义
    const FILE_PATH_SEP = String.fromCharCode(92);

    /** 折叠区样式：与面板其余部分同一套设计令牌（themeColors；不新建设计变量）。 */
    const fileImportStyles = (C) => ({
      root: { flex: "none", display: "flex", flexDirection: "column", borderBottom: "1px solid " + C.border },
      head: {
        display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "8px 12px",
        background: "transparent", border: "none", color: C.text, font: "inherit", fontSize: "13px",
        fontWeight: 600, cursor: "pointer", textAlign: "left", boxSizing: "border-box",
      },
      headTitle: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      headChevron: { display: "inline-flex", alignItems: "center", flex: "none", color: C.dim, transition: "transform .15s ease" },
      body: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px 12px", maxHeight: "42vh", overflowY: "auto" },
      row: { display: "flex", gap: "6px", alignItems: "center" },
      input: {
        flex: "1", minWidth: 0, background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none",
      },
      btn: {
        flex: "none", background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "5px 10px", fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap",
      },
      primary: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "5px 12px", fontSize: "13px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
      },
      // 认不出宿主 Modal 时的自绘兜底（与宿主弹层同位置同层级；正常路径用内置样式）
      dialogMask: {
        position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
      },
      dialog: {
        width: "100%", maxWidth: "360px", background: C.bg, border: "1px solid " + C.border,
        borderRadius: "12px", boxShadow: C.elevation, padding: "14px", display: "flex",
        flexDirection: "column", gap: "8px", boxSizing: "border-box",
      },
      dialogTitle: { fontSize: "14px", fontWeight: 600, color: C.text },
      dialogBody: { fontSize: "13px", color: C.dim, lineHeight: 1.6 },
      link: { color: C.accent, textDecoration: "underline", wordBreak: "break-all" },
      // 失败清单：展开时是一张可滚动的等宽小表（格式 / 原因两列），收起时完全不占高度
      failureList: {
        display: "flex", flexDirection: "column", gap: "2px", maxHeight: "180px", overflowY: "auto",
        padding: "6px 8px", background: C.field, border: "1px solid " + C.border, borderRadius: "8px",
      },
      failureRow: { display: "flex", gap: "6px", fontSize: "12px", lineHeight: 1.5 },
      failureFormat: {
        flex: "none", minWidth: "64px", color: C.dim,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      },
      failureReason: { flex: "1", minWidth: 0, color: C.dimmer, wordBreak: "break-word" },
      note: { fontSize: "12px", color: C.dimmer, lineHeight: 1.5 },
      err: { fontSize: "12px", color: C.error, lineHeight: 1.5, wordBreak: "break-word" },
      status: { fontSize: "12px", color: C.dim, lineHeight: 1.5 },
      card: {
        display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px",
        border: "1px solid " + C.border, borderRadius: "10px", background: C.field,
      },
      badge: {
        flex: "none", display: "inline-flex", alignItems: "center", gap: "4px", padding: "1px 8px",
        borderRadius: "999px", border: "1px solid " + C.accent, color: C.accent, fontSize: "11px",
        fontWeight: 600, whiteSpace: "nowrap",
      },
      badgeOff: { borderColor: C.border, color: C.dimmer },
      cardHead: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
      title: { flex: "1", minWidth: 0, fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      meta: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", fontSize: "11px", color: C.dimmer },
      metaPath: { fontSize: "11px", color: C.dimmer, wordBreak: "break-all" },
      warn: { fontSize: "12px", color: C.warn, lineHeight: 1.5 },
      batchList: { display: "flex", flexDirection: "column", gap: "2px" },
      batchRow: { display: "flex", alignItems: "center", gap: "6px", minHeight: "26px", padding: "0 6px", borderRadius: "6px", outlineOffset: "-2px" },
      batchName: { flex: "1", minWidth: 0, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      batchMeta: { flex: "none", fontSize: "11px", color: C.dimmer, whiteSpace: "nowrap" },
      actions: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
      result: {
        padding: "6px 8px", fontSize: "12px", color: C.dim, background: C.field,
        borderRadius: "8px", wordBreak: "break-word", whiteSpace: "pre-wrap",
      },
    });

    const readFileAreaCollapsed = () => {
      try {
        return window.localStorage.getItem(FILE_AREA_COLLAPSED_KEY) === "1";
      } catch {
        return false; // localStorage 被禁用：按默认（展开）处理
      }
    };
    const writeFileAreaCollapsed = (collapsed) => {
      try {
        window.localStorage.setItem(FILE_AREA_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {
        // 写不进去就只在本次会话里生效：折叠状态不是必须持久化的功能
      }
    };

    // 路径末段（条目名回退用）：不写正则，避免片段里出现反斜杠转义
    const fileBaseName = (p) => {
      const s = String(p || "");
      const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf(FILE_PATH_SEP));
      return cut >= 0 ? s.slice(cut + 1) : s;
    };

    // 已识别条目：有标题 / 有轮次 / 是便携包（目录批处理的默认勾选口径）
    const isRecognizedEntry = (entry) => !!entry && entry.status !== "failed"
      && (entry.bundle === true || (typeof entry.title === "string" && entry.title !== "")
        || (typeof entry.turns === "number" && entry.turns > 0));
    // 可导入条目：识别到且没有 skipReason，且真能产出会话（bundle 或 turns > 0）
    const isImportableEntry = (entry) => isRecognizedEntry(entry) && !entry.skipReason
      && (entry.bundle === true || (typeof entry.turns === "number" && entry.turns > 0));

    // 文件指纹：init 用它做幂等键（同指纹已在暂存 → 零重传）
    const sha256Hex = async (file) => {
      const subtle = typeof window !== "undefined" && window.crypto ? window.crypto.subtle : null;
      if (!subtle || typeof subtle.digest !== "function") throw new Error("nosubtle");
      const buffer = await subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };

    // 分片 → base64（FileReader 的 dataURL 自带 MIME 前缀，只取逗号之后）
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const comma = text.indexOf(",");
        resolve(comma >= 0 ? text.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(new Error("read"));
      reader.readAsDataURL(blob);
    });

    /** 「从文件导入」折叠区：上传 / 路径浏览 / 预览 / 目录批处理。 */
    function FileImportPanel() {
      const t = useTranslate();
      const colors = useMemo(() => themeColors(), []);
      const style = useMemo(() => fileImportStyles(colors), [colors]);
      const [collapsed, setCollapsed] = useState(readFileAreaCollapsed);
      const [pathInput, setPathInput] = useState("");
      const [busy, setBusy] = useState(false); // 上传 / 预览 / 导入进行中：交互控件一起禁用
      const [previewing, setPreviewing] = useState(false);
      const [preview, setPreview] = useState(null); // { source:{path|uploadId}, kind, data, sourceKind }
      const [error, setError] = useState(null);
      const [result, setResult] = useState(null);
      const [upload, setUpload] = useState(null); // { name, i, n, pct }
      const [progress, setProgress] = useState(null); // 批量导入 { i, n }
      const [showFailures, setShowFailures] = useState(false);
      const [copied, setCopied] = useState(false);
      const [batchSel, setBatchSel] = useState(null); // Set<path>
      const [batchLimit, setBatchLimit] = useState(FILE_BATCH_PAGE);
      // 目录预览（非递归）的结果：据此询问「是否搜索子文件夹」（DSH 内置样式弹窗）
      const [subfolderAsk, setSubfolderAsk] = useState(null);
      const inputRef = useRef(null);

      // ── 预览与导入 ──────────────────────────────────────────────────────
      const runPreview = async (source) => {
        setBusy(true);
        setPreviewing(true);
        setError(null);
        setResult(null);
        setPreview(null);
        setShowFailures(false);
        let data = null;
        try {
          const resp = await fetch("/api-import/file", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...source, preview: true }),
          });
          data = await readJson(resp);
          if (data && data.ok === true) {
            setPreview({ source, kind: data.kind, data, sourceKind: source.uploadId ? "upload" : "path" });
            if (data.kind === "batch") {
              const entries = Array.isArray(data.results) ? data.results : [];
              setBatchSel(new Set(entries.filter(isRecognizedEntry).map((e) => e.path)));
              setBatchLimit(FILE_BATCH_PAGE);
            } else {
              setBatchSel(null);
            }
            // 识别失败时清单**默认收起**：卡片上先给一句结论（哪些解析器都失败了）与
            // 出路，需要逐条看原因时再展开——11 条「格式：原因」铺满卡片反而淹没重点。
          } else {
            setError((data && data.error) || t("fileImport.error.route"));
          }
        } catch (err) {
          setError(t("fileImport.error", { msg: String((err && err.message) || err) }));
        } finally {
          setPreviewing(false);
          setBusy(false);
        }
        return data;
      };

      // ── 回车 / 预览 = 搜索 ───────────────────────────────────────────────
      // 先按「仅当前目录」扫一层：单文件直接出预览；目录则弹出询问「是否搜索子文件夹」，
      // 用户选了再按该选择重新扫描——目录树可能很大，不做无谓的递归扫描。
      const searchPath = async (value) => {
        const p = String(value === undefined ? pathInput : value).trim();
        if (!p) { setError(t("fileImport.path.empty")); return; }
        setPathInput(p);
        setSubfolderAsk(null);
        const data = await runPreview({ path: p, recursive: false });
        if (data && data.ok === true && data.kind === "batch") {
          setSubfolderAsk({ path: p, total: data.total || 0 });
        }
      };

      // 子文件夹询问的三种收尾：仅当前目录 / 包含子文件夹（重扫）/ 取消
      const answerSubfolder = (recursive) => {
        const ask = subfolderAsk;
        setSubfolderAsk(null);
        if (ask && recursive !== null) runPreview({ path: ask.path, recursive });
      };

      const singleBlocked = (entry) => !entry
        || (entry.bundle !== true && (!(typeof entry.turns === "number" && entry.turns > 0) || !!entry.skipReason));

      const importSingle = async () => {
        if (!preview || preview.kind !== "single" || singleBlocked(preview.data)) return;
        setBusy(true);
        setError(null);
        setResult(null);
        try {
          const resp = await fetch("/api-import/file", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...preview.source, preview: false }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setResult(fmtImportResult([data], t));
            showAppToast(landingToast([data], t));
          } else {
            setError((data && data.error) || t("fileImport.error.route"));
          }
        } catch (err) {
          setError(t("fileImport.error", { msg: String((err && err.message) || err) }));
        } finally {
          setBusy(false);
        }
      };

      // 目录批处理：逐个串行导入（服务端每次一件，串行才能拿到确定的 i/N 进度）
      const importBatch = async () => {
        const entries = (preview && preview.kind === "batch" ? preview.data.results || [] : [])
          .filter((e) => batchSel && batchSel.has(e.path) && isImportableEntry(e));
        if (entries.length === 0) return;
        setBusy(true);
        setError(null);
        setResult(null);
        const results = [];
        try {
          for (let i = 0; i < entries.length; i++) {
            setProgress({ i: i + 1, n: entries.length });
            try {
              const resp = await fetch("/api-import/file", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: entries[i].path, preview: false }),
              });
              const data = await readJson(resp);
              results.push(data && data.ok === true ? data : { status: "failed", error: (data && data.error) || t("fileImport.error.route") });
            } catch (err) {
              // 单条失败不中断整批：记进 results，汇总时按「失败 N」如实报出
              results.push({ status: "failed", error: String((err && err.message) || err) });
            }
          }
          const summary = fmtImportResult(results, t);
          setResult(summary);
          // 目录批处理是长动作：汇总走官方 Toast（面板可能已不在眼前）
          showAppToast(summary);
        } finally {
          setProgress(null);
          setBusy(false);
        }
      };

      // ── 上传通道（拖放 / 选择文件）──────────────────────────────────────
      const uploadOne = async (file, i, n) => {
        setUpload({ name: file.name, i, n, pct: 0 });
        const sha256 = await sha256Hex(file);
        const initResp = await fetch("/api-import/upload/init", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, sha256 }),
        });
        const init = await readJson(initResp);
        if (!init || init.ok !== true) throw new Error((init && init.error) || t("fileImport.error.route"));
        // 同指纹已在暂存：零重传，直接进预览
        if (init.completed === true) return { uploadId: init.uploadId, path: init.path };
        const uploadId = init.uploadId;
        let chunkSize = typeof init.chunkSize === "number" && init.chunkSize > 0 ? init.chunkSize : 640 * 1024;
        let offset = typeof init.receivedOffset === "number" && init.receivedOffset >= 0 ? init.receivedOffset : 0;
        let fedBack = -1;
        let stuck = 0;
        while (offset < file.size) {
          const b64 = await blobToBase64(file.slice(offset, Math.min(file.size, offset + chunkSize)));
          const resp = await fetch("/api-import/upload/chunk", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId, offset, data: b64 }),
          });
          // 413：网关 body 上限 → 分片减半重试当前片（下限 64KB，再拒就大声报错）
          if (resp.status === 413) {
            if (chunkSize <= UPLOAD_MIN_CHUNK) throw new Error(t("fileImport.upload.tooLarge"));
            chunkSize = Math.max(UPLOAD_MIN_CHUNK, Math.floor(chunkSize / 2));
            continue;
          }
          const data = await readJson(resp);
          if (data && data.ok === true && typeof data.receivedOffset === "number") {
            offset = data.receivedOffset;
            fedBack = -1;
            stuck = 0;
            setUpload({
              name: file.name, i, n,
              pct: file.size > 0 ? Math.min(100, Math.round((offset / file.size) * 100)) : 100,
            });
            continue;
          }
          // offset-mismatch：服务端已收到的前缀更长（刷新 / 断线续传）→ 按其 receivedOffset 对齐；
          // 对齐后仍连续不前进（异常服务端）有限次后报错，不空转
          if (data && data.code === "offset-mismatch" && typeof data.receivedOffset === "number") {
            if (data.receivedOffset === fedBack) {
              stuck += 1;
              if (stuck > 3) throw new Error((data && data.error) || t("fileImport.error.route"));
            }
            fedBack = data.receivedOffset;
            offset = data.receivedOffset;
            continue;
          }
          throw new Error((data && data.error) || t("fileImport.error.route"));
        }
        const doneResp = await fetch("/api-import/upload/complete", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadId }),
        });
        const done = await readJson(doneResp);
        if (!done || done.ok !== true) throw new Error((done && done.error) || t("fileImport.error.route"));
        setUpload({ name: file.name, i, n, pct: 100 });
        return { uploadId, path: done.path };
      };

      const uploadFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(Boolean);
        if (files.length === 0) return;
        setBusy(true);
        setError(null);
        setResult(null);
        setPreview(null);
        setUpload(null);
        const failures = [];
        let last = null;
        for (let i = 0; i < files.length; i++) {
          try {
            last = await uploadOne(files[i], i + 1, files.length);
          } catch (err) {
            // 单个文件失败不吞：收集起来一起亮（其余文件继续传），全部失败也照样报出
            const raw = String((err && err.message) || err);
            const msg = raw === "nosubtle" ? t("fileImport.upload.nosubtle")
              : raw === "read" ? t("fileImport.upload.readFailed") : raw;
            failures.push(files[i].name + "：" + msg);
          }
        }
        setUpload(null);
        if (last) await runPreview({ uploadId: last.uploadId });
        // 预览会清错误：上传失败在预览之后再亮，避免被覆盖
        if (failures.length > 0) setError(t("fileImport.upload.failed", { msg: failures.join(t("result.separator")) }));
        setBusy(false);
      };

      // ── 失败清单与导出（识别失败时的三个出口之一）───────────────────────
      const failureList = () => {
        const list = [];
        const push = (entry) => {
          if (entry && Array.isArray(entry.failures)) for (const f of entry.failures) list.push(f);
        };
        if (preview) {
          if (preview.kind === "batch") for (const e of preview.data.results || []) push(e);
          else push(preview.data);
        }
        return list;
      };

      const copyFailures = async () => {
        const path = preview && preview.data ? (preview.data.path || pathInput.trim()) : pathInput.trim();
        const list = failureList();
        // 复制出去的是「可直接发给 Agent 的任务包」：任务说明 + 指南链接 + 源路径 +
        // 产出要求，末尾附逐解析器失败原因供参考——Agent 拿到不再需要回头找用户要上下文。
        const lines = [
          t("fileImport.failures.task.head", { url: t("fileImport.failures.guideUrl") }),
          "",
          t("fileImport.failures.task.path", { path }),
          "",
          t("fileImport.failures.task.req"),
        ];
        if (list.length > 0) {
          lines.push("", t("fileImport.failures.task.reasons", { n: list.length }));
          for (const f of list) {
            lines.push("- " + t("fileImport.failures.line", { format: (f && f.format) || "?", reason: (f && f.reason) || "" }));
          }
        }
        try {
          await window.navigator.clipboard.writeText(lines.join("\n"));
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2500);
        } catch {
          // 剪贴板被拒绝（无权限 / 非安全上下文）：如实报出，用户仍可手抄清单
          setError(t("fileImport.failures.copyFailed"));
        }
      };

      // ── 渲染 ────────────────────────────────────────────────────────────
      const detectedByText = (by) => (by && FILE_DETECTED_BY[by] ? t("fileImport.detectedBy." + by) : (by ? String(by) : ""));

      const badge = (detected, by) => React.createElement("span", {
        style: { ...style.badge, ...(detected ? null : style.badgeOff) },
      }, detected ? t("fileImport.detected", { format: detected }) : t("fileImport.notDetected"),
        detected && by ? " · " + by : null);

      const entryName = (entry) => (typeof entry.title === "string" && entry.title)
        || fileBaseName(entry.path) || t("noTitle");

      const degradeText = (entry) => {
        const bits = FILE_DEGRADE_KEYS
          .filter(([k]) => typeof entry[k] === "number" && entry[k] > 0)
          .map(([k, key]) => t(key, { n: entry[k] }));
        return bits.length > 0 ? t("fileImport.degraded", { bits: bits.join(t("result.separator")) }) : null;
      };

      const renderFailures = (entry) => {
        const list = Array.isArray(entry.failures) ? entry.failures : [];
        if (list.length === 0) return null;
        return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          React.createElement("div", { style: style.warn }, t("fileImport.failures.allFailed", { n: list.length })),
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.btn, "aria-expanded": showFailures,
              "aria-controls": FILE_FAILURES_ID,
              onClick: () => setShowFailures((v) => !v),
            }, showFailures ? t("fileImport.failures.collapseCount") : t("fileImport.failures.expandCount", { n: list.length })),
            React.createElement("button", {
              type: "button", style: style.btn, onClick: copyFailures,
            }, copied ? t("fileImport.failures.copied") : t("fileImport.failures.copy"))),
          showFailures && React.createElement("div", { id: FILE_FAILURES_ID, role: "list", style: style.failureList },
            list.map((f, i) => React.createElement("div", {
              key: i, role: "listitem", style: style.failureRow,
            },
              React.createElement("span", { style: style.failureFormat }, (f && f.format) || "?"),
              React.createElement("span", { style: style.failureReason }, (f && f.reason) || "")))),
          React.createElement("div", { style: style.note },
            t("fileImport.failures.hint"),
            React.createElement("a", {
              href: t("fileImport.failures.guideUrl"), target: "_blank", rel: "noreferrer", style: style.link,
            }, t("fileImport.failures.hintLink")),
            t("fileImport.failures.hintSuffix")));
      };

      const renderSingleCard = (entry) => {
        const bundle = entry.bundle === true;
        const turns = typeof entry.turns === "number" ? entry.turns : 0;
        const blocked = singleBlocked(entry);
        // 未识别（有失败清单、也没识别出格式）时的卡片只留必要信息：计数恒为 0、
        // skipReason 与「全部解析失败」是同一句话，留着只会把重点淹掉。
        const hasFailures = Array.isArray(entry.failures) && entry.failures.length > 0;
        const unrecognized = hasFailures && !entry.detectedFormat;
        const counts = [
          t("fileImport.turns", { n: turns }),
          t("fileImport.messages", { n: entry.messages || 0 }),
          t("fileImport.toolCalls", { n: entry.toolCalls || 0 }),
        ];
        if (entry.skipped) counts.push(t("fileImport.skipped", { n: entry.skipped }));
        const degrade = degradeText(entry);
        return React.createElement("div", { style: style.card },
          React.createElement("div", { style: style.cardHead },
            badge(entry.detectedFormat, detectedByText(entry.detectedBy)),
            React.createElement("span", { style: style.title, title: entry.path },
              bundle ? t("fileImport.bundle") : entryName(entry)),
            unrecognized ? null : React.createElement("span", { style: style.meta }, counts.join(" · "))),
          entry.path ? React.createElement("div", { style: style.metaPath }, entry.path) : null,
          bundle ? React.createElement("div", { style: style.note }, t("fileImport.bundle")) : null,
          entry.cwd ? React.createElement("div", { style: style.metaPath }, t("fileImport.cwd") + "：" + entry.cwd) : null,
          entry.createdAt ? React.createElement("div", { style: style.metaPath }, t("fileImport.createdAt") + "：" + fmtTime(entry.createdAt)) : null,
          entry.note ? React.createElement("div", { style: style.note }, t("fileImport.note", { note: entry.note })) : null,
          degrade ? React.createElement("div", { style: style.note }, degrade) : null,
          entry.skipReason && !unrecognized ? React.createElement("div", { style: style.warn }, t("fileImport.skipReason", { reason: entry.skipReason })) : null,
          !bundle && turns === 0 && !entry.skipReason && !hasFailures ? React.createElement("div", { style: style.warn }, t("fileImport.noTurns")) : null,
          renderFailures(entry),
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.primary, disabled: busy || blocked,
              title: blocked ? t("fileImport.import.disabled") : (bundle ? t("fileImport.restore") : t("fileImport.import")),
              onClick: importSingle,
            }, busy ? t("fileImport.importing") : (bundle ? t("fileImport.restore") : t("fileImport.import")))));
      };

      const toggleBatch = (p) => {
        setBatchSel((prev) => {
          const next = new Set(prev || []);
          if (next.has(p)) next.delete(p); else next.add(p);
          return next;
        });
      };

      const renderBatchCard = () => {
        const entries = Array.isArray(preview.data.results) ? preview.data.results : [];
        const shown = entries.slice(0, batchLimit);
        const remaining = entries.length - shown.length;
        const importable = entries.filter(isImportableEntry);
        const selectedCount = importable.filter((e) => batchSel && batchSel.has(e.path)).length;
        return React.createElement("div", { style: style.card },
          React.createElement("div", { style: style.cardHead },
            React.createElement("span", { style: style.title, title: preview.data.path || pathInput }, preview.data.path || pathInput),
            React.createElement("span", { style: style.meta },
              t("fileImport.batch.total", { total: entries.length }) + " · " + t("fileImport.batch.selected", { n: selectedCount }))),
          entries.length === 0 ? React.createElement("div", { style: style.note }, t("fileImport.batch.empty")) : null,
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.btn, disabled: busy || importable.length === 0,
              onClick: () => setBatchSel(new Set(importable.map((e) => e.path))),
            }, t("fileImport.batch.selectAll")),
            React.createElement("button", {
              type: "button", style: style.btn, disabled: busy || selectedCount === 0,
              onClick: () => setBatchSel(new Set()),
            }, t("fileImport.batch.none"))),
          React.createElement("div", { style: style.batchList },
            shown.map((entry) => {
              const ok = isImportableEntry(entry);
              const checked = !!(batchSel && batchSel.has(entry.path));
              const counts = entry.bundle === true
                ? t("fileImport.bundle")
                : [t("fileImport.turns", { n: typeof entry.turns === "number" ? entry.turns : 0 }),
                  entry.toolCalls ? t("fileImport.toolCalls", { n: entry.toolCalls }) : null].filter(Boolean).join(" · ");
              return React.createElement("div", {
                key: entry.path, role: "checkbox", "aria-checked": checked,
                "aria-disabled": ok ? undefined : true,
                "aria-label": entryName(entry) + " · " + counts,
                tabIndex: ok ? 0 : -1,
                title: entry.status === "failed" ? entry.error || t("fileImport.batch.failed") : entry.path,
                style: { ...style.batchRow, cursor: ok ? "pointer" : "default", opacity: ok ? 1 : 0.6 },
                onClick: ok ? () => toggleBatch(entry.path) : undefined,
                onKeyDown: ok ? (e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleBatch(entry.path); }
                } : undefined,
              },
                React.createElement("span", {
                  style: { flex: "none", display: "inline-flex", color: checked ? colors.accent : colors.dimmer },
                  "aria-hidden": true,
                }, React.createElement(Icon, { name: checked ? "checkCircle" : "circle", size: 14 })),
                React.createElement("span", { style: style.batchName }, entryName(entry)),
                React.createElement("span", { style: style.batchMeta },
                  entry.status === "failed" ? t("fileImport.batch.failed")
                    : entry.skipReason ? t("fileImport.notDetected") : counts));
            })),
          remaining > 0 ? React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.btn, disabled: busy,
              onClick: () => setBatchLimit((n) => n + FILE_BATCH_PAGE),
            }, t("fileImport.batch.showMore", { n: remaining }))) : null,
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.primary, disabled: busy || selectedCount === 0, onClick: importBatch,
            }, progress ? t("fileImport.batch.progress", { i: progress.i, n: progress.n })
              : busy ? t("fileImport.importing") : t("fileImport.batch.import", { n: selectedCount }))));
      };

      // 文件选择（「选择…」按钮触发）：浏览器只有 File 对象，走上传通道。
      // 不做拖放区——把会话文件拖进 DSH 窗口会被宿主当成「给对话加附件」抢走控制权；
      // 这里不跟宿主抢，选择入口交给系统文件框（面板不注册任何 drop 监听）。
      const filePicker = React.createElement("input", {
        ref: inputRef, type: "file", multiple: true, tabIndex: -1, "aria-hidden": true,
        style: { display: "none" },
        onChange: (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = ""; // 清空以允许重复选择同一个文件
          uploadFiles(files);
        },
      });

      // 子文件夹询问：DSH 内置预设样式（@deepseek-ai/dsh-client-ui-primitives 的 Modal /
      // Button，与 Toast 同一条 require 通道）；旧宿主缺该包时退回面板自绘弹层。
      const renderSubfolderDialog = () => {
        if (!subfolderAsk) return null;
        const ask = t("fileImport.subfolder.ask", { n: subfolderAsk.total });
        const close = () => setSubfolderAsk(null);
        if (HostModal && HostButton) {
          return React.createElement(HostModal, {
            open: true,
            onClose: close,
            title: t("fileImport.subfolder.title"),
            closeLabel: t("fileImport.subfolder.cancel"),
            children: React.createElement("div", null, ask),
            footer: React.createElement(React.Fragment, null,
              React.createElement(HostButton, {
                variant: "outline",
                disabled: busy,
                onClick: () => answerSubfolder(null),
              }, t("fileImport.subfolder.cancel")),
              React.createElement(HostButton, {
                variant: "outline",
                disabled: busy,
                onClick: () => answerSubfolder(false),
              }, t("fileImport.subfolder.current")),
              React.createElement(HostButton, {
                variant: "primary",
                autoFocus: true,
                disabled: busy,
                onClick: () => answerSubfolder(true),
              }, t("fileImport.subfolder.recursive"))),
          });
        }
        return React.createElement("div", {
          role: "dialog", "aria-modal": true, "aria-label": t("fileImport.subfolder.title"), style: style.dialogMask,
        },
          React.createElement("div", { style: style.dialog },
            React.createElement("div", { style: style.dialogTitle }, t("fileImport.subfolder.title")),
            React.createElement("div", { style: style.dialogBody }, ask),
            React.createElement("div", { style: style.actions },
              React.createElement("button", {
                type: "button", style: style.btn, disabled: busy, onClick: close,
              }, t("fileImport.subfolder.cancel")),
              React.createElement("button", {
                type: "button", style: style.btn, disabled: busy, onClick: () => answerSubfolder(false),
              }, t("fileImport.subfolder.current")),
              React.createElement("button", {
                type: "button", style: style.primary, disabled: busy, autoFocus: true,
                onClick: () => answerSubfolder(true),
              }, t("fileImport.subfolder.recursive")))));
      };

      const pathRow = React.createElement("div", { style: style.row },
        React.createElement("input", {
          style: style.input, value: pathInput, spellCheck: false,
          placeholder: t("fileImport.path.placeholder"), "aria-label": t("fileImport.path.aria"),
          onChange: (e) => setPathInput(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") searchPath(pathInput); },
        }),
        React.createElement("button", {
          type: "button", style: style.btn, disabled: busy,
          title: t("fileImport.choose"), onClick: () => { if (!busy && inputRef.current) inputRef.current.click(); },
        }, t("fileImport.choose")),
        React.createElement("button", {
          type: "button", style: style.primary, disabled: busy,
          onClick: () => searchPath(pathInput),
        }, previewing ? t("fileImport.previewing") : t("fileImport.preview")),
        filePicker);

      const previewArea = React.createElement("div", {
        "aria-live": "polite", style: { display: "flex", flexDirection: "column", gap: "6px" },
      },
        upload ? React.createElement("div", { style: style.status },
          t("fileImport.upload.progress", { name: upload.name, pct: upload.pct, i: upload.i, n: upload.n })) : null,
        previewing ? React.createElement("div", { style: style.status }, t("fileImport.previewing")) : null,
        error ? React.createElement("div", { role: "alert", style: style.err }, error) : null,
        preview && preview.kind === "batch" ? renderBatchCard()
          : preview && preview.kind === "single" ? renderSingleCard(preview.data) : null,
        !preview && !previewing && !error ? React.createElement("div", { style: style.note }, t("fileImport.preview.none")) : null,
        result ? React.createElement("div", { style: style.result }, t("fileImport.result", { msg: result })) : null);

      return React.createElement("div", { style: style.root },
        React.createElement("button", {
          type: "button", style: style.head,
          "aria-expanded": !collapsed, "aria-controls": FILE_AREA_ID,
          "aria-label": t(collapsed ? "fileImport.expand" : "fileImport.collapse"),
          onClick: () => {
            const next = !collapsed;
            setCollapsed(next);
            writeFileAreaCollapsed(next);
          },
        },
          React.createElement("span", { style: style.headTitle }, t("fileImport.title")),
          React.createElement("span", {
            style: { ...style.headChevron, transform: collapsed ? "rotate(-90deg)" : "none" },
            "aria-hidden": true,
          }, React.createElement(Icon, { name: "chevronDown", size: 13, strokeWidth: 1.5 }))),
        !collapsed && React.createElement("div", { id: FILE_AREA_ID, style: style.body },
          pathRow,
          previewArea,
          renderSubfolderDialog()));
    }
