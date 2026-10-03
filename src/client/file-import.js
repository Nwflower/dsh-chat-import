    // 「从文件导入」折叠区（ImportTabContent 导入子视图顶部，默认展开）：三条给文件的路径——
    // 拖放 / 选择文件走上传通道（浏览器拿不到本地路径）、路径输入 + 「浏览…」面板内浏览器、
    // 粘贴路径回车预览——外加格式覆盖、预览卡片与目录批处理。
    //
    // 后端契约（lib/panel.mjs）：
    //   POST /api-import/file   { path? | uploadId?, format?, preview, target? }：preview=true 零
    //                          副作用（识别 + 规模 + 降级计数），false 走导入编排；目录 → batch。
    //   POST /api-import/browse { mode: info | pick | list }：native 后端弹宿主系统框，
    //                          browse / fs 后端给一层目录清单（crumbs + entries）。
    //   POST /api-import/upload/{init,chunk,complete}：同 (sha256,size) 幂等；分片只追加、
    //                          offset 必须对齐（细节见 lib/upload.mjs 文件头）。
    //
    // 片段契约：本文件是 bundle 的一个片段，禁 import/export；前面片段声明的 useTranslate /
    // themeColors / SearchableSelect / readJson / showAppToast / fmtImportResult 直接用。
    const FILE_AREA_COLLAPSED_KEY = "chat-import.fileArea.collapsed";
    const FILE_AREA_ID = "chat-import-file-area";
    // 目录批处理的渲染步进：一次最多放 200 行，其余交给「显示更多」（与列表窗口化同思路）
    const FILE_BATCH_PAGE = 200;
    // 分片下限：服务端起始 640KB，413 逐次减半；减到这里仍被拒就报错，不静默丢文件
    const UPLOAD_MIN_CHUNK = 64 * 1024;
    // 格式覆盖下拉：'auto' + local-jsonl 认识的解析器名（lib/convert/local-jsonl.mjs）
    const FILE_FORMATS = ["auto", "dsh", "claude", "codex", "cursor", "reasonix", "pi", "openclaw", "hermes", "qoder", "vibe", "generic"];
    // 「导入到」：dsh 建可继续会话，其余是转投目标（与发现面板共用 target.* 文案）
    const FILE_TARGETS = ["dsh", "claude", "codex", "kimi", "opencode"];
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
      drop: {
        display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", padding: "14px 12px",
        border: "1px dashed " + C.border, borderRadius: "10px", background: C.field, cursor: "pointer",
        textAlign: "center", boxSizing: "border-box",
      },
      dropHot: { borderColor: C.accent, background: C.hover },
      dropTitle: { fontSize: "13px", color: C.text, fontWeight: 500 },
      dropHint: { fontSize: "11px", color: C.dimmer, lineHeight: 1.5 },
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
      rowPlain: { display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" },
      join: { color: C.dim, flex: "none", fontSize: "13px", lineHeight: "20px", whiteSpace: "nowrap" },
      browser: {
        position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30,
        display: "flex", flexDirection: "column", gap: "4px", maxHeight: "320px", overflowY: "auto",
        padding: "6px", background: C.bg, border: "1px solid " + C.border, borderRadius: "12px",
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation, boxSizing: "border-box",
      },
      browserHead: { display: "flex", alignItems: "flex-start", gap: "6px" },
      crumbs: { flex: "1", minWidth: 0, display: "flex", flexWrap: "wrap", gap: "2px", alignItems: "center" },
      crumb: {
        background: "transparent", border: "none", color: C.accent, font: "inherit", fontSize: "12px",
        padding: "1px 2px", cursor: "pointer", whiteSpace: "nowrap", maxWidth: "100%",
        overflow: "hidden", textOverflow: "ellipsis",
      },
      browserRow: {
        display: "flex", alignItems: "center", gap: "6px", width: "100%", minHeight: "28px", padding: "2px 6px",
        background: "transparent", border: "none", borderRadius: "6px", color: C.text, font: "inherit",
        fontSize: "13px", textAlign: "left", cursor: "pointer", boxSizing: "border-box",
      },
      browserName: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      browserKind: { flex: "none", color: C.dimmer, fontSize: "11px" },
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
      const [format, setFormat] = useState("auto");
      const [target, setTarget] = useState("dsh");
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
      const [browse, setBrowse] = useState(null); // null = 关闭；否则当前一层清单
      const [hot, setHot] = useState(false); // 拖放区高亮（内联样式没有 :hover/:drag）
      const inputRef = useRef(null);
      const browseOpen = !!(browse && browse.open);

      // 浮层打开期间的 Esc 关闭：stopPropagation 防止把整个右侧栏面板一起关掉
      useEffect(() => {
        if (!browseOpen) return undefined;
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setBrowse(null); } };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [browseOpen]);

      // ── 预览与导入 ──────────────────────────────────────────────────────
      const runPreview = async (source, fmt) => {
        setBusy(true);
        setPreviewing(true);
        setError(null);
        setResult(null);
        setPreview(null);
        setShowFailures(false);
        try {
          const resp = await fetch("/api-import/file", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...source, format: fmt === undefined ? format : fmt, preview: true }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setPreview({ source, kind: data.kind, data, sourceKind: source.uploadId ? "upload" : "path" });
            if (data.kind === "batch") {
              const entries = Array.isArray(data.results) ? data.results : [];
              setBatchSel(new Set(entries.filter(isRecognizedEntry).map((e) => e.path)));
              setBatchLimit(FILE_BATCH_PAGE);
            } else {
              setBatchSel(null);
            }
            // 识别失败默认摊开：这是用户此时唯一需要看的东西
            if (Array.isArray(data.failures) && data.failures.length > 0) setShowFailures(true);
          } else {
            setError((data && data.error) || t("fileImport.error.route"));
          }
        } catch (err) {
          setError(t("fileImport.error", { msg: String((err && err.message) || err) }));
        } finally {
          setPreviewing(false);
          setBusy(false);
        }
      };

      const previewPath = async (value, fmt) => {
        const p = String(value === undefined ? pathInput : value).trim();
        if (!p) { setError(t("fileImport.path.empty")); return; }
        setPathInput(p);
        await runPreview({ path: p }, fmt);
      };

      // 格式覆盖：有来源（已预览的上传件 / 已填路径）就按新格式重新识别
      const changeFormat = (v) => {
        setFormat(v);
        const source = preview && preview.source ? preview.source : (pathInput.trim() ? { path: pathInput.trim() } : null);
        if (source) runPreview(source, v);
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
            body: JSON.stringify({ ...preview.source, format, target, preview: false }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setResult(data.kind === "transfer" ? fmtTransferResult([data], data.target || target, t) : fmtImportResult([data], t));
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
                body: JSON.stringify({ path: entries[i].path, format, target, preview: false }),
              });
              const data = await readJson(resp);
              results.push(data && data.ok === true ? data : { status: "failed", error: (data && data.error) || t("fileImport.error.route") });
            } catch (err) {
              // 单条失败不中断整批：记进 results，汇总时按「失败 N」如实报出
              results.push({ status: "failed", error: String((err && err.message) || err) });
            }
          }
          const summary = target === "dsh"
            ? fmtImportResult(results, t)
            : results.map((r) => fmtTransferResult([r], target, t)).join("\n");
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

      // ── 路径浏览（native 系统框 / browse·fs 面板内浮层）─────────────────
      const listDir = async (p) => {
        setBrowse((b) => ({ ...(b || {}), open: true, loading: true, error: null }));
        try {
          const resp = await fetch("/api-import/browse", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(typeof p === "string" && p ? { mode: "list", path: p } : { mode: "list" }),
          });
          const data = await readJson(resp);
          if (data && data.ok === true) {
            setBrowse({
              open: true, loading: false, error: null,
              kind: data.kind || "fs",
              path: typeof data.path === "string" ? data.path : "",
              home: typeof data.home === "string" ? data.home : "",
              crumbs: Array.isArray(data.crumbs) ? data.crumbs : [],
              entries: Array.isArray(data.entries) ? data.entries : [],
              truncated: data.truncated === true,
            });
          } else {
            setBrowse((b) => ({ ...(b || { open: true }), loading: false, error: (data && data.error) || t("fileImport.error.route") }));
          }
        } catch (err) {
          setBrowse((b) => ({ ...(b || { open: true }), loading: false, error: String((err && err.message) || err) }));
        }
      };

      const openBrowse = async () => {
        if (browseOpen) { setBrowse(null); return; }
        setError(null);
        try {
          const infoResp = await fetch("/api-import/browse", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "info" }),
          });
          const info = await readJson(infoResp);
          if (!info || info.ok !== true) { setError((info && info.error) || t("fileImport.error.route")); return; }
          if (info.kind === "native") {
            // 宿主显示端的系统目录选择框：拿到路径回填（用户取消 = path null，不是错误）
            setBusy(true);
            const pickResp = await fetch("/api-import/browse", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "pick" }),
            });
            const picked = await readJson(pickResp);
            setBusy(false);
            if (picked && picked.ok === true) {
              if (typeof picked.path === "string" && picked.path) { setPathInput(picked.path); setError(null); }
            } else {
              setError((picked && picked.error) || t("fileImport.error.route"));
            }
            return;
          }
          await listDir(pathInput.trim());
        } catch (err) {
          setBusy(false);
          setError(t("fileImport.error", { msg: String((err && err.message) || err) }));
        }
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
        const lines = [t("fileImport.failures.summary.head", { path })];
        for (const f of failureList()) {
          lines.push(t("fileImport.failures.line", { format: (f && f.format) || "?", reason: (f && f.reason) || "" }));
        }
        lines.push(t("fileImport.failures.copyHint"));
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
        return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
          React.createElement("div", { style: style.warn }, t("fileImport.failures.title", { n: list.length })),
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.btn, "aria-expanded": showFailures,
              onClick: () => setShowFailures((v) => !v),
            }, showFailures ? t("fileImport.failures.collapse") : t("fileImport.failures.expand")),
            React.createElement("button", {
              type: "button", style: style.btn, onClick: copyFailures,
            }, copied ? t("fileImport.failures.copied") : t("fileImport.failures.copy"))),
          showFailures && React.createElement("div", { role: "list" },
            list.map((f, i) => React.createElement("div", {
              key: i, role: "listitem", style: style.err,
            }, t("fileImport.failures.line", { format: (f && f.format) || "?", reason: (f && f.reason) || "" })))),
          React.createElement("div", { style: style.note }, t("fileImport.failures.hint")));
      };

      const renderSingleCard = (entry) => {
        const bundle = entry.bundle === true;
        const turns = typeof entry.turns === "number" ? entry.turns : 0;
        const blocked = singleBlocked(entry);
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
            React.createElement("span", { style: style.meta }, counts.join(" · "))),
          entry.path ? React.createElement("div", { style: style.metaPath }, entry.path) : null,
          bundle ? React.createElement("div", { style: style.note }, t("fileImport.bundle")) : null,
          entry.cwd ? React.createElement("div", { style: style.metaPath }, t("fileImport.cwd") + "：" + entry.cwd) : null,
          entry.createdAt ? React.createElement("div", { style: style.metaPath }, t("fileImport.createdAt") + "：" + fmtTime(entry.createdAt)) : null,
          entry.note ? React.createElement("div", { style: style.note }, t("fileImport.note", { note: entry.note })) : null,
          degrade ? React.createElement("div", { style: style.note }, degrade) : null,
          entry.skipReason ? React.createElement("div", { style: style.warn }, t("fileImport.skipReason", { reason: entry.skipReason })) : null,
          !bundle && turns === 0 && !entry.skipReason ? React.createElement("div", { style: style.warn }, t("fileImport.noTurns")) : null,
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

      const renderBrowser = () => {
        const b = browse || {};
        const crumbs = b.crumbs || [];
        const entries = b.entries || [];
        return React.createElement("div", {
          style: style.browser, role: "dialog", "aria-label": t("fileImport.browser.aria"),
        },
          React.createElement("div", { style: style.browserHead },
            React.createElement("div", { style: style.crumbs, role: "navigation", "aria-label": t("fileImport.browser.crumbAria") },
              crumbs.map((c, i) => React.createElement("button", {
                key: (c.path || "") + i, type: "button", tabIndex: 0, style: style.crumb,
                title: c.path, disabled: b.loading === true,
                "aria-label": t("fileImport.browser.crumb", { name: c.name || c.path }),
                onClick: () => listDir(c.path),
              }, (c.name || c.path) + (i < crumbs.length - 1 ? " /" : "")))),
            React.createElement("button", {
              type: "button", style: style.browserKind, "aria-label": t("fileImport.browser.close"),
              onClick: () => setBrowse(null),
            }, t("fileImport.browser.close"))),
          b.loading ? React.createElement("div", { style: style.status }, t("fileImport.browser.loading")) : null,
          b.error ? React.createElement("div", { role: "alert", style: style.err },
            t("fileImport.browser.failed", { msg: b.error })) : null,
          !b.loading && !b.error && entries.length === 0
            ? React.createElement("div", { style: style.note }, t("fileImport.browser.empty")) : null,
          React.createElement("div", { role: "group" },
            entries.map((entry) => {
              const isFile = entry.type === "file";
              return React.createElement("button", {
                key: entry.path, type: "button", tabIndex: 0, style: style.browserRow, title: entry.path,
                "aria-label": t(isFile ? "fileImport.browser.entryFile" : "fileImport.browser.entryDir", { name: entry.name }),
                onMouseEnter: (e) => { e.currentTarget.style.background = colors.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
                onClick: () => {
                  if (isFile) { setPathInput(entry.path); setBrowse(null); } else { listDir(entry.path); }
                },
              },
                React.createElement("span", {
                  style: { flex: "none", display: "inline-flex", color: colors.dimmer }, "aria-hidden": true,
                }, React.createElement(Icon, { name: isFile ? "check" : "chevronRight", size: 13 })),
                React.createElement("span", { style: style.browserName }, entry.name),
                React.createElement("span", { style: style.browserKind }, isFile ? "" : "›"));
            })),
          b.truncated ? React.createElement("div", { style: style.note },
            t("fileImport.browser.truncated", { n: entries.length })) : null,
          React.createElement("div", { style: style.actions },
            React.createElement("button", {
              type: "button", style: style.primary, disabled: b.loading === true || !b.path,
              onClick: () => { setPathInput(b.path || pathInput); setBrowse(null); },
            }, t("fileImport.browser.pickDir")),
            b.home && b.path !== b.home ? React.createElement("button", {
              type: "button", style: style.btn, disabled: b.loading === true,
              onClick: () => listDir(b.home),
            }, t("fileImport.browser.home")) : null));
      };

      const dropZone = React.createElement("div", {
        role: "button", tabIndex: 0,
        "aria-label": t("fileImport.drop.aria"), title: t("fileImport.drop.title"),
        style: { ...style.drop, ...(hot ? style.dropHot : null) },
        onClick: () => { if (!busy && inputRef.current) inputRef.current.click(); },
        onKeyDown: (e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            if (inputRef.current) inputRef.current.click();
          }
        },
        onDragOver: (e) => { e.preventDefault(); if (!hot && !busy) setHot(true); },
        onDragEnter: (e) => { e.preventDefault(); if (!busy) setHot(true); },
        onDragLeave: () => setHot(false),
        onDrop: (e) => {
          e.preventDefault();
          setHot(false);
          if (!busy) uploadFiles(e.dataTransfer && e.dataTransfer.files);
        },
      },
        React.createElement("div", { style: style.dropTitle }, t("fileImport.drop.title")),
        React.createElement("div", { style: style.dropHint }, t("fileImport.drop.hint")),
        React.createElement("input", {
          ref: inputRef, type: "file", multiple: true, tabIndex: -1, "aria-hidden": true,
          style: { display: "none" },
          // 隐藏 input 的 click 会冒泡回拖放区的 onClick（再次 input.click()）；拦在这里
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = ""; // 清空以允许重复选择同一个文件
            uploadFiles(files);
          },
        }));

      const pathRow = React.createElement("div", { style: style.row },
        React.createElement("input", {
          style: style.input, value: pathInput, spellCheck: false,
          placeholder: t("fileImport.path.placeholder"), "aria-label": t("fileImport.path.aria"),
          onChange: (e) => setPathInput(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") previewPath(pathInput); },
        }),
        React.createElement("button", {
          type: "button", style: style.btn, disabled: busy,
          "aria-haspopup": "dialog", "aria-expanded": browseOpen,
          title: t("fileImport.browse"), onClick: openBrowse,
        }, t("fileImport.browse")),
        React.createElement("button", {
          type: "button", style: style.primary, disabled: busy,
          onClick: () => previewPath(pathInput),
        }, previewing ? t("fileImport.previewing") : t("fileImport.preview")));

      const selectsRow = React.createElement("div", { style: style.rowPlain },
        React.createElement("span", { style: style.join }, t("fileImport.format")),
        React.createElement(SearchableSelect, {
          value: format, colors, disabled: busy, title: t("fileImport.format.title"),
          searchPlaceholder: t("fileImport.format.search"), noMatchLabel: t("combobox.noMatch"),
          options: FILE_FORMATS.map((f) => ({
            value: f,
            label: f === "auto" ? t("fileImport.format.auto") : f === "generic" ? t("fileImport.format.generic") : f,
          })),
          onChange: changeFormat,
        }),
        React.createElement("span", { style: style.join }, t("fileImport.importTo")),
        React.createElement(SearchableSelect, {
          value: target, colors, disabled: busy, searchable: false, title: t("importTo.title"),
          options: FILE_TARGETS.map((v) => ({ value: v, label: t("target." + v) })),
          onChange: (v) => setTarget(v),
        }));

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
          dropZone,
          React.createElement("div", { style: { position: "relative", display: "flex", flexDirection: "column", gap: "6px" } },
            pathRow,
            browseOpen ? renderBrowser() : null),
          selectsRow,
          previewArea));
    }
