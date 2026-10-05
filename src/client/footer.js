    /** 插件 logo（assets/import.svg）的两条路径（viewBox 0 0 1024 1024）：LogoIcon 的内联
     *  绘制与设置导航图标的 CSS mask 共用这一份。路径里只有数字 / 字母 / 空格 / . -，拼进
     *  data URI 不需要额外编码。 */
    const LOGO_PATHS = [
      "M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z",
      "M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z",
    ];

    /** 插件 logo（跟随 currentColor 适配明暗主题） */
    function LogoIcon({ size }) {
      const s = size || 16;
      return h("svg", {
        width: s, height: s, viewBox: "0 0 1024 1024", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: { flex: "none" },
        "aria-hidden": true,
      }, ...LOGO_PATHS.map((d) => h("path", { d, fill: "currentColor" })));
    }

    /** 右侧栏 guide 胶囊图标（tab 类型注册的 guide entry icon，组件面收 {size} 按需
     *  缩放；胶囊内以 currentColor 呈现，随主题与选中态自动适配）。 */
    function ImportGlyph(props) {
      const size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return h(LogoIcon, { size });
    }

    const SETTINGS_NAV_MARKER = "data-dsh-chat-import-settings-nav";
    const SETTINGS_NAV_STYLE_ID = "dsh-chat-import-settings-nav-style";

    /** 动态注入设置页导航图标遮罩 CSS：把宿主写死回落的齿轮 SVG 隐藏，并用 ::before
     *  伪元素配合 CSS mask 绘制本插件功能图标（currentColor 随主题与选中高亮色自动同步）。 */
    function ensureSettingsNavStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(SETTINGS_NAV_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = SETTINGS_NAV_STYLE_ID;
      const maskSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E"
        + LOGO_PATHS.map((d) => "%3Cpath d='" + d + "' fill='black'/%3E").join("")
        + "%3C/svg%3E";
      style.textContent = "\n" +
        "[" + SETTINGS_NAV_MARKER + "] > svg:first-child {\n" +
        "  display: none !important;\n" +
        "}\n" +
        "[" + SETTINGS_NAV_MARKER + "]::before {\n" +
        "  content: '';\n" +
        "  flex: none;\n" +
        "  width: 16px;\n" +
        "  height: 16px;\n" +
        "  background: currentColor;\n" +
        "  -webkit-mask: url(\"" + maskSvg + "\") center / contain no-repeat;\n" +
        "  mask: url(\"" + maskSvg + "\") center / contain no-repeat;\n" +
        "}\n";
      const target = document.head || document.documentElement || document.body;
      if (target) target.appendChild(style);
    }

    /** 监听设置弹窗导航行，给匹配当前插件分区文案的按钮添加属性标记（对齐 omdsh-dev/DSH-better-sidebar 实践）。
     *  不篡改 React DOM 结构，安全无崩溃；销毁时解绑监听并清空属性。 */
    function registerSettingsNavIcon(labelResolver) {
      if (typeof document === "undefined") return () => {};
      ensureSettingsNavStyle();
      let disposed = false;

      const sync = () => {
        if (disposed) return;
        const currentLabel = typeof labelResolver === "function" ? labelResolver().trim() : "";
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (const button of buttons) {
          const matches = currentLabel.length > 0 && button.textContent && button.textContent.trim() === currentLabel;
          if (matches) button.setAttribute(SETTINGS_NAV_MARKER, "");
          else button.removeAttribute(SETTINGS_NAV_MARKER);
        }
      };

      sync();
      let observer = null;
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }

      return () => {
        disposed = true;
        if (observer) observer.disconnect();
        try {
          const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
          for (const el of marked) el.removeAttribute(SETTINGS_NAV_MARKER);
        } catch (_) {}
      };
    }

    /** 触发按钮：三种形态按可用宽度自适应（量法 measureFooterLane 与判定 resolveFooterSize /
     * needsFooterWrap 都在 lib/footer-layout.mjs，构建时原样内联进 bundle，与测试同一份）。
     *
     * footer 槽是宿主 ui-sidebar 的一条不换行 flex 行（`.footerActions`），同槽条目之间
     * 抢这条行。此前按①选择器白名单认「占用者是谁」②按 `[data-slot=...]` 槽元素内容被裁
     * 判定，两条都已失效：锚点并不是本按钮——DSH 的 slot 出口是 ui-renderer 的
     * `SlotOutlet`，一个 `display:contents` 外壳（所有条目都渲染在它内部、外壳自己没有
     * 盒子：Chromium 实测 clientWidth/scrollWidth = 0/0、rect 全 0、父元素 children = 1），
     * 于是「内容被裁」恒为 false、「同槽条目」恒为 0 个，判定在生产里恒不命中
     * （#31 / #35 / #39 / #43 同一类问题的四次复发）。
     *
     * 现在只按布局事实判定，与「占用者是谁」无关：以本按钮自己的 ref 为锚点上溯到真正的
     * flex 行，量「还剩多少宽度给我」（available = 行内容宽 − 同槽其它条目占位 − 行间距 −
     * 行内边距）与「完整形态需要多宽」（needed，由按钮内一个脱离文档流的隐藏镜像量出，
     * 与按钮当前形态无关，因此判定不会自我振荡）：
     *   share — 放得下 → `flex: 1 1 auto` 与同槽条目共享一行（issue #31 的预期行为）；
     *   icon  — 放不下 → 36×36 圆钮（图标保留，文字进 title / aria-label），绝不截断、
     *           不遮挡、不动宿主布局；rail（wide=false）态同款；
     *   row   — 换行容器 / 纵排容器（issue #25）/ 找不到可共享的行 → 整宽自占一行。
     * 唯一的宿主写操作：连 36px 图标都放不下时（同槽有不可收缩的整宽条目）才把行换成
     * `wrap`、自己独占一行（0.10.1 起对整宽占用者的既有处理），卸载时还原；该判定用
     * 「不换行时能分到多少」的反事实口径，因此在「已注入 wrap → 空间仍不足」之间稳定。
     * 样式对齐设置按钮（透明底、12px 圆角、16px 图标 + 文字、悬停浅底），图标用插件 logo。
     */
    /** 量「完整形态需要多宽」的隐藏镜像：脱离文档流 + visibility:hidden（仍参与布局计算）
     * + max-content 宽，因此与按钮当前形态/宽度无关。 */
    const FOOTER_PROBE_STYLE = {
      position: "absolute", visibility: "hidden", pointerEvents: "none",
      width: "max-content", display: "flex", alignItems: "center", gap: "8px",
      fontSize: "14px", lineHeight: "22px", left: 0, top: 0,
    };
