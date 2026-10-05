    // 颜色一律走 DSH 标准设计令牌（--dsw-alias-* / --dsw-specific-*）：这些 CSS 变量
    // 由 ui-theme 挂在 body 上，随 data-ds-dark-theme 自动切换，插件不再自建明暗色板。
    // 文本用 label-primary/secondary/tertiary 语义色板；按钮/强调用 brand-primary 强调色
    //（即 DSH 主按钮 button-primary-fill 的预设），按钮文字用 label-primary-foreground 反色。
    // 明暗切换全由 CSS 变量完成，这里只是一组常量：模块级定义一次，各组件直接引用。
    const COLORS = Object.freeze({
      bg: "var(--dsw-specific-menu)",
      // 宿主菜单面是**半透明**的（深色 #30313680 / 浅色 #f8f9fa94），它必须和宿主 Menu
      // 一样配一层背景模糊才是一块能读的卡片——少了 backdrop-filter，深色主题下弹层会
      // 真的透出后面的会话列表（浅色主题被皮肤定成了不透明白，所以只有深色会露馅）。
      menuBlur: "var(--dsw-menu-backdrop-filter)",
      elevation: "var(--dsw-elevation-prominent)",
      // 不透明明面：必须挡住下面内容的表面（sticky 分组头、模态卡片）用它，别用半透明的 bg
      surface: "var(--dsw-alias-bg-layer-3)",
      border: "var(--dsw-alias-border-l2)",
      field: "var(--dsw-alias-bg-layer-1)",
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      dimmer: "var(--dsw-alias-label-tertiary)",
      accent: "var(--dsw-alias-brand-primary)",
      accentForeground: "var(--dsw-alias-label-primary-foreground)",
      hover: "var(--dsw-alias-interactive-bg-hover)",
      success: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    });

    // 面板样式表：C 是配色（COLORS）。只在下面算一次得到 STYLES，各组件共用同一份引用。
    const makeStyles = (C) => ({
      row: { display: "flex", gap: "8px", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border },
      // 无分隔线的选择行：来源 / 导入到 / 工作区三行同属一组，行间不画横线
      //（组与下方搜索区的分界由 searchRow 的 borderTop 一条线承担）
      // position: relative —— 下拉弹层对着这一行定位（触发器根节点不定位），弹层宽度 = 行宽，
      // 面板再窄也不会把弹层挤出左/右边界
      // alignItems: baseline —— 触发器与「从 / 导入到 / 工作区」这些 label 按文字基线对齐，
      // 三者的字形底边在同一条线上（居中会因为各自盒高不同而错开）
      rowPlain: { position: "relative", display: "flex", gap: "8px", alignItems: "baseline", padding: "8px 12px" },
      // 来源与落点之间的连接词（「导入到」），把两个下拉读成一句话
      rowJoin: { color: C.dim, flex: "none", fontSize: "13px", lineHeight: "20px", whiteSpace: "nowrap" },
      targetHint: { padding: "0 16px 10px", fontSize: "12px", color: C.dimmer, lineHeight: 1.5 },
      select: {
        flex: "1", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "6px 8px", fontSize: "13px", outline: "none",
      },
      // 下拉触发器：无边框、无输入框外观（claude-style 模型选择器同款）——hover / 展开时
      // 由调用方补一层背景矩形（颜色走 colors.hover，即 --dsw-alias-interactive-bg-hover，
      // 皮肤里被重定向到它自己的 hover 色）。矩形的宽度贴着内容，所以这里不 flex-grow。
      // 触发器根节点：只做尺寸约束，不定位（弹层挂在行上），也不占满行——芯片贴着内容，
      // 同一行可以并排两个下拉
      selectRoot: { display: "flex", minWidth: 0, flex: "0 1 auto" },
      selectTrigger: {
        display: "inline-flex", alignItems: "center", gap: "6px", flex: "0 1 auto",
        maxWidth: "100%", minWidth: 0, height: "28px", padding: "0 6px",
        // 边框 / 圆角 / 文字色与工具栏（筛选）按钮同款：1px border-l2 + 8px 圆角 + label-primary
        background: "transparent", border: "1px solid " + C.border, borderRadius: "8px",
        color: C.text, font: "inherit", fontSize: "13px", fontWeight: 400, lineHeight: "20px",
        textAlign: "left", boxSizing: "border-box",
      },
      // 行首品牌标槽位：定宽 16px——没有品牌标的行（全部来源 / 工作区）也占住这一格，
      // 文字与有标行左对齐
      selectMarkSlot: {
        flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
        width: "16px", height: "16px", borderRadius: "4px", overflow: "hidden",
      },
      selectValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      // 弹层容器：12px 圆角 + 6px 内边距，行距 2px（二级弹层的尺寸口径）
      selectPopover: {
        position: "absolute", top: "calc(100% + 2px)", left: "12px", right: "12px", minWidth: "200px", zIndex: 30,
        display: "flex", flexDirection: "column", gap: "4px", boxSizing: "border-box",
        padding: "6px", background: C.bg, border: "1px solid " + C.border, borderRadius: "12px",
        // 宿主 Menu 同款三件套：半透明面 + 背景模糊 + 官方投影（见 COLORS 的注释）
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation,
      },
      selectSearchRow: { display: "flex", alignItems: "center", gap: "6px", padding: "2px 8px 4px" },
      // 搜索框与列表之间的横线：独立元素、撑满弹层（负外边距抵消容器 6px 内边距）。
      // 颜色用 border-l2——宿主自己的菜单分隔线（Menu.module.css .footer）就是这条，
      // l1 在菜单底色上几乎不可见。
      selectDivider: { height: "1px", flex: "none", background: C.border, margin: "0 -6px" },
      selectSearchIcon: { display: "inline-flex", alignItems: "center", flex: "none", color: C.dimmer },
      selectSearchInput: {
        flex: "1", minWidth: 0, background: "transparent", border: "none", outline: "none",
        color: C.text, fontSize: "13px", lineHeight: "20px", padding: "2px 0",
      },
      // maxHeight 由组件按可用窗口高度写内联（自适应，见 tabs.js），这里只管排版
      selectList: { display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto", overflowX: "hidden" },
      selectRow: {
        display: "flex", alignItems: "center", gap: "8px", width: "100%", minHeight: "30px",
        padding: "3px 8px", background: "transparent", border: "none", borderRadius: "6px",
        color: C.text, font: "inherit", fontSize: "13px", textAlign: "left", cursor: "pointer",
        boxSizing: "border-box",
      },
      // 主标签（文件夹名 / 来源名）不参与收缩：flex 分摊哪怕只压掉 0.0x px，Chromium 也会
      // 立刻画省略号。空间不够时先由副标题（shrink 1000）吃干净；只有标签自己就超过行宽时，
      // max-width 才把它压到行宽并截断。
      selectRowText: {
        flex: "0 0 auto", maxWidth: "100%", minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      // 副标题（工作区的绝对路径）：更淡更小，过长截断（全文留在 title 里）
      selectRowSub: {
        // shrink 取极大值：空间不够时先把副标题（路径）压到 0，再轮到主标签（文件夹名）——
        // flex 的收缩量按「shrink × 基准宽度」分摊，1000 对 1 等于路径先被吃干净
        flex: "0 1000 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: C.dimmer, fontSize: "12px",
      },
      selectCheck: { display: "inline-flex", alignItems: "center", flex: "none", marginLeft: "auto", color: C.accent },
      selectEmpty: { padding: "8px", color: C.dimmer, fontSize: "12px", textAlign: "center" },
      // 搜索行：输入 + 搜索/清除（query 服务端过滤标题/项目/路径）
      searchRow: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderTop: "1px solid " + C.border, borderBottom: "1px solid " + C.border },
      searchInput: {
        flex: "1", minWidth: "0", background: C.field, border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none",
      },
      searchBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "5px 12px", fontSize: "13px", cursor: "pointer",
      },
      // 窄宽降级：搜索按钮只留放大镜图标（accent 底、26×26 居中）
      searchIconBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        width: "26px", height: "26px", padding: "0", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      // 工具栏：全选 / 清空 / 刷新 + 已选计数
      // position: relative —— 末位的工作区筛选在这里，弹层对着工具栏定位（触发器根节点不定位）
      toolbar: { position: "relative", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      toolBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "4px 10px", fontSize: "13px", cursor: "pointer",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
      // 动作按钮组：吃满芯片之外的全部宽度——它的实测宽度就是「按钮还能用多少地方」，
      // 降级判据取它而不是面板宽度（芯片宽度随工作区名变化）
      toolbarActions: { display: "flex", gap: "6px", alignItems: "center", flex: "1 1 auto", minWidth: 0 },
      // 量「文字形态五个按钮需要多宽」的隐藏探针：绝对定位（不参与排版）、不可见、不可点。
      // 用真的 button 元素，字体与真实按钮完全一致
      // width: max-content —— 绝对定位盒默认是 shrink-to-fit，会被工具栏宽度钳住，量出来的
      // 就是「钳制值」而不是「文字形态真正需要多宽」；max-content 让它按内容撑开
      toolbarProbe: {
        position: "absolute", left: 0, top: 0, width: "max-content",
        display: "flex", gap: "6px", visibility: "hidden", pointerEvents: "none", whiteSpace: "nowrap",
      },
      // 窄宽降级的方形图标按钮（工具栏/分页/清除共用，26×26 居中图标）
      iconBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", width: "26px", height: "26px", padding: "0", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", flex: "none",
      },
      // 导入操作条：面板底部的主操作区（列表/分页之下，贴面板底缘），
      // 与列表的分界走上边框；结果摘要紧贴其上方（见 resultBar）
      importBar: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", borderTop: "1px solid " + C.border, flexWrap: "wrap" },
      // 底部导入结果条：紧贴主按钮上方，导入反馈与触发它的按钮相邻
      resultBar: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderTop: "1px solid " + C.border, background: C.field },
      primaryBtn: {
        flex: "1", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "7px 10px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
      },
      // 跳过提示与落点提示都走官方 Toast（shell.overlay，见 src/client/toast.js）——
      // 面板内不再画底部浮层，所以这里没有 toast/toastText/toastAction 三件套。
      result: { padding: "7px 12px", fontSize: "12px", color: C.dim, borderBottom: "1px solid " + C.border, background: C.field },
      // 顶部不留 padding：工作区分组头 sticky 到 top:0 后与列表顶缘齐平，背景
      // 完整盖住背后滚过的行，不再在顶部露出 8px 缝隙泄漏列表背后的内容。
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "0 8px 8px" },
      // 工作区分组头（对标皮肤工作区行）：28px 高、0 6px 内边距、6px 圆角；它是标题不是
      // 目标——悬停不浮背景矩形，提示靠文字变亮 + 悬停才露出的折叠箭头
      group: {
        display: "flex", alignItems: "center", gap: "4px", height: "28px", minHeight: "28px",
        padding: "0 6px", marginTop: "6px", borderRadius: "6px",
        fontSize: "13px", lineHeight: "18px", fontWeight: 500, color: C.dim,
        // 不透明明面：sticky 头必须挡住滚过来的行，半透明的菜单色会透字
        position: "sticky", top: 0, background: C.surface, zIndex: 1, cursor: "pointer",
      },
      groupLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color .12s ease" },
      groupChevron: { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "14px", height: "14px" },
      groupCount: { marginLeft: "auto", fontSize: "11px", fontWeight: 400, color: C.dimmer },
      // 会话行（对标皮肤会话行）：28px 高、0 6px 内边距、6px 圆角、行距 1px
      item: {
        display: "flex", alignItems: "center", height: "28px", minHeight: "28px",
        padding: "0 6px", borderRadius: "6px", marginTop: "1px",
        // 整行即勾选控件（点击 / Enter / 空格）：聚焦环向内收，避免与行的圆角/相邻行粘连
        outlineOffset: "-2px",
      },
      // itemMain 只是标题的布局槽：勾选入口是整行（见 discovery.js 的 SessionRow），
      // 手型 / 聚焦环挂在 item 上。
      itemMain: { flex: "1", minWidth: "0", display: "flex", alignItems: "center" },
      // 标题默认 label-secondary，悬停 / 选中才变 label-primary（皮肤里就是这条规则）
      itemTitle: {
        fontSize: "13px", lineHeight: "18px", margin: "0 4px", color: C.dim,
        transition: "color .12s ease", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      itemTitleActive: { color: C.text },
      // 历史面板仍是两行式条目（沿用旧行样式）
      historyItem: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "8px 10px", borderRadius: "8px", marginBottom: "2px" },
      itemMeta: { color: C.dimmer, fontSize: "12px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      // 行右侧槽位：默认放相对时间，悬停时换成导入按钮——同一个槽位互斥，布局不跳
      rowSlot: {
        position: "relative", flex: "none", display: "flex", alignItems: "center",
        justifyContent: "flex-end", minWidth: "56px", marginLeft: "auto",
      },
      rowTime: { color: C.dimmer, fontSize: "11px", lineHeight: "16px", whiteSpace: "nowrap" },
      // 未悬停 / 未聚焦时的按钮：绝对定位 + 不可见但仍可 Tab 到（聚焦即由行状态点亮）
      rowBtnIdle: {
        position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
        opacity: 0, pointerEvents: "none", background: "transparent", border: "none",
        color: "transparent", padding: "2px 8px", fontSize: "12px", whiteSpace: "nowrap",
      },
      importBtn: {
        flex: "none", background: C.accent, color: C.accentForeground, border: "none", borderRadius: "8px",
        padding: "2px 8px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
      },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      error: { padding: "16px", textAlign: "center", color: C.error },
      // 分页条：上一页 / 页码 / 下一页
      pageBar: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "center", padding: "4px 12px", borderTop: "1px solid " + C.border },
      pageBtn: {
        background: "transparent", border: "1px solid " + C.border, color: C.text,
        borderRadius: "8px", padding: "4px 12px", fontSize: "13px", cursor: "pointer",
      },
      // 底栏状态文案占满中间弹性区，过长截断（title 里有全文）
      // 翻页：无框图标钮（hover 直接改 DOM 背景，不走 state）
      pageNavBtn: {
        flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: "26px", height: "26px", padding: 0, background: "transparent", border: "none",
        borderRadius: "6px", color: C.dim, cursor: "pointer",
      },
      // 页控件（点开是页码网格）：与筛选按钮同款边框
      pageChip: {
        flex: "none", display: "inline-flex", alignItems: "center", gap: "4px", height: "26px",
        padding: "0 8px", background: "transparent", border: "1px solid " + C.border,
        borderRadius: "8px", color: C.text, fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
      },
      // 页码网格（像选集）：贴着底栏向上弹，多页时自身滚动
      pageGrid: {
        position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 30,
        display: "grid", gridTemplateColumns: "repeat(6, 34px)", gap: "4px", maxHeight: "240px",
        overflowY: "auto", padding: "6px", background: C.bg, border: "1px solid " + C.border,
        borderRadius: "12px", boxSizing: "border-box",
        backdropFilter: C.menuBlur, WebkitBackdropFilter: C.menuBlur, boxShadow: C.elevation,
      },
      pageCell: {
        height: "30px", padding: 0, background: "transparent", border: "none", borderRadius: "6px",
        color: C.text, fontSize: "12px", cursor: "pointer",
      },
      pageCellActive: { background: C.accent, color: C.accentForeground, fontWeight: 600 },
      // 工具栏末位的两个筛选控件（路径 / 时间）：与左侧动作按钮用 auto 外边距分开；限宽保护
      // 按钮，且不经 toolBtn（窄面板下也保持文字，不降级成图标）
      toolbarFilter: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px", minWidth: 0, maxWidth: "60%" },
      filterGroup: { display: "flex", alignItems: "center", gap: "4px", minWidth: 0, flex: "0 1 auto" },
      pageInfo: {
        flex: "1 1 auto", minWidth: 0, textAlign: "center", color: C.dimmer, fontSize: "12px",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      },
      pageSizeLabel: { flex: "none", color: C.dimmer, fontSize: "12px", marginLeft: "4px" },
    });
    const STYLES = makeStyles(COLORS);
