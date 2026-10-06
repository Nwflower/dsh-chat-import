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
    /** 本插件在宿主客户端模块系统里的 entry 名（= package.json name = lib/client.js 里
     *  `__ModuleLoader__.load({ id })` 的那个 id），也是宿主给样式表记账用的包名。 */
    const PLUGIN_ID = "dsh-chat-import";
    /** 本插件自己那张样式表的唯一键（宿主官方前端包同款写法）：重载后靠它认回自己那一张。 */
    const SETTINGS_NAV_PLUGIN_CSS = PLUGIN_ID + "/settings-nav.css";
    /** 别人留下的无标记样式表被挪到这个值上：它不是任何包的 entry 名，因此宿主的认领扫描
     *  与按包名删除都碰不到它（见 parkForeignSheets）。 */
    const FOREIGN_SHEET_PLUGIN = PLUGIN_ID + "/foreign-sheet";

    /** 动态注入设置页导航图标遮罩 CSS：把宿主写死回落的齿轮 SVG 隐藏，并用 ::before
     *  伪元素配合 CSS mask 绘制本插件功能图标（currentColor 随主题与选中高亮色自动同步）。
     *
     *  归属标记（data-plugin / data-plugin-css）是必须的：宿主的客户端模块系统按
     *  data-plugin 属性记账——任何一次前端模块物化都会把文档里所有
     *  `style:not([data-plugin])` 记到正在物化的包名下（claimStyles，扫描就在工厂返回
     *  之后），并在那个包按新 revision 替换入口时按这个名字整批删除（removeOwnedStyles）。
     *  没有标记的样式表会被下一个物化的包收走、再被它删掉；带自己包名标记的只受本插件
     *  自己的重载影响——删掉之后紧随的那次 apply() 会重建（entry.js 的 ctx.effect）。
     *  既有的元素（旧版本留下的无标记元素、或是上一次 apply 建的那张）按自己的
     *  data-plugin-css 或 id 认回并补标记，不新建第二张。 */
    function ensureSettingsNavStyle() {
      if (typeof document === "undefined") return;
      const target = document.head || document.documentElement || document.body;
      let style = document.querySelector('style[data-plugin-css="' + SETTINGS_NAV_PLUGIN_CSS + '"]')
        || document.getElementById(SETTINGS_NAV_STYLE_ID);
      const created = !style;
      if (created) {
        style = document.createElement("style");
        style.id = SETTINGS_NAV_STYLE_ID;
      }
      // 标记先于挂载：parkForeignSheets 的观察者只看无标记的 <style>，先打标记就不会在
      // 自己这里误判（观察者回调是微任务，本就晚于本函数这次同步执行，双保险）。
      style.dataset.plugin = PLUGIN_ID;
      style.dataset.pluginCss = SETTINGS_NAV_PLUGIN_CSS;
      const maskSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E"
        + LOGO_PATHS.map((d) => "%3Cpath d='" + d + "' fill='black'/%3E").join("")
        + "%3C/svg%3E";
      const css = "\n" +
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
      if (style.textContent !== css) style.textContent = css;
      // 元素本身不移除：宿主会在本插件重载时按包名删掉它，下一次 apply() 再重建。
      if (created && target) target.appendChild(style);
    }

    /** 把别人留下的无标记样式表改写到一个不等于任何包名的值上，使本插件的物化不去认领
     *  它们、本插件的重载也不会把它们连带删掉。
     *
     *  为什么需要：宿主的 claimStyles 在**任何**模块物化时把文档里所有未打标签的 <style>
     *  收进正在物化的包名下，而 removeOwnedStyles 在该包重载时整批删除。本插件的面板
     *  重建很频繁（改面板必跑 build:client），于是别人的无标记样式表会被记到
     *  dsh-chat-import 名下、并在本插件重建时一起消失（实测损失：dsh-meme 的两张样式表
     *  被删，表情包界面整份失去样式，只能刷新恢复）。dsh-claude-style 的 mountStylesheet
     *  同款处理。
     *
     *  两个时机缺一不可：模块作用域这一次赶在本插件自己的那次 claimStyles 之前（宿主在
     *  工厂返回之后才扫描）；常驻的 <head> 观察者管本插件之后才出现的那些。
     *  代价：被改写的样式表此后不再被任何包的记账收走——一个指望宿主替它收走自己那张的
     *  插件会因此留下一份旧副本（本插件只动无标记的那些，宿主官方包自建时就带标记）。
     *  局限：在本插件第一次查看文档之前就已经被别人收走的那几张，这里够不到。 */
    function parkForeignSheets() {
      if (typeof document === "undefined") return;
      for (const el of document.querySelectorAll("style:not([data-plugin])")) {
        if (el.id !== SETTINGS_NAV_STYLE_ID) el.dataset.plugin = FOREIGN_SHEET_PLUGIN;
      }
    }
    parkForeignSheets();
    if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
      const sheetHost = document.head || document.documentElement;
      if (sheetHost) new MutationObserver(parkForeignSheets).observe(sheetHost, { childList: true });
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
