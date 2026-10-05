    /** 插件 logo（assets/import.svg 内联，跟随 currentColor 适配明暗主题） */
    function LogoIcon({ size }) {
      const s = size || 16;
      return h("svg", {
        width: s, height: s, viewBox: "0 0 1024 1024", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: { flex: "none" },
        "aria-hidden": true,
      },
        h("path", {
          d: "M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z",
          fill: "currentColor" }),
        h("path", {
          d: "M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z",
          fill: "currentColor" }));
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
      const maskSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Cpath d='M905.309091 628.363636c-27.927273 0-46.545455 18.618182-46.545455 46.545455v223.418182H165.236364V125.672727h200.145454c27.927273 0 46.545455-18.618182 46.545455-46.545454s-18.618182-46.545455-46.545455-46.545455H118.690909c-27.927273 0-46.545455 18.618182-46.545454 46.545455v865.745454c0 27.927273 18.618182 46.545455 46.545454 46.545455h786.618182c27.927273 0 46.545455-18.618182 46.545454-46.545455v-269.963636c0-27.927273-18.618182-46.545455-46.545454-46.545455z' fill='black'/%3E%3Cpath d='M556.218182 558.545455h349.090909v-93.09091h-269.963636l293.236363-269.963636-65.163636-65.163636-307.2 283.927272V116.363636h-93.090909V558.545455h4.654545z' fill='black'/%3E%3C/svg%3E";
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

    /** 触发按钮：三种形态按可用宽度自适应（判定纯函数见 lib/footer-layout.mjs，
     * bundle 不做构建、只能内联同款副本）。
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
    /** 图标形态宽度（与 rail 态同款 36×36 圆钮；与 lib/footer-layout.mjs 同步） */
    const FOOTER_ICON_WIDTH = 36;
    /** 完整形态左右内边距之和（对齐「设置」按钮 padding: 0 10px 0 8px） */
    const FOOTER_LABEL_PADDING = 18;
    /** 量「完整形态需要多宽」的隐藏镜像：脱离文档流 + visibility:hidden（仍参与布局计算）
     * + max-content 宽，因此与按钮当前形态/宽度无关。 */
    const FOOTER_PROBE_STYLE = {
      position: "absolute", visibility: "hidden", pointerEvents: "none",
      width: "max-content", display: "flex", alignItems: "center", gap: "8px",
      fontSize: "14px", lineHeight: "22px", left: 0, top: 0,
    };
    // —— 与 lib/footer-layout.mjs 同步的判定副本（bundle 不 import 模块，各存一份）——
    /** 「整宽条目」判据：同槽条目占到半行以上（半宽入口如 78px 的「检查更新」远低于此线） */
    const FOOTER_WIDE_OCCUPANT_RATIO = 0.5;
    /** 行内条目是否占位：浮层（fixed/absolute）不占行内空间，零尺寸条目（隐藏）不计 */
    const occupiesFooterLane = (entry) => !!entry
      && entry.position !== "fixed" && entry.position !== "absolute"
      && entry.width > 0 && entry.height > 0;
    /** 同槽条目是否本来就是「整宽条目」：与本按钮同处一行只会互相压扁，该换行各占一行 */
    const claimsFooterRow = (entry, rowWidth) => !!entry
      && Number.isFinite(rowWidth) && rowWidth > 0
      && entry.width >= rowWidth * FOOTER_WIDE_OCCUPANT_RATIO;
    /** 行内还剩多少宽度给本按钮（量不到行宽返回 NaN，调用方按「维持现状」处理） */
    const footerLaneAvailable = ({ rowWidth, padding = 0, occupiedWidth = 0, gap = 0, itemCount = 1 }) => (Number.isFinite(rowWidth)
      ? rowWidth - padding - occupiedWidth - gap * Math.max(0, itemCount - 1)
      : NaN);
    /** 形态：'share'（与同槽共享一行）| 'icon'（36×36 圆钮）| 'row'（整宽自占一行） */
    const resolveFooterSize = (facts) => {
      if (facts.rail === true) return "icon";
      if (facts.lane !== true || facts.wrapped === true) return "row";
      const available = Number(facts.available);
      const needed = Number(facts.needed);
      // 量不到（未挂载 / 镜像未渲染）→ 维持共享一行的既有形态
      if (!Number.isFinite(available) || !Number.isFinite(needed) || needed <= 0) return "share";
      return available >= needed ? "share" : "icon";
    };
    /** 是否要把宿主行换成 wrap 让各方各占一整行：同槽有整宽条目而本按钮放不下，或连
     * 36px 图标都放不下（反事实口径，因此在「已注入 wrap → 空间仍不足」之间稳定） */
    const needsFooterWrap = (facts) => {
      if (facts.rail === true || facts.lane !== true) return false;
      const available = Number(facts.available);
      if (!Number.isFinite(available)) return false;
      if (available < FOOTER_ICON_WIDTH) return true;
      const needed = Number(facts.needed);
      if (Number.isFinite(needed) && needed > 0 && available >= needed) return false;
      return facts.wideOccupant === true;
    };
    /** 量出本按钮所在的 footer 行：{ row, lane, wrapped, available, needed, wideOccupant }。
     * 锚点是本按钮自己（ref）——`[data-slot=...]` 槽出口是 display:contents 外壳、没有
     * 盒子，量不到任何东西（见 lib/footer-layout.mjs 的说明）。向上找第一条 flex 行时
     * 跳过 display:contents 外壳（多级嵌套也跳过）与单子元素的普通包裹层；行内条目经
     * 同款展开收集（跳过浮层 / 零尺寸 / 本按钮所在条目），并回报同槽是否有整宽条目。
     * `lane` 表示这条行是横向的：纵排容器（issue #25）与换行容器都如实回报，判定侧按
     * 「不换行时能分到多少」的反事实口径使用。 */
    const footerLaneFacts = (button, probe) => {
      const facts = { row: null, lane: false, wrapped: false, available: NaN, needed: NaN, wideOccupant: false };
      if (!button || typeof getComputedStyle !== "function") return facts;
      const probeRect = probe && probe.getBoundingClientRect();
      if (probeRect && probeRect.width > 0) facts.needed = probeRect.width + FOOTER_LABEL_PADDING;
      let node = button;
      while (node && node.parentElement) {
        const row = node.parentElement;
        const cs = getComputedStyle(row);
        if (cs.display === "contents") { node = row; continue; }
        if (cs.display !== "flex" && cs.display !== "inline-flex") {
          // 单子元素的普通包裹层不是行本身，真正的行还在上面
          if (row.children.length === 1) { node = row; continue; }
          return facts;
        }
        facts.row = row;
        facts.lane = cs.flexDirection.startsWith("row");
        facts.wrapped = cs.flexWrap !== "nowrap";
        if (!facts.lane) return facts;
        let occupiedWidth = 0;
        let itemCount = 1; // 本按钮自己
        let wideOccupant = false;
        const collect = (container) => {
          for (const child of container.children) {
            const childCs = getComputedStyle(child);
            // 槽出口（display:contents）把条目摊进行里：继续展开，别把它当成一个条目
            if (childCs.display === "contents") { collect(child); continue; }
            if (child.contains(button)) continue; // 本按钮所在的条目（含包裹层）不算「其它」
            const rect = child.getBoundingClientRect();
            if (!occupiesFooterLane({ position: childCs.position, width: rect.width, height: rect.height })) continue;
            const marginBox = rect.width + (parseFloat(childCs.marginLeft) || 0) + (parseFloat(childCs.marginRight) || 0);
            occupiedWidth += marginBox;
            itemCount += 1;
            if (claimsFooterRow({ width: marginBox }, row.clientWidth)) wideOccupant = true;
          }
        };
        collect(row);
        facts.wideOccupant = wideOccupant;
        facts.available = footerLaneAvailable({
          rowWidth: row.clientWidth,
          padding: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
          occupiedWidth,
          gap: parseFloat(cs.columnGap) || 0,
          itemCount,
        });
        return facts;
      }
      return facts;
    };
