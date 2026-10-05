    // 发现 + 导入主面板（DiscoveryPanel）及其零件，自上而下：
    //   纯函数（筛选 / 分组 / 窗口算术 / 导入结果收尾）→ hooks（流式扫描、列表窗口）→
    //   子组件（页控件、会话行、工作区分组、工具栏、分页条）→ DiscoveryPanel 本体。
    // 纯函数不碰 React 状态，测试从 bundle 里切出来直接跑（test/panel-discovery.test.mjs）。

    // 列表窗口化的尺寸常量：行高 28px + 行距 1px，分组头 28px + 组间距 6px（见 styles.js）。
    // 固定高度 → 可见区间是纯算术，不需要测量每一行。
    const LIST_ROW_H = 29;
    const LIST_HEAD_H = 34;
    // 视口上下各多渲染「一屏」（原来的 ±10 行在快滚时会露白，观感像「停下来才渲染」）
    const LIST_OVERSCAN_MIN = 10;

    // ── 纯函数 ──────────────────────────────────────────────────────────────

    /** 时间筛选：会话最后活跃（缺省创建）时间落在 now 往前 TIME_FILTER_MS[timeFilter] 之内；
     *  '' / 未知档位 = 不筛选（原样返回同一个数组）。 */
    function filterByTime(list, timeFilter, now) {
      const span = TIME_FILTER_MS[timeFilter];
      if (!span) return list;
      const floor = now - span;
      return list.filter((s) => ((s.lastActiveAt || s.createdAt) || 0) >= floor);
    }

    // 组内最新会话的最后编辑时间（组排序键：最近活跃的工作区置顶）
    const groupLatest = (list) => list.reduce((m, s) => Math.max(m, s.lastActiveAt ?? s.createdAt ?? 0), 0);

    /** 按工作区文件夹（project）分组 → [{ name, list }]：组按组内最新会话的最后编辑时间降序
     *  （最近活跃的工作区置顶，时间并列按工作区名升序稳定），组内按最后编辑时间降序；未分组
     *  钉最后。 */
    function groupSessions(sessions) {
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
    }

    /** 每组在列表中的纵向偏移 → [{ group, rowsTop }]（固定行高 → 纯算术；折叠组只算组头）。 */
    function layoutGroups(groups, collapsed) {
      let cursor = 0;
      return groups.map((group) => {
        const rowsTop = cursor + LIST_HEAD_H;
        cursor += LIST_HEAD_H + (collapsed.has(group.name) ? 0 : group.list.length * LIST_ROW_H);
        return { group, rowsTop };
      });
    }

    /** 一组（count 行、行区顶端在 rowsTop）在视口 win = { top, h } 下的窗口切片：只把可见区间
     *  （上下各多一屏、至少 LIST_OVERSCAN_MIN 行）交给 React，其余用等高占位块撑住——滚动条
     *  长度与分组头 sticky 行为都不变。返回 { first, last, padTop, padBottom }，渲染
     *  list.slice(first, last)。 */
    function windowRange(count, rowsTop, win) {
      const total = count * LIST_ROW_H;
      const pad = Math.max(LIST_OVERSCAN_MIN, Math.ceil(win.h / LIST_ROW_H));
      const first = Math.max(0, Math.floor((win.top - rowsTop) / LIST_ROW_H) - pad);
      const last = Math.min(count, Math.ceil((win.top + win.h - rowsTop) / LIST_ROW_H) + pad);
      if (last > first) {
        const padTop = first * LIST_ROW_H;
        return { first, last, padTop, padBottom: total - padTop - (last - first) * LIST_ROW_H };
      }
      const padTop = Math.min(total, Math.max(0, first * LIST_ROW_H));
      return { first, last: first, padTop, padBottom: total - padTop };
    }

    /** 会话行的悬停提示：标题 + 「来源 · 上下文 · 分支 · 导入状态 · 绝对时间」。行内只留
     *  「工具标 + 标题 + 时间」，其余收进提示（行内信息越少越好扫）。 */
    function sessionTip(s, t) {
      const ctxTok = fmtTokenCount(s.contextTokens);
      const meta = [
        sourceLabel(s.format),
        ctxTok ? t("count.contextTokens", { n: ctxTok }) : null,
        s.gitBranch ? s.gitBranch + (s.gitDirty ? " ✗" : "") : null,
        statusLabel(s.importStatus, t),
        fmtTime(s.lastActiveAt || s.createdAt),
      ].filter(Boolean).join(" · ");
      return (s.title || t("noTitle")) + (meta ? "\n" + meta : "");
    }

    /** 行的点亮态 { key, group }（悬停或行内按钮聚焦；组头随所在分组一起变亮）。进入（key
     *  非空）即点亮该行与所在分组；离开（key 为空，only = 离开的那一行）只在点亮的仍是这一行
     *  时连同分组一起熄灭——焦点 / 悬停交错时（先进新行、后离旧行）不会把新行熄掉。 */
    const NO_HOT = { key: null, group: null };
    function nextHot(prev, key, only, group) {
      if (key !== null) {
        const g = group || null;
        return prev.key === key && prev.group === g ? prev : { key, group: g };
      }
      return prev.key === only ? NO_HOT : prev;
    }

    /** 导入结果摘要（结果条文案）：DSH 目标报导入计数，转投目标报转投摘要。归档旧会话（迁移
     *  收尾）的结果如实附在后面：宿主没有归档 API 时点名，不假装成功；导入未成功的条目不会被
     *  归档，条数经 archiveSkipped 单独说明——归档不可逆，不能让用户以为「已归档」等于「已迁移」。 */
    function importSummary(data, archiveSources, t) {
      const summary = data.target && !String(data.target).startsWith("dsh")
        ? fmtTransferResult(data.results, data.target, t)
        : fmtImportResult(data.results, t);
      if (!archiveSources) return summary;
      return summary + [
        data.archiveUnsupported
          ? t("archive.unsupported")
          : typeof data.archived === "number" ? t("archive.done", { n: data.archived }) : "",
        typeof data.archiveSkipped === "number" && data.archiveSkipped > 0
          ? t("archive.skipped", { n: data.archiveSkipped }) : "",
      ].filter(Boolean).map((line) => "\n" + line).join("");
    }

    /** 本次请求里被幂等跳过（already-imported）的条目——Toast 的「重新导入为新会话」用 force
     *  再导的就是这一批。 */
    function alreadyImportedItems(results, items) {
      const paths = new Set((results || [])
        .filter((r) => r && r.status === "already-imported")
        .map((r) => r.sourcePath));
      return items.filter((it) => paths.has(it.sourcePath));
    }

    /** 本次请求里被忽略墓碑挡下（ignored）的条目——Toast 的「仍然导入」用 force 越权重导的
     *  这一批（永久解除走 /unignore）。批量结果只带计数、定位不到逐条时按整批重试：宁可多导
     *  用户显式点过一次的那批，也不给一个点了没反应的按钮。 */
    function ignoredItems(results, items) {
      const list = results || [];
      if (list.some((r) => r && typeof r.ignored === "number" && r.ignored > 0)) return items;
      const paths = new Set(list.filter((r) => r && r.status === "ignored").map((r) => r.sourcePath));
      return items.filter((it) => paths.has(it.sourcePath));
    }

    /** 单条导入（非 force / 非归档 / 非多会话源）成功后，本地把该行标成已导入即可、不重扫：
     *  返回要打标的 sourcePath；其余情况返回 ""（走 epoch 重扫，但不清空旧列表）。重扫只为
     *  刷新状态，而只有这条路径的状态变化是可确定的（multi 源的 partial 语义、force 另铸 id
     *  都不在这里）。 */
    function localImportedPath(results, force, archiveSources) {
      const only = (results || []).length === 1 ? results[0] : null;
      const donePath = only && typeof only.sourcePath === "string" ? only.sourcePath : "";
      return only && only.status === "imported" && only.mode === "single" && !force && !archiveSources ? donePath : "";
    }

    /** 扫描失败被跳过的目标（服务端 warnings：[{ format, target, error }]）→ 列表上方一行不打断
     *  操作的提示：正文按来源去重点名（最多三个），title 悬浮看逐条明细。没有失败返回 null。
     *  labelOf：format 短名 → 来源展示名。 */
    function scanWarningNotice(warnings, t, labelOf) {
      if (!Array.isArray(warnings) || warnings.length === 0) return null;
      const names = [];
      for (const w of warnings) {
        const name = labelOf(w && w.format);
        if (names.indexOf(name) === -1) names.push(name);
      }
      const sources = names.slice(0, 3).join(t("result.separator")) + (names.length > 3 ? " …" : "");
      return {
        text: t("scan.warnings", { n: warnings.length, sources }),
        title: warnings.map((w) => w.format + " @ " + w.target + ": " + w.error).join("\n"),
      };
    }

    // ── hooks ───────────────────────────────────────────────────────────────

    /** 流式加载：后台扫描 + after 游标轮询——会话按发现顺序逐条 append 到缓冲，首屏不被全量
     *  扫描阻塞；每次请求只取 cursor 之后的增量（服务端 seq 去重）。同来源 + 同搜索词的再次
     *  扫描（导入后 epoch 自增触发的刷新）不清空旧列表：旧数据留在屏幕上，新扫描的首批到达时
     *  整批替换——避免「清空 → 重填」那一下闪烁。换来源 / 换搜索词才是真的换了数据集，照旧清空。
     *  onStart：每轮扫描开始时调用；onDshVersion(v)：响应带回宿主会话格式版本时调用。
     *  warnings：本轮扫描失败被跳过的目标（扫描完成的那次响应带回；新一轮开始时清空）。
     *  返回 { items, setItems, stream, error, warnings }。 */
    function useSessionScan({ source, query, epoch, t, onStart, onDshVersion }) {
      const [items, setItems] = useState([]); // 流式累计缓冲（scan 逐条按发现顺序插入）
      const [stream, setStream] = useState({ done: false, cursor: 0, total: 0, started: false });
      const [error, setError] = useState(null);
      const [warnings, setWarnings] = useState([]);
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
          setWarnings([]);
          onStart();
          let after = 0;
          let done = false;
          let failed = null;
          let seen = { done: false, total: 0, started: false }; // 已渲染的流状态（防空轮询重渲染）
          while (!cancelled && !done && !failed) {
            let r;
            try {
              r = await postJson("/api-import/sessions", { source, query, epoch, after }, parsePanelResponse);
            } catch (err) {
              failed = t("error.request", { msg: errorText(err) });
              break;
            }
            if (cancelled) return;
            if (!r.ok) {
              failed = r.error || t("error.load");
              break;
            }
            const data = r.data;
            after = typeof data.cursor === "number" ? data.cursor : after;
            done = data.done === true;
            if (typeof data.dshVersion === "number") onDshVersion(data.dshVersion);
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
            if (done && Array.isArray(data.warnings) && data.warnings.length > 0) setWarnings(data.warnings);
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
      return { items, setItems, stream, error, warnings };
    }

    /** 列表窗口：跟踪滚动容器的 scrollTop / clientHeight（rAF 合并滚动事件，ResizeObserver
     *  跟容器高度），值不变时不更新状态。只挂载可见区间那几十行（大档位下元素创建 / DOM /
     *  布局都不再随档位线性增长），区间由 windowRange 算。返回 [setListEl（列表容器的 ref
     *  回调）, win, listEl]。 */
    function useListWindow() {
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
      return [setListEl, win, listEl];
    }

    // ── 子组件 ──────────────────────────────────────────────────────────────

    /** 页控件：显示「第 x / y 页」，点开在底栏之上弹出页码网格（像选集），点数字直接跳页。
     *  页多时网格自身滚动，并停在当前页附近。 */
    function PageJump({ page, totalPages, onPick }) {
      const t = useTranslate();
      const style = STYLES;
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
        cells.push(h("button", {
          key: i, type: "button", style: { ...style.pageCell, ...(i === page ? style.pageCellActive : null) },
          onClick: () => { onPick(i); setOpen(false); },
          onMouseEnter: (e) => { if (i !== page) e.currentTarget.style.background = COLORS.hover; },
          onMouseLeave: (e) => { if (i !== page) e.currentTarget.style.background = "transparent"; },
        }, String(i + 1)));
      }
      return h("span", {
        ref: rootRef, style: { position: "relative", display: "inline-flex", flex: "none" },
      },
        h("button", {
          type: "button", style: style.pageChip, "aria-haspopup": "true", "aria-expanded": open,
          title: t("page.jump.title"),
          onClick: () => setOpen((v) => !v),
        }, t("page.jump", { page: page + 1, pages: totalPages }),
          h(Icon, { name: "chevronDown", size: 12, strokeWidth: 1.5 })),
        open && h("div", { ref: gridRef, style: style.pageGrid, role: "menu" }, cells));
    }

    /** 会话行（memo）：悬停 / 勾选一次只影响自己这一行——父级重渲染时其余行直接复用上次的
     *  元素树，不再重建（大档位下这是主要开销）。比较字段全是标量，回调由父级 useCallback
     *  固定引用。 */
    const SessionRow = React.memo(function SessionRow(props) {
      const { s, badgeOverlay, label, time, tip, checked, hot, importing, onToggle, onImport, groupName } = props;
      const style = STYLES;
      const colors = COLORS;
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
      return h("div", {
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
        h(SourceBadge, {
          format: s.format, checked, disabled: importing, size: 22,
          title: label,
          palette: { border: colors.border, accent: colors.accent, text: colors.text, overlay: badgeOverlay },
        }),
        h("div", { style: style.itemMain },
          h("div", {
            style: { ...style.itemTitle, ...(lit ? style.itemTitleActive : null) },
          }, s.title || props.noTitle)),
        h("div", { style: style.rowSlot },
          hot ? null : h("span", { style: style.rowTime }, time),
          h("button", {
            style: hot ? style.importBtn : style.rowBtnIdle,
            disabled: importing,
            // 行本身可勾选 → 按钮必须拦住冒泡，否则「点导入」会顺带勾上这一行
            onClick: (e) => { e.stopPropagation(); onImport(s); },
            onFocus: () => props.onHot(key, null, groupName),
            onBlur: () => props.onHot(null, key, groupName),
            title: props.importTitle,
          }, props.importLabel)));
    }, (a, b) => a.s === b.s && a.checked === b.checked && a.hot === b.hot && a.importing === b.importing
      && a.label === b.label && a.time === b.time && a.tip === b.tip && a.badgeOverlay === b.badgeOverlay
      && a.onToggle === b.onToggle && a.onImport === b.onImport && a.onHot === b.onHot);

    /** 一个工作区分组：组头（点击折叠 / 展开）+ 窗口化的会话行（区间见 windowRange）。组头与
     *  皮肤一致——悬停（或组内有行点亮：groupLit）时文字变亮并露出折叠箭头，不浮背景矩形
     *  （它是标题不是目标）；组头自己的悬停是本组件的局部状态，不惊动整个面板。 */
    function SessionGroup(props) {
      const { entry, win, t, importing, selected, badgeOverlay, isCollapsed, hotKey, groupLit, onCollapse, onToggle, onImport, onHot } = props;
      const style = STYLES;
      const group = entry.group;
      const [headHover, setHeadHover] = useState(false);
      const range = isCollapsed ? null : windowRange(group.list.length, entry.rowsTop, win);
      const rows = range === null ? [] : group.list.slice(range.first, range.last).map((s) => {
        const key = itemKey(s);
        return h(SessionRow, {
          key,
          s,
          badgeOverlay,
          groupName: group.name,
          label: sourceLabel(s.format),
          time: relTime(s.lastActiveAt || s.createdAt, t) || t("timeUnknown"),
          tip: sessionTip(s, t),
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
      const padTop = range === null ? 0 : range.padTop;
      const padBottom = range === null ? 0 : range.padBottom;
      const headHot = headHover || groupLit;
      return h(React.Fragment, null,
        h("div", {
          style: { ...style.group, ...(headHot ? { color: COLORS.text } : null) },
          onClick: () => onCollapse(group.name),
          title: isCollapsed ? t("group.expand") : t("group.collapse"),
          onMouseEnter: () => setHeadHover(true),
          onMouseLeave: () => setHeadHover(false),
        },
          h("span", { style: style.groupLabel }, workspaceLabel(group.name, t)),
          h("span", {
            style: {
              ...style.groupChevron, opacity: headHot ? 1 : 0,
              transform: isCollapsed ? "rotate(-90deg)" : "none",
              transition: "opacity .12s ease, transform .15s ease",
            },
          }, h(Icon, { name: "chevronDown", size: 12, strokeWidth: 1.5 })),
          h("span", { style: style.groupCount }, t("count.sessions", { n: group.list.length }))),
        padTop > 0 ? h("div", { key: "pad-top", "aria-hidden": true, style: { height: padTop + "px" } }) : null,
        rows,
        padBottom > 0 ? h("div", { key: "pad-bottom", "aria-hidden": true, style: { height: padBottom + "px" } }) : null);
    }

    /** 工具栏：全选 / 清空 / 刷新三个动作 + 末位的路径 / 时间两个筛选。
     *  动作按钮的降级判据看「动作按钮组」实测到的可用宽度，而不是面板宽度——筛选芯片也在这条
     *  工具栏上，会按工作区名吃掉宽度，只看面板宽度会让按钮在中间那一段宽度里被压扁 / 折行。
     *  隐藏探针量出文字形态需要多宽，两者一比即可（字体大小随主题偏好变化，不写死阈值）；
     *  窄面板（narrow）一律图标。 */
    function DiscoveryToolbar(props) {
      const { t, narrow, importing, allSelected, hasSelection, canSelectAll, hasItems, onToggleAll, onClearSelection, onRefresh } = props;
      const { workspaceFilter, workspaceOptions, onWorkspaceFilter, timeFilter, onTimeFilter } = props;
      const style = STYLES;
      const [toolsRef, toolsWidth] = useContainerWidth();
      const [toolsProbeRef, toolsNeed] = useContainerWidth();
      const toolsIcon = narrow || (toolsWidth !== 0 && toolsNeed !== 0 && toolsWidth < toolsNeed);
      // 动作按钮：宽态文字、窄态图标（title 保留说明，aria-label 保留可访问名；extra.title
      // 可覆盖默认的「文字即标题」，如刷新的详细提示）。
      const toolBtn = (label, icon, extra) => h("button", {
        style: toolsIcon ? style.iconBtn : style.toolBtn,
        title: label,
        "aria-label": label,
        ...(extra || {}),
      }, toolsIcon ? h(Icon, { name: icon }) : label);
      const selectAllLabel = allSelected ? t("deselectAll") : t("selectAll");
      return h("div", { style: style.toolbar },
        h("div", { ref: toolsRef, style: style.toolbarActions },
          toolBtn(selectAllLabel, "checkSquare", { onClick: onToggleAll, disabled: !canSelectAll || importing }),
          toolBtn(t("clearSelection"), "x", { onClick: onClearSelection, disabled: !hasSelection || importing }),
          toolBtn(t("refresh"), "refresh", { onClick: onRefresh, disabled: importing, title: t("refresh.title") })),
        // 探针：与真实按钮同款文字、同款 button 元素，只为量出「文字形态需要多宽」；
        // 绝对定位 + 不可见，不参与排版也不可交互（tabIndex -1 保证不进键盘序）
        h("div", { ref: toolsProbeRef, "aria-hidden": true, style: style.toolbarProbe },
          [selectAllLabel, t("clearSelection"), t("refresh")]
            .map((label) => h("button", {
              key: label, type: "button", tabIndex: -1, style: style.toolBtn,
            }, label))),
        // 工作区筛选挂在工具栏末位：与动作按钮分组，且不走 toolBtn——窄面板下工具按钮
        // 降级成图标时它仍保持文字
        h("span", { style: style.toolbarFilter },
          // 标签本身就是按钮：默认只写「筛选：路径」，选中后补「· 值」，避免「标签 + 芯片」两段
          h(SearchableSelect, {
            value: workspaceFilter, title: t("workspace.title"), colors: COLORS,
            triggerLabel: workspaceFilter
              ? t("filter.path") + " · " + workspaceLabel(workspaceFilter, t)
              : t("filter.path"),
            disabled: !hasItems || importing,
            searchPlaceholder: t("combobox.search.workspace"),
            noMatchLabel: t("combobox.noMatch"),
            options: [{ value: "", label: t("filter.all") }].concat(
              workspaceOptions.map((o) => {
                const label = workspaceLabel(o.key, t);
                // 路径与显示名不同才当副标题（同名时画一遍就够）
                return { value: o.key, label, sub: o.path && o.path !== label ? o.path : null };
              })),
            onChange: onWorkspaceFilter,
          })),
        // 「筛选：时间」：短菜单（4 项）不挂搜索框
        h("span", { style: style.filterGroup },
          h(SearchableSelect, {
            value: timeFilter, title: t("filter.time"), colors: COLORS,
            searchable: false,
            triggerLabel: timeFilter
              ? t("filter.time") + " · " + t("filter.time." + timeFilter)
              : t("filter.time"),
            disabled: !hasItems || importing,
            options: TIME_FILTERS.map((v) => ({ value: v, label: t("filter.time." + (v || "all")) })),
            onChange: onTimeFilter,
          })));
    }

    /** 底栏：翻页（只留图标、不套框；页码由页控件承担，点开是网格；只有一页时整组不显示）+
     *  状态文案（扫描中报进度，完成后报总数）+ 每页条数（总数不足最小档时换档没有意义，连
     *  选择器一起隐藏）。onPage 收页码或 (p) => 页码 的更新函数（即 setPage）。 */
    function PageBar({ t, page, totalPages, onPage, barText, displayTotal, pageSize, onPageSize, importing }) {
      const style = STYLES;
      const hoverOn = (e) => { e.currentTarget.style.background = COLORS.hover; };
      const hoverOff = (e) => { e.currentTarget.style.background = "transparent"; };
      return h("div", { style: style.pageBar },
        totalPages > 1 && h("button", {
          type: "button", style: style.pageNavBtn, disabled: page === 0 || importing,
          onClick: () => onPage((p) => Math.max(0, p - 1)),
          title: t("previous"), "aria-label": t("previous"),
          onMouseEnter: hoverOn,
          onMouseLeave: hoverOff,
        }, h(Icon, { name: "chevronLeft", size: 16 })),
        totalPages > 1 && h(PageJump, { page, totalPages, onPick: onPage }),
        totalPages > 1 && h("button", {
          type: "button", style: style.pageNavBtn, disabled: page >= totalPages - 1 || importing,
          onClick: () => onPage((p) => Math.min(totalPages - 1, p + 1)),
          title: t("next"), "aria-label": t("next"),
          onMouseEnter: hoverOn,
          onMouseLeave: hoverOff,
        }, h(Icon, { name: "chevronRight", size: 16 })),
        h("span", { style: style.pageInfo, title: barText }, barText),
        displayTotal >= PAGE_SIZES[0] && h("span", { style: style.pageSizeLabel }, t("pageSize")),
        displayTotal >= PAGE_SIZES[0] && h("select", {
          style: { ...style.select, flex: "none", width: "86px", padding: "4px 6px", fontSize: "12px" },
          value: pageSize,
          disabled: importing,
          onChange: (e) => {
            const v = e.target.value;
            onPageSize(v === ALL_PAGE_SIZE ? ALL_PAGE_SIZE : Number(v));
          },
        }, PAGE_SIZES.map((n) => h("option", {
          key: n, value: n,
        }, n === ALL_PAGE_SIZE ? t("pageSizeAll") : String(n)))));
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    /** 发现 + 导入面板：来源过滤 + 按工作区文件夹分组 + 单选/多选导入 */
    function DiscoveryPanel() {
      const t = useTranslate();
      const colors = COLORS;
      const style = STYLES;
      const badgeOverlay = overlayColorForAccent(colors.accent);
      // 容器宽度（侧边栏可拖宽）：低于阈值时按钮/分页降级为图标、页码压缩为 1/N。
      const [rootRef, panelWidth] = useContainerWidth();
      const narrow = panelWidth !== 0 && panelWidth < NARROW_MAX_WIDTH;
      const [source, setSource] = useState(SOURCES[0]);
      // 「导入到」：dsh3 / dsh4 = 建指定代次的 DSH 会话（默认按探测到的宿主版本）；
      // claude / codex / kimi / opencode → 转投到目标工具格式。
      // "" = 未定：首个扫描响应带回 dshVersion 后按宿主版本定项（见 onDshVersion）
      const [target, setTarget] = useState("");
      const [workspaceFilter, setWorkspaceFilter] = useState("");
      const [timeFilter, setTimeFilter] = useState(TIME_FILTERS[0]); // '' = 不筛选
      const [selected, setSelected] = useState(new Map()); // key → 会话条目
      const [importing, setImporting] = useState(false);
      const [result, setResult] = useState(null);
      const [epoch, setEpoch] = useState(0); // 刷新 / 导入后自增 → 服务端新扫描键
      const [queryInput, setQueryInput] = useState(""); // 搜索框输入（未提交）
      const [query, setQuery] = useState(""); // 已提交的搜索词（请求用）
      const [page, setPage] = useState(0); // 当前页（0 基）
      // 每页条数：默认 500（= PAGE_SIZES 最小档；窗口化后档位大小不影响渲染开销，放大只是少翻几次页）
      const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
      const [collapsed, setCollapsed] = useState(new Set()); // 已折叠的工作区分组名
      const [hot, setHot] = useState(NO_HOT); // 点亮中的会话行与其所在分组（见 nextHot）

      const { items, setItems, stream, error, warnings } = useSessionScan({
        source, query, epoch, t,
        // 每轮扫描开始：清掉上一轮的导入结果、回到第一页
        onStart: () => { setResult(null); setPage(0); },
        // 「导入到」的默认目标跟随探测到的宿主会话格式版本：用户没选过（state 为空）时
        // 首次扫描响应到达即定项——V4 宿主默认 DSH（V4 会话格式），V3 宿主默认 V3。
        onDshVersion: (v) => setTarget((cur) => (cur ? cur : (v >= 4 ? "dsh4" : "dsh3"))),
      });
      const [setListEl, win, listEl] = useListWindow();
      // 换页 / 改每页条数 → 回到列表顶部（否则从第 3 屏切到新页会停在半空）
      useEffect(() => { if (listEl) listEl.scrollTop = 0; }, [listEl, page, pageSize]);
      // 来源/搜索词/工作区变化 → 清空跨页选择（换页/刷新保留选择，支持跨页多选）
      useEffect(() => { setSelected(new Map()); }, [source, query, workspaceFilter, timeFilter]);

      // 显式选了 DSH 来源与 DSH 目标且**代次不同**（V3 ↔ V4）→ 底部多一个「导入所选并
      // 归档旧会话」按钮：导入按目标代次建新会话，同时把源会话在宿主里归档（迁移的收尾）。
      const srcVersion = source === "dsh" ? 3 : source === "dsh4" ? 4 : 0;
      const targetVersion = target === "dsh3" ? 3 : target === "dsh4" ? 4 : 0;
      const migrate = srcVersion !== 0 && targetVersion !== 0 && srcVersion !== targetVersion;

      // 执行导入（单选/多选共用）：POST /api-import/import → 摘要 → 刷新列表状态
      const doImport = async (items, { replace = false, force = false, archiveSources = false } = {}) => {
        if (!items || items.length === 0 || importing) return;
        setImporting(true);
        setResult(null);
        try {
          const r = await postJson("/api-import/import", {
            items, replace: replace === true, force: force === true, archiveSources: archiveSources === true, target,
          });
          if (!r.ok) {
            setResult(r.error || t("error.route"));
            return;
          }
          const data = r.data;
          setResult(importSummary(data, archiveSources, t));
          // 兜底不再静默：被幂等跳过（already-imported）的会话出一条带动作的 Toast，
          // 点「重新导入为新会话」即用 force 再导一次（另铸新会话）。force 轮本身不再提示。
          // 落点与「跳过」合成同一条官方 Toast（shell.overlay 顶部横幅）：面板可能不在
          // 眼前（批量导入时切走 tab / 收起右栏），两件事都得浮出来；动作按钮就是原来
          // 面板内黄条的「忽略警告」。有动作时 holdMs 更长（15s），够点。
          const skipped = force ? [] : alreadyImportedItems(data.results, items);
          // 忽略墓碑挡下的条目同样不能让结果只剩一个「跳过 1」：说清原因，并给一次
          // 「仍然导入」（force 越权）的动作出口（永久解除仍是 /unignore）。
          const ignored = force ? [] : ignoredItems(data.results, items);
          const landed = landingToast(data.results, t);
          const skipLine = skipped.length > 0 ? t("toast.skipped", { n: skipped.length }) : "";
          const ignoredLine = ignored.length > 0
            ? t("toast.ignored", { n: ignored.length, reason: fmtIgnoreReasons(ignoreReasonsOf(data.results), t) })
            : "";
          const toastText = [landed, skipLine, ignoredLine].filter(Boolean).join(t("result.separator"));
          const toastActions = [];
          if (skipped.length > 0) {
            toastActions.push({ label: t("toast.ignore"), onClick: () => doImport(skipped, { force: true }) });
          }
          if (ignored.length > 0) {
            toastActions.push({ label: t("toast.forceImport"), onClick: () => doImport(ignored, { force: true }) });
          }
          showAppToast(toastText, toastActions.length > 0 ? toastActions : null);
          setSelected(new Map());
          const donePath = localImportedPath(data.results, force, archiveSources);
          if (donePath) {
            setItems((prev) => prev.map((s) => (s.sourcePath === donePath ? { ...s, importStatus: "imported" } : s)));
          } else {
            setEpoch((n) => n + 1);
          }
        } catch (err) {
          setResult(t("error.import", { msg: errorText(err) }));
        } finally {
          setImporting(false);
        }
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

      // memo 行的回调：实现随每次渲染更新，但暴露给行的函数引用恒定（否则 memo 白做）
      const rowActions = useRef({});
      rowActions.current = {
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
      const onHot = useCallback((key, only, group) => setHot((prev) => nextHot(prev, key, only, group)), []);
      const onToggle = useCallback((key) => rowActions.current.toggle(key), []);
      const onImport = useCallback((s) => rowActions.current.import(s), []);
      const onCollapse = useCallback((name) => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      }), []);

      // 以下派生数据全部 memo：悬停 / 勾选引起的重渲染（每行一次）不再重算过滤、分组、排序。
      // 大档位（几百上千行）时这一步才是真正的热点。
      // 路径筛选（工作区）+ 时间筛选（最后活跃/创建时间落在窗口内）叠加
      const filteredItems = useMemo(
        () => filterByTime(filterByWorkspace(items, workspaceFilter), timeFilter, Date.now()),
        [items, workspaceFilter, timeFilter],
      );
      const allRows = pageSize === ALL_PAGE_SIZE;
      const totalPages = allRows ? 1 : Math.max(1, Math.ceil(filteredItems.length / pageSize));
      // 当前页窗口 = 工作区筛选后的缓冲切片（服务端不再分页；翻页零重扫）；「全部」档不分页
      const sessions = useMemo(
        () => (allRows ? filteredItems : filteredItems.slice(page * pageSize, (page + 1) * pageSize)),
        [filteredItems, page, pageSize, allRows],
      );
      const workspaceOptions = useMemo(() => buildWorkspaceOptions(items), [items]);
      // 分页文案总数：筛选后的缓冲条数（扫描中即已发现数）
      const displayTotal = filteredItems.length;
      // 底部一条的状态文案：扫描中报进度，扫描完成报总数（合并掉原来列表上方那条独立状态行）
      const scanning = !error && stream.started && !stream.done;
      const barText = scanning
        ? t("scan.status.progress", { n: items.length })
        : t("count.total", { n: displayTotal });
      const groups = useMemo(() => groupSessions(sessions), [sessions]);
      // 有来源扫描失败（库被锁 / 无权限 / 读取器异常）：其余来源照常列出，只在列表上方点名，
      // 免得「没扫到」看起来像「没有会话」
      const scanNotice = useMemo(() => scanWarningNotice(warnings, t, sourceLabel), [warnings, t]);
      // allSelected 是 O(页大小)：无分页时每次渲染都要扫一遍 10 万行 → memo 到 selected/sessions
      const allSelected = useMemo(
        () => sessions && sessions.length > 0 && sessions.every((s) => selected.has(itemKey(s))),
        [sessions, selected],
      );
      const laid = useMemo(() => layoutGroups(groups, collapsed), [groups, collapsed]);

      const toggleAll = () => {
        if (!sessions || sessions.length === 0) return;
        const allKeys = sessions.map(itemKey);
        const everySelected = allKeys.every((k) => selected.has(k));
        setSelected(everySelected ? new Map() : new Map(allKeys.map((k, i) => [k, sessions[i]])));
      };

      const body = h(React.Fragment, null,
          // 来源与落点读成一行：「从 全部来源 导入到 DSH 会话环境」——「从」与「导入到」都是
          // 连接词，两个下拉的触发器只显文本（品牌标 / 锁标只在下拉弹层里出现），否则这句话
          // 会被两段 logo 切成读不通的碎片
          h("div", { style: style.rowPlain },
            h("span", { style: style.rowJoin }, t("from")),
            h(SearchableSelect, {
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
            h("span", { style: style.rowJoin }, t("importTo")),
            h(SearchableSelect, {
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
            : h("div", { style: style.targetHint }, t("target.hint." + target)),
          // 筛选层：搜索词（搜索按钮 / Enter 提交）
          h("div", { style: style.searchRow },
            h("input", {
              style: style.searchInput, value: queryInput, placeholder: t("search.placeholder"),
              onChange: (e) => setQueryInput(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") applySearch(); },
            }),
            h("button", {
              style: narrow ? style.searchIconBtn : style.searchBtn,
              onClick: applySearch, title: t("search"), "aria-label": t("search"),
            }, narrow ? h(Icon, { name: "search" }) : t("search")),
            h("button", {
              style: narrow ? style.iconBtn : style.toolBtn,
              onClick: clearSearch, disabled: (!queryInput && !query) || importing,
              title: t("clearSearch"), "aria-label": t("clearSearch"),
            }, narrow ? h(Icon, { name: "x" }) : t("clearSearch"))),
          h(DiscoveryToolbar, {
            t, narrow, importing, allSelected,
            hasSelection: selected.size > 0,
            canSelectAll: filteredItems.length > 0,
            hasItems: items.length > 0,
            onToggleAll: toggleAll,
            onClearSelection: () => setSelected(new Map()),
            onRefresh: () => setEpoch((n) => n + 1),
            workspaceFilter, workspaceOptions,
            onWorkspaceFilter: (v) => { setWorkspaceFilter(v); setPage(0); },
            timeFilter,
            onTimeFilter: (v) => { setTimeFilter(v); setPage(0); },
          }),
          // 还没拿到第一批数据：居中显示连接提示（拿到数据后状态就交给底部那条）
          !stream.started && !error && h("div", { style: style.status }, t("scan.hint.start")),
          error && h("div", { style: style.error }, error),
          !error && scanNotice && h("div", { style: style.scanNotice, title: scanNotice.title, role: "status" }, scanNotice.text),
          stream.done && !error && filteredItems.length === 0 && h("div", { style: style.status }, query || workspaceFilter ? t("noMatch") : t("noSessions")),
          // 列表容器**恒渲染**（flex:1 撑满剩余高度）：此前 items 为空时整个容器不存在，
          // 底部操作区（结果摘要 + 导入按钮）就会被内容顶到上面去；空列表时它只是没有行。
          !error && h("div", { ref: setListEl, style: style.list },
            items.length > 0 ? laid.map((entry) => h(SessionGroup, {
              key: entry.group.name,
              entry, win, t, importing, selected, badgeOverlay,
              isCollapsed: collapsed.has(entry.group.name),
              hotKey: hot.key,
              groupLit: hot.group === entry.group.name,
              onCollapse, onToggle, onImport, onHot,
            })) : null),
          items.length > 0 && h(PageBar, {
            t, page, totalPages, barText, displayTotal, pageSize, importing,
            onPage: setPage,
            onPageSize: (n) => { setPageSize(n); setPage(0); },
          }),
          // 底部主操作区：导入结果 + 导入所选（列表与分页之外的固定区，滚动时始终可见）。
          // 跳过提示与落点提示都在顶部官方 Toast 里（见 toast.js），不在这里再画一条。
          result && h("div", { style: style.resultBar }, result),
          h("div", { style: style.importBar },
            migrate && h("button", {
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
            h("button", {
              style: { ...style.primaryBtn, opacity: selected.size === 0 || importing ? 0.55 : 1 },
              disabled: selected.size === 0 || importing,
              onClick: () => doImport([...selected.values()].map(toItem)),
            }, importing ? t("importing") : t("import.selected", { n: selected.size }))));
      return h("div", { ref: rootRef, style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, position: "relative" } },
        body);
    }
