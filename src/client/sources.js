    // 来源下拉（'' = 全部来源；与 lib/discovery.mjs 的 FORMATS 对应，claude-code →
    // claude）。chatgpt 无默认数据根，仅显式 path 可发现。
    const SOURCES = [
      // DSH 两代置顶（紧随「全部来源」）：这是本插件自己的会话格式，最常被用来做迁移/续聊
      "", "dsh", "dsh4", "claude-code", "codex", "chatgpt", "cursor", "gemini", "antigravity", "reasonix",
      "opencode", "mimocode", "teleagent", "kilocode", "zcode", "grokbuild", "openclaw", "pi", "hermes", "kimi", "qoder", "workbuddy", "qwen", "trae", "vibe", "continue", "cline", "goose", "zed", "crush",
    ];
    // 「导入到」下拉：dsh3 / dsh4 = 建指定代次的 DSH 会话日志（宿主按 header.version 落盘），
    // 默认项由探测到的宿主版本决定（面板在首个扫描响应里带回 dshVersion）。其余值 = 转投到
    // 该工具自己的格式（服务端 lib/transfer.mjs，与 export_chat 的目标保持一致）。值顺序 = 展示顺序。
    const IMPORT_TARGETS = ["dsh3", "dsh4", "claude", "codex", "kimi", "opencode"];
    // discovery format 短名 → 客户端来源 id（构建 /api-import/import 的 items）。
    const FORMAT_SOURCE = {
      claude: "claude-code", codex: "codex", chatgpt: "chatgpt", cursor: "cursor",
      gemini: "gemini", antigravity: "antigravity", reasonix: "reasonix", opencode: "opencode", mimocode: "mimocode", teleagent: "teleagent", kilocode: "kilocode", zcode: "zcode",
      grokbuild: "grokbuild", openclaw: "openclaw", pi: "pi", hermes: "hermes",
      kimi: "kimi", qoder: "qoder", workbuddy: "workbuddy", qwen: "qwen", trae: "trae", vibe: "vibe", continue: "continue", cline: "cline", goose: "goose", zed: "zed", crush: "crush", dsh: "dsh", dsh4: "dsh4",
    };
    // 来源展示名（产品名不翻译）
    const SOURCE_LABELS = {
      "claude-code": "Claude", codex: "Codex", chatgpt: "ChatGPT", cursor: "Cursor",
      gemini: "Gemini CLI", antigravity: "Antigravity", reasonix: "Reasonix", opencode: "OpenCode", mimocode: "MimoCode",
      teleagent: "TeleAgent",
      kilocode: "Kilo Code",
      zcode: "ZCode", grokbuild: "Grok Build", openclaw: "OpenClaw", pi: "Pi",
      hermes: "Hermes", kimi: "Kimi CLI", qoder: "Qoder CLI", workbuddy: "WorkBuddy",
      qwen: "QwenWork", trae: "Trae Work", vibe: "Mistral Vibe", continue: "Continue", cline: "Cline", goose: "Goose", zed: "Zed", crush: "Crush",
      // DSH 按会话日志代次拆两项（与 discovery 的 format 一一对应）：V0–V3 归 "dsh"，V4+ 归 "dsh4"。
      // 这里是中性短名（会话行提示/aria 用）；下拉里的完整展示名（「DSH V3 会话格式」）走 i18n。
      dsh: "DSH V3", dsh4: "DSH V4",
    };
    // 来源 id → 标键（SOURCE_LOGOS / SOURCE_BADGES 都按 discovery format 短名键控）：
    // claude-code 的键是 claude；dsh4（DSH V4）与 dsh 共用同一个 DSH 标；其余同名。
    // 两个表都查不到时由 BrandMark 按首字母兜底。
    const SOURCE_MARK_KEY = { "claude-code": "claude", dsh4: "dsh" };
    // 只有连项目仓库里都没有可用矢量标的来源才在这里手绘（有官方标的走 SOURCE_LOGOS，见
    // logos.js）：白色圆角卡 + 品牌标 / 品牌色缩写。目前只剩 WorkBuddy（原仓库已不可达）、
    // TeleAgent（TeleAI 产品页无矢量标）、Crush（仓库里只有演示 GIF / PNG，没有矢量标）。
    // SVG 字符串为静态受信标记，经 dangerouslySetInnerHTML 注入。
    const SOURCE_BADGES = {
      workbuddy: { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 280 280\" width=\"100%\" height=\"100%\">\n<g clip-path=\"url(#clip0_744_3208)\">\n<rect width=\"280\" height=\"280\" rx=\"60.4211\" fill=\"url(#paint0_linear_744_3208)\"/>\n<g filter=\"url(#filter0_f_744_3208)\">\n<circle cx=\"88.2504\" cy=\"244.86\" r=\"98.5668\" fill=\"#32E6B9\" fill-opacity=\"0.4\"/>\n</g>\n<g filter=\"url(#filter1_f_744_3208)\">\n<circle cx=\"223.384\" cy=\"290.328\" r=\"90.0931\" fill=\"#FFE355\" fill-opacity=\"0.49\"/>\n</g>\n<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M204.15 6.89352C206.896 4.43111 207.061 4.33611 209.074 4.21524C212.336 3.97692 215.324 5.54248 220.41 10.1729C232.291 20.9692 248.834 43.1654 259.119 62.1205L263.093 69.4768L268.707 72.2672C274.126 75.0055 283.015 80.6198 286.728 83.6308C288.407 85.0191 288.642 85.0483 290.388 84.3692C298.267 81.3008 309.553 85.3675 319.508 94.9178C328.47 103.507 337.052 118.181 340.34 130.429C340.82 132.4 341.458 136.638 341.69 139.794C342.44 150.876 338.886 159.726 332.042 163.733C330.644 164.54 330.551 164.759 330.59 168.245C330.905 184.841 326.432 201.406 317.445 217.561C307.301 235.7 289.238 254.464 264.791 272.142C251.663 281.695 220.604 299.792 206.561 306.145C172.92 321.29 145.952 327.1 122.527 324.23C108.554 322.537 92.7397 317.083 83.3819 310.752C80.9182 309.049 80.5286 308.944 78.6462 309.483C68.6285 312.36 55.5086 306.447 44.3628 294.075C39.9174 289.129 32.743 276.986 30.417 270.488C25.0365 255.281 26.1061 241.558 33.273 233.363C35.1245 231.252 35.1835 231.163 34.7791 227.614C34.1112 221.804 33.808 213.206 34.1131 207.656L34.3541 202.472L26.5713 188.706C14.5194 167.262 6.8648 149.255 3.91152 135.497C2.35249 127.954 2.44923 124.607 4.36401 122.131C5.52945 120.635 9.35191 119.087 13.9599 118.236C25.5602 116.199 50.8596 118.043 79.0059 123.012L81.9295 123.517L88.3537 117.834C99.0194 108.386 106.105 103.089 119.168 94.9439C132.783 86.4254 148.148 79.4181 165.452 73.8693L171.004 72.09L174.054 64.0775C184.981 35.233 196.172 13.9675 204.15 6.89352ZM112.625 154.702C100.275 161.832 94.0999 165.397 89.5627 169.393C71.1894 185.572 64.3228 211.198 72.145 234.396C74.0767 240.125 77.642 246.3 84.7719 258.65C91.9018 270.999 95.4667 277.173 99.4619 281.711C115.641 300.084 141.267 306.95 164.466 299.128C170.194 297.197 176.369 293.631 188.719 286.501L259.76 245.486C272.109 238.356 278.284 234.791 282.821 230.796C301.194 214.617 308.061 188.99 300.239 165.792C298.307 160.063 294.742 153.889 287.612 141.54C280.482 129.19 276.917 123.015 272.922 118.478C256.743 100.104 231.116 93.2378 207.918 101.06C202.19 102.992 196.015 106.557 183.666 113.687L112.625 154.702Z\" fill=\"url(#paint1_linear_744_3208)\"/>\n<rect x=\"119.473\" y=\"204.341\" width=\"28.0633\" height=\"58.2852\" rx=\"14.0316\" transform=\"rotate(-30 119.473 204.341)\" fill=\"white\"/>\n<rect x=\"195.186\" y=\"160.627\" width=\"28.0633\" height=\"58.2852\" rx=\"14.0316\" transform=\"rotate(-30 195.186 160.627)\" fill=\"white\"/>\n</g>\n<defs>\n<filter id=\"filter0_f_744_3208\" x=\"-104.414\" y=\"52.1958\" width=\"385.327\" height=\"385.328\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"47.0486\" result=\"effect1_foregroundBlur_744_3208\"/>\n</filter>\n<filter id=\"filter1_f_744_3208\" x=\"56.2884\" y=\"123.233\" width=\"334.191\" height=\"334.192\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"38.5013\" result=\"effect1_foregroundBlur_744_3208\"/>\n</filter>\n<linearGradient id=\"paint0_linear_744_3208\" x1=\"140\" y1=\"0\" x2=\"140\" y2=\"280\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"#0EC8A9\"/>\n<stop offset=\"1\" stop-color=\"#01C886\"/>\n</linearGradient>\n<linearGradient id=\"paint1_linear_744_3208\" x1=\"106.647\" y1=\"62.5482\" x2=\"237.632\" y2=\"289.42\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"white\" stop-opacity=\"0.8\"/>\n<stop offset=\"0.437689\" stop-color=\"white\"/>\n</linearGradient>\n<clipPath id=\"clip0_744_3208\">\n<rect width=\"280\" height=\"280\" rx=\"60.4211\" fill=\"white\"/>\n</clipPath>\n</defs>\n</svg>\n" },
    };
    // Crush 同为缩写卡（与 assets/agents/crush.svg 同款）
    SOURCE_BADGES.crush = { color: "#5A56E0", text: "Cr" };
    // TeleAgent（星辰超级智能体）与 Trae 无公开矢量品牌标 → 缩写卡
    SOURCE_BADGES.teleagent = { color: "#0B57D0", text: "TA" };
    // Trae 的官方图标不在当前静态图标包中 → 使用中性缩写卡，避免伪造品牌标。
    SOURCE_BADGES.trae = { color: "#3B82F6", text: "Tr" };
    // Mistral Vibe 使用品牌橙色缩写卡
    SOURCE_BADGES.vibe = { color: "#F97316", text: "Vi" };
    // 品牌标查询（lobehub 官方标优先）：SOURCE_LOGOS 在 logos.js 声明，两个表都按 discovery
    // format 短名键控，所以 source id 要先过 SOURCE_MARK_KEY（claude-code → claude）。
    // 返回 null = 这个来源没有官方品牌标，调用方回退 SOURCE_BADGES 的手绘卡。
    const sourceLogo = (key) => SOURCE_LOGOS[SOURCE_MARK_KEY[key] || key] || null;
    // format 短名 → 来源展示名（徽标 title/aria 用）
    const sourceLabel = (format) => SOURCE_LABELS[FORMAT_SOURCE[format]] || format;
    // 分页大小选项（客户端窗口切片；翻页零重扫）
    // 每页条数档位。列表按可视区窗口化渲染（discovery.js），每档只挂载可见的十几行，
    // 实测（React 生产构建、缓冲 3000 条、视口约 16 行）：100 / 500 / 1000 / 2000 档的
    // 换页成本都是 1.1–1.5ms React+DOM + ~0.1ms 布局、DOM 恒为 19 行 / ~360 节点
    //（窗口化之前 500 档要 31ms+21ms、6287 节点，2000 档要 73ms+61ms、24723 节点）。
    // 所以档位尽量给大：翻页次数少了，成本并不增加。
    // 「全部」档 = 不分页。列表窗口化后渲染成本与档位无关（10 万行实测 DOM 恒为 19 行），
    // 代价只有两条：滚动条会很长（10 万行 ≈ 290 万 px），以及常驻内存 ≈1KB/会话。
    const ALL_PAGE_SIZE = "all";
    // 「筛选：时间」档位（'' = 不筛选）；按会话最后活跃（缺省创建时间）落在窗口内过滤
    const TIME_FILTERS = ["", "24h", "7d", "30d"];
    const TIME_FILTER_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
    const PAGE_SIZES = [500, 2000, ALL_PAGE_SIZE];
    // 窄宽阈值：侧边栏可拖宽，面板宽度低于此值时工具栏/分页按钮降级为图标、
    // 页码压缩为「当前页/总页」，搜索/清除按钮只留图标。
    const NARROW_MAX_WIDTH = 400;
    // 时间倒序比较（对齐服务端 discoverSessions 的 lastActiveAt 降序）：
    // 流式期间缓冲按发现顺序纯追加（行不跳动、页面稳定），扫描完成时一次性重排
    //（单次排序事件之后恒定——不做每块全量重排，巨库加载不再占主线程）
    const byTimeDesc = (a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0);
