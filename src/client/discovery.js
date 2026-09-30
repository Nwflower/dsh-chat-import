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
      const lit = hot || checked;
      const key = itemKey(s);
      // 勾选入口 = **整行**（点行内任意处，含来源标 / 时间 / 空白），不再要求瞄准 22px 的
      // 方图或某一段文字。因此行的外层容器即勾选控件（role=checkbox + 键盘切换）；行内
      // 的导入按钮是唯一例外——它必须 stopPropagation，否则点按钮会连带切换勾选。
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
            style: hot ? style.importBtn : style.rowBtnIdle,
            disabled: importing,
            // 行本身可勾选 → 按钮必须拦住冒泡，否则「点导入」会顺带勾上这一行
            onClick: (e) => { e.stopPropagation(); onImport(s); },
            onFocus: () => props.onHot(key, null, groupName),
            onBlur: () => props.onHot(null, key, groupName),
            title: props.importTitle,
          }, props.importLabel)));
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
            // 落点 Toast（官方 shell.overlay 顶部横幅）：面板可能不在眼前（批量导入时切走
            // 了 tab、右栏收起），所以「这次导到哪个工作区 / 哪个文件」要浮出来一次。
            // 无落点信息（全部幂等跳过等）时 landingToast 返回空串 → 不弹，避免噪音。
            showAppToast(landingToast(data.results, t));
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
              toolBtn(t("refresh"), "refresh", { onClick: () => setEpoch((n) => n + 1), disabled: importing, title: t("refresh.title") }, toolsIcon)),
            // 探针：与真实按钮同款文字、同款 button 元素，只为量出「文字形态需要多宽」；
            // 绝对定位 + 不可见，不参与排版也不可交互（tabIndex -1 保证不进键盘序）
            React.createElement("div", { ref: toolsProbeRef, "aria-hidden": true, style: style.toolbarProbe },
              [selectAllLabel, t("clearSelection"), t("refresh")]
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
