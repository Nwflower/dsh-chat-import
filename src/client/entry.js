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
