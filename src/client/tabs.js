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

      // 清理空工作区：只删本插件建过且已无成员的工作区登记（专用导入工作区 + 旧实现为
      // 源目录误建的空工作区），目录与会话日志保留。删的是侧栏里点不动的空分组。
      const runCleanup = async () => {
        setBusy(true);
        setNote(null);
        setError(null);
        try {
          const resp = await fetch("/api-import/workspaces/cleanup", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
          });
          const data = await readJson(resp);
          if (data && data.ok === true) setNote(t("history.cleanup.done", { n: data.count || 0 }));
          else setError((data && data.error) || t("error.route"));
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
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
              style: style.toolBtn,
              disabled: busy || loading,
              title: t("history.cleanup.title"),
              onClick: runCleanup,
            }, t("history.cleanup")),
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
