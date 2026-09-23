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
