    function ImportButton({ wide }) {
      const t = useTranslate();
      const rail = wide === false;
      const label = t("trigger.label");
      const buttonRef = useRef(null);
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
      // 形态（规范 v1）：'label' / 'icon' / 'row'，判定见内联的 lib/footer-layout.mjs。
      // count 是随形态一起量出的同行占位者数：label 形态的宽度伸缩依赖它（1 个占位者
      // flex-grow 与设置行同宽、≥2 个固定内容宽），故与 mode 同入 state，等值比较覆盖
      // 两个字段。首帧按 label 渲染，mount 后 layout effect 立刻按实测事实修正。
      const [form, setForm] = useState({ mode: "label", count: 1 });
      // 观测面只有「本按钮 + 它所在的那条渲染行」：ResizeObserver 跟行/按钮尺寸变化
      // （侧边栏拖宽、同槽条目增减），MutationObserver 只看这条行的子树（条目挂载/卸载、
      // 宿主或其它插件改 style/class）。不再观察整个文档——那会在每次消息流式渲染时触发
      // 强制布局。判定结果做等值比较，避免观察自身改动造成重渲染循环。check 只读布局
      // 事实、不写宿主 DOM（规范 v1 禁止为同槽平级按钮注入 flex-wrap）。
      // 用 layout effect 而非 effect：首帧就按实测事实落形态，不留一帧被挤压的样子。
      useLayoutEffect(() => {
        const button = buttonRef.current;
        if (!button) return undefined;
        let observed = null; // 正在观测的宿主行
        let ro = null;
        let mo = null;
        const check = () => {
          const facts = measureFooterLane(button);
          // 形态映射（规范 v1 §A/B）：rail 恒 icon；纵排容器（lane=false）或宿主/别人
          // 已做成换行的容器（wrapped=true）→ row 整宽自占一行；否则按「占位者数量 +
          // 行宽」容量判定 label/icon（全有或全无：容量不足时所有占位者都变 icon，各插件
          // 用同一规则同一输入独立求值即收敛，不需要协商）。
          const mode = rail ? "icon"
            : (!facts.lane || facts.wrapped) ? "row"
            : resolveFooterForm(facts.count, facts.rowWidth);
          const next = { mode, count: facts.count };
          setForm((prev) => (prev.mode === next.mode && prev.count === next.count ? prev : next));
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
        };
      }, [rail, label]);
      const mode = form.mode;
      // 图标形态：rail（收起）态与容量不足时同款——36×36、圆角 12px（规范 v1：不是
      // 50%）、单图标 18px 居中，文字保留在 title / aria-label 里（绝不截断、不遮挡、
      // 不动宿主布局）。
      const iconOnly = mode === "icon";
      // 视觉逐项对齐侧边栏「设置」按钮（规范 v1 §A 的宿主 token 基准）：label 形态
      // height 42px、padding 0 9px、gap 6px、圆角 12px、400 14px/22px、16×16 图标；
      // border-inline 3px transparent + background-clip: padding-box 让悬停底色从盒边缘
      // 内退 3px（宿主 --dsh-sidebar-paint-inset）；margin 4px 2px 两态都由插件出
      // （宿主 .footerActions 无 gap/padding）。颜色/悬停走侧边栏同一 CSS 变量
      // （--dsw-alias-label-primary / --dsw-alias-interactive-bg-hover），明暗主题下与
      // 设置按钮一致，不硬编码颜色。
      const baseStyle = {
        boxSizing: "border-box",
        display: "flex", alignItems: "center",
        justifyContent: iconOnly ? "center" : "flex-start",
        gap: iconOnly ? "0" : "6px",
        height: iconOnly ? "36px" : "42px",
        padding: iconOnly ? "0" : "0 9px",
        border: 0,
        borderInline: iconOnly ? "0" : "3px solid transparent",
        backgroundClip: "padding-box",
        borderRadius: "12px",
        margin: "4px 2px",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "inherit", fontSize: "14px", fontWeight: 400, lineHeight: "22px",
        cursor: "pointer",
        overflow: "hidden",
      };
      // 行内尺寸按形态分派（规范 v1 §3.4）：
      // - label 且槽内仅 1 个占位者：flex: 1 1 auto + max-width: 100%，与设置行同宽；
      // - label 且 ≥2 个占位者：flex: 0 0 auto 固定内容宽，不允许 grow 吃别人的空间；
      // - icon：36×36 且 flex: 0 0 auto（不收缩），同槽条目再多也压不没图标；
      // - row：整宽自占一行——wrap 容器里各整宽条目各自成行、order 决定堆叠，auto 宽 +
      //   grow 的条目会挤到同一行破坏堆叠；纵排容器（issue #25）的 flex-basis 沿主轴=
      //   高度解析，grow: 1 会把按钮整高拉伸压住同槽按钮 → flex: 0 0 auto + 整宽。
      //   宽度扣掉两侧 margin（2px×2）：margin 盒恰好占满行，纵排/换行容器里不产生
      //   4px 横向溢出（规范 v1 验收：任何形态不出横向滚动条）。
      const triggerStyle = {
        ...baseStyle,
        ...(iconOnly
          ? { flex: "0 0 auto", width: FOOTER_ICON_WIDTH + "px", minWidth: FOOTER_ICON_WIDTH + "px" }
          : mode === "row"
            ? { flex: "0 0 auto", width: "calc(100% - 4px)" }
            : form.count > 1
              ? { flex: "0 0 auto" }
              : { flex: "1 1 auto", maxWidth: "100%" }),
        whiteSpace: "nowrap",
      };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      if (!visible) return null;
      return h("button", {
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
        // 焦点环（规范 v1：两态都要，outline 2px brand-primary / offset -2px）：内联样式
        // 写不了 :focus-visible，改在 focus 时用 matches 判定——仅键盘焦点显环、鼠标点击
        // 不显；blur 清除。
        onFocus: (e) => {
          let keyboard = false;
          try { keyboard = e.currentTarget.matches(":focus-visible"); } catch (_) { /* 浏览器不认识 :focus-visible 伪类：不显环，等同不支持 */ }
          if (keyboard) {
            e.currentTarget.style.outline = "2px solid var(--dsw-alias-brand-primary)";
            e.currentTarget.style.outlineOffset = "-2px";
          }
        },
        onBlur: (e) => {
          e.currentTarget.style.outline = "";
          e.currentTarget.style.outlineOffset = "";
        },
      },
        h(LogoIcon, { size: iconOnly ? 18 : 16 }),
        !iconOnly && label);
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
          // 规范 v1 §5：会话/数据类插件取 20–39 档，不抢第一位（原 order: 0）。
          { name: "sidebar.footer.action", id: "chat-import", order: 20 },
          ImportButton,
        ));
      // 落点 Toast 的挂载点：官方 shell.overlay（与宿主自己的 toast 同一个槽，例如
      // ui-plugin-manager 的 plugin-manager.refresh-toast）。惰性 inject：槽被声明才注册。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "chat-import.landing-toast", locale: LOCALE_NS, inject: () => ({}) },
          ToastHost,
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
