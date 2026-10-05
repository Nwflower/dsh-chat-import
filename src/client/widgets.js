    // 窄宽降级用内联 SVG 图标（stroke 风格，继承 currentColor 随按钮文字色走明暗主题）。
    // 形状树是不可变的 React 元素：模块级建一次，每次渲染只换外层 svg 的尺寸属性。
    const ICON_SHAPES = {
      checkSquare: h(React.Fragment, null,
        h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        h("path", { d: "m9 12 2 2 4-4" })),
      x: h(React.Fragment, null,
        h("path", { d: "M18 6 6 18M6 6l12 12" })),
      refresh: h(React.Fragment, null,
        h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
        h("path", { d: "M21 3v6h-6" })),
      circle: h("circle", { cx: 12, cy: 12, r: 9 }),
      checkCircle: h(React.Fragment, null,
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "m9 12 2 2 4-4" })),
      chevronLeft: h("path", { d: "m15 18-6-6 6-6" }),
      chevronRight: h("path", { d: "m9 18 6-6-6-6" }),
      search: h(React.Fragment, null,
        h("circle", { cx: 11, cy: 11, r: 7 }),
        h("path", { d: "m21 21-4.3-4.3" })),
      check: h("path", { d: "m4.5 12.5 5 5 10.5-11" }),
      // 折叠箭头（分组头，悬停才出现；收起时整体 rotate(-90deg)）
      chevronDown: h("path", { d: "m6 9 6 6 6-6" }),
    };
    function Icon({ name, size = 14, strokeWidth = 2 }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, style: { flex: "none", display: "block" },
      }, ICON_SHAPES[name]);
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
        return h("span", {
          style: { ...box, fontSize: size + "px", lineHeight: 0 },
          "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.mark },
        });
      }
      const badge = SOURCE_BADGES[key] || { color: "#64748B", text: String(key || "?").slice(0, 2).toUpperCase() };
      if (badge.svg) {
        return h("span", {
          style: box, "aria-hidden": true, dangerouslySetInnerHTML: { __html: badge.svg },
        });
      }
      if (badge.path) {
        return h("svg", {
          viewBox: "-4 -4 32 32", width: size, height: size, "aria-hidden": true, style: box,
        }, h("rect", { x: -4, y: -4, width: 32, height: 32, rx: 6, fill: "#fff" }),
          h("path", { d: badge.path, fill: badge.color }));
      }
      return h("span", {
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
      const mark = h("span", {
        style: { width: size + "px", height: size + "px", fontSize: size + "px", lineHeight: 0, flex: "none", display: "block" },
        "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.mark },
      });
      return h("span", {
        style: { display: "inline-flex", alignItems: "center", gap: LOCKUP_GAP + "px", flex: "0 0 auto", minWidth: 0 },
      },
        mark,
        logo.word
          ? h("span", {
            style: { height: LOCKUP_WORD_H + "px", fontSize: LOCKUP_WORD_H + "px", lineHeight: 0, flex: "none", display: "block" },
            "aria-hidden": true, dangerouslySetInnerHTML: { __html: logo.word },
          })
          : h("span", { style: { fontSize: "13px", lineHeight: "20px", whiteSpace: "nowrap" } }, label),
        logo.word ? h("span", { style: srOnly }, label) : null);
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
      const logo = h(BrandMark, { format, size });
      const overlay = checked
        ? h("div", { style: { position: "absolute", inset: 0, background: palette.overlay || overlayColorForAccent(palette.accent), opacity: 0.6 } })
        : null;
      const check = checked
        ? h("svg", {
          viewBox: "0 0 24 24", width: size, height: size, fill: "none",
          stroke: palette.accent, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
          style: { position: "absolute", inset: 0 }, "aria-hidden": true,
        }, h("circle", { cx: 12, cy: 12, r: 10 }), h("path", { d: "M7.5 12.5l3 3 6-7" }))
        : null;
      return h("div", {
        style: card, title, "aria-hidden": true, // 只作视觉指示；勾选控件在消息体上（有 aria-label / aria-checked）
      }, logo, overlay, check);
    }

    // 元素宽度跟踪（面板容器、工具栏动作组、文字形态探针共用）：侧边栏可拖宽，面板随之
    // 变窄；ResizeObserver 不可用时回退 window resize（宽窄降级仍可用，只是不跟踪拖拽的每
    // 一帧）。返回 [ref, width]，把 ref 挂到要量的元素上。初始 0 = 未知 → 按宽态渲染，
    // 测量后若低于阈值再降级（避免窄面板首帧先闪文字再跳图标）。
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
