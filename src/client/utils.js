    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // 相对时间（列表项「最后活跃 / 导入时间」显示用）：<1 分钟「刚刚」、<1 小时
    // 「N 分钟前」、<24 小时「N 小时前」、<7 天「N 天前」，更早回退绝对时间。
    // 未来时间（时钟偏差）按「刚刚」兜底，不显示负值。绝对时间经 title 保留可查。
    function relTime(ts, t) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const diff = Date.now() - d.getTime();
      if (diff < 60_000) return t("time.justNow");
      if (diff < 3_600_000) return t("time.minutesAgo", { n: Math.floor(diff / 60_000) });
      if (diff < 86_400_000) return t("time.hoursAgo", { n: Math.floor(diff / 3_600_000) });
      if (diff < 7 * 86_400_000) return t("time.daysAgo", { n: Math.floor(diff / 86_400_000) });
      return fmtTime(ts);
    }

    // 上下文 token 数 → 紧凑显示（87K / 1.2M）；非法/缺失返回 null（调用方回退）。
    function fmtTokenCount(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1_000) return Math.round(n / 1_000) + "K";
      return String(Math.round(n));
    }

    const statusLabel = (st, t) => (st === "imported" ? t("status.imported") : st === "partial" ? t("status.partial") : st === "archived" ? t("status.archived") : t("status.notImported"));

    // 会话条目唯一键（format + sourcePath + sessionId；\u0000 不在路径中出现）
    const itemKey = (s) => s.format + "\u0000" + s.sourcePath + "\u0000" + s.sessionId;
    // 列表累积的去重合并（同键保留后到的那条）：宿主分块重发、同一会话在 DSH 里两代各一份、
    // 或扫描器重复产出，都不会让列表出现「成对的行」——那种行还共享 hover/选中态（两者按
    // itemKey 索引），看起来像鬼影。sort 为真时按时间倒序（扫描完成时一次排序）。
    const mergeItems = (prev, batch, sort) => {
      const byKey = new Map(prev.map((s) => [itemKey(s), s]));
      for (const s of batch) byKey.set(itemKey(s), s);
      const merged = [...byKey.values()];
      return sort ? merged.sort(byTimeDesc) : merged;
    };

    // 条目 → /api-import/import 的 items 项（client 来源 id + sourcePath + sessionId
    // + cwd：转投 claude 时导出器需要 cwd 算项目 slug，发现条目上就有）
    const toItem = (s) => ({
      source: FORMAT_SOURCE[s.format] || s.format,
      sourcePath: s.sourcePath,
      sessionId: s.sessionId,
      ...(typeof s.cwd === "string" && s.cwd ? { cwd: s.cwd } : {}),
    });

    // 转投结果摘要（导入到 DSH 之外的目标）：条数 + 落点路径 + 目标工具的使用提示；
    // 「保留 N 个既有会话」是重要事实（转投不会删掉用户原有的 DSH 会话），失败要显式。
    function fmtTransferResult(results, target, t) {
      let files = 0; let kept = 0; let purged = 0; let failed = 0;
      let firstPath = ""; let hint = ""; let firstError = "";
      for (const r of results || []) {
        if (r.status === "failed" && !r.transferred) { failed++; if (!firstError && r.error) firstError = r.error; continue; }
        files += r.transferred || 0;
        kept += r.kept || 0;
        purged += r.purged || 0;
        failed += r.failed || 0;
        for (const f of r.files || []) {
          if (!firstPath && f.filePath) firstPath = f.filePath;
          if (!firstError && f.error) firstError = f.error;
        }
        if (!hint && r.hint) hint = r.hint;
      }
      const bits = [t("transfer.done", { n: files, target: t("target." + target) })];
      if (purged) bits.push(t("transfer.purged", { n: purged }));
      if (kept) bits.push(t("transfer.kept", { n: kept }));
      if (failed) bits.push(t("result.failed", { n: failed }));
      const tail = [firstPath, hint, firstError].filter(Boolean).join("\n");
      return bits.join(t("result.separator")) + (tail ? "\n" + tail : "");
    }

    // 导入完成后的落点提示（Toast 用）：只说「落到哪了」——面板结果栏已有完整计数。
    // 归组字段来自宿主层（lib/workspace-group.mjs）：workspace / workspaceCreated /
    // ungrouped；转投（非 DSH 目标）落点是写出的文件路径。
    function landingToast(results, t) {
      const paths = [];
      let created = false;
      let ungrouped = 0;
      for (const r of results || []) {
        if (!r) continue;
        if (typeof r.workspace === "string" && r.workspace && paths.indexOf(r.workspace) === -1) paths.push(r.workspace);
        if (r.workspaceCreated) created = true;
        if (typeof r.ungrouped === "number") ungrouped += r.ungrouped;
      }
      if (paths.length > 0) {
        const shown = paths.slice(0, 2).join(t("result.separator")) + (paths.length > 2 ? " …" : "");
        return t("toast.landed", { where: shown })
          + (created ? t("toast.newWorkspace") : "")
          + (ungrouped > 0 ? t("toast.ungrouped", { n: ungrouped }) : "");
      }
      // 转投：写出文件就是落点（第一条足够指出位置，完整清单在面板结果里）
      let written = "";
      for (const r of results || []) {
        for (const f of (r && r.files) || []) {
          if (!written && f && f.filePath) written = f.filePath;
        }
      }
      if (written) return t("toast.written", { where: written });
      return "";
    }

    // 批量结果摘要（single/batch 混合计数；t 为 useTranslate 返回的翻译函数）。
    // reimported：重导另铸副本（用户在 DSH 里续聊过 / 旧记录无基线 / force），
    // 单独计数——它既不是「追加进已有会话」，也不是用户没见过的普通新增。
    // ignored：被忽略墓碑（撤回 / 归档 / 删除的工作区）挡下——单独计数并点名原因。
    // 并进「跳过」时，一条会话都没建的结果会被读成「已处理」（见 lib/ignore.mjs）。
    function ignoreReasonCode(r) {
      if (!r) return "";
      if (typeof r.reason === "string" && r.reason) return r.reason;
      const s = r.skipReason;
      return typeof s === "string" && s.indexOf("ignored:") === 0 ? s.slice("ignored:".length) : "";
    }

    // 忽略原因的去重清单：批量条目只带计数，原因在服务端去重后的 ignoredReasons 里
    function ignoreReasonsOf(results) {
      const codes = [];
      for (const r of results || []) {
        const list = Array.isArray(r && r.ignoredReasons) ? r.ignoredReasons : [ignoreReasonCode(r)];
        for (const code of list) if (code && codes.indexOf(code) === -1) codes.push(code);
      }
      return codes;
    }

    // 原因码 → 面板文案（未知码走兜底文案并原样带出码，不假装认识）
    function fmtIgnoreReasons(codes, t) {
      if (!codes || codes.length === 0) return "";
      const known = ["archived", "retracted", "workspace-deleted"];
      return t("ignore.reasonSuffix", {
        reason: codes.map((code) => known.indexOf(code) !== -1
          ? t("ignore.reason." + code)
          : t("ignore.reason.other", { code })).join(t("result.separator")),
      });
    }

    function fmtImportResult(results, t) {
      const c = { imported: 0, replaced: 0, reimported: 0, already: 0, appended: 0, skipped: 0, ignored: 0, failed: 0, images: 0, imagesDegraded: 0, ungrouped: 0, workspaceCreated: 0 };
      for (const r of results || []) {
        if (r.status === "failed") { c.failed++; continue; }
        c.images += r.images || 0;
        c.imagesDegraded += r.imagesDegraded || 0;
        // 归组：未归组的会话仍在，只是落在侧栏「未分组」——不报出来用户会以为没导入
        c.ungrouped += r.ungrouped || 0;
        if (r.workspaceCreated) c.workspaceCreated++;
        if (r.mode === "batch") {
          c.imported += r.imported || 0;
          c.reimported += r.reimported || 0;
          c.already += r.alreadyImported || 0;
          c.appended += r.appended || 0;
          c.skipped += r.skipped || 0;
          c.ignored += r.ignored || 0;
          c.failed += r.failed || 0;
        } else if (r.status === "imported") {
          if (r.reimported) c.reimported++;
          else c.imported++;
        } else if (r.status === "replaced") c.replaced++;
        else if (r.status === "already-imported") c.already++;
        else if (r.status === "appended") c.appended++;
        else if (r.status === "ignored") c.ignored++;
        else c.skipped++;
      }
      const bits = [];
      if (c.imported) bits.push(t("result.imported", { n: c.imported }));
      if (c.reimported) bits.push(t("result.reimported", { n: c.reimported }));
      if (c.replaced) bits.push(t("result.replaced", { n: c.replaced }));
      if (c.appended) bits.push(t("result.appended", { n: c.appended }));
      if (c.already) bits.push(t("result.already", { n: c.already }));
      if (c.skipped) bits.push(t("result.skipped", { n: c.skipped }));
      // 忽略墓碑与「跳过」分开报，并带上原因（撤回 / 归档 / 删除的工作区）
      if (c.ignored) bits.push(t("result.ignored", { n: c.ignored }) + fmtIgnoreReasons(ignoreReasonsOf(results), t));
      if (c.failed) bits.push(t("result.failed", { n: c.failed }));
      // 图片：落成宿主附件与降级占位分开报（服务端 images / imagesDegraded，批量与单项同口径）
      if (c.images) bits.push(t("result.images", { n: c.images }));
      if (c.imagesDegraded) bits.push(t("result.imagesDegraded", { n: c.imagesDegraded }));
      // 归组：新建了工作区（侧栏会多出一个分组）与未归组（落在「未分组」）都要说出来
      if (c.workspaceCreated) bits.push(t("result.workspaceCreated", { n: c.workspaceCreated }));
      if (c.ungrouped) bits.push(t("result.ungrouped", { n: c.ungrouped }));
      return t("result.done", { bits: bits.length ? bits.join(t("result.separator")) : t("result.nochange") });
    }

    // 健壮 JSON 读取：先取文本再解析，空/非 JSON 响应返回 null——避免 resp.json()
    // 对空响应抛 "Failed to execute 'json'…Unexpected end of JSON input" 原始异常
    // （面板应给出可读错误，而不是把浏览器异常直接亮给用户）。
    const readJson = async (resp) => {
      try {
        return JSON.parse(await resp.text());
      } catch {
        return null;
      }
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 面板内联解析 Worker（Blob）：把响应文本的 JSON.parse 移出主线程——主线程只
    // 接收已解析的小块数组（结构化克隆），扫描期滚轮 / 其余 UI 不被大 JSON 解析占
    // 用。Worker 被环境拦截（CSP 等）或运行时出错时逐次回退主线程解析，面板不受影响。
    let parseWorker = null;
    const ensureParseWorker = () => {
      if (parseWorker) return true;
      try {
        if (typeof Worker === "undefined") return false;
        const src = "self.onmessage=function(e){try{self.postMessage({ok:true,data:JSON.parse(e.data)})}catch(err){self.postMessage({ok:false,error:String(err&&err.message||err)})}};";
        const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
        worker.onerror = () => { parseWorker = null; };
        parseWorker = worker;
        return true;
      } catch {
        return false;
      }
    };
    const workerParse = (text) => new Promise((resolve) => {
      const worker = parseWorker;
      const done = (result) => {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
        resolve(result);
      };
      const onMsg = (ev) => done(ev.data);
      const onErr = () => done({ ok: false, error: "worker error" });
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      worker.postMessage(text);
    });
    // 面板响应解析：优先 Worker 线程（零主线程大解析），不可用回退主线程
    const parsePanelResponse = async (resp) => {
      const text = await resp.text();
      if (ensureParseWorker()) {
        try {
          const r = await workerParse(text);
          if (r && r.ok === true) return r.data;
        } catch {
          // worker 会话异常 → 走主线程解析兜底
        }
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    // 面板 → 宿主 /api-import/* 路由的统一 POST：JSON 请求体 + 健壮解析（默认 readJson；
    // 扫描传 parsePanelResponse 走 Worker）。返回 { ok, data, error, status }：ok = 响应体
    // ok === true；error = 服务端给的 error 文本（没有为 null，调用方各自套兜底文案）；status =
    // HTTP 状态码。请求本身失败（网络中断 / 连接被拒 / 读响应体中断）照常 reject，由调用方
    // 按各自口径报错（errorText 取可读消息）。
    async function postJson(path, body, parse = readJson) {
      const resp = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body),
      });
      const data = await parse(resp);
      return {
        ok: !!data && data.ok === true,
        data,
        error: data && typeof data.error === "string" && data.error ? data.error : null,
        status: resp.status,
      };
    }
    // 异常 → 可读文本（Error 取 message，其余原样转字符串）
    const errorText = (err) => String((err && err.message) || err);

    function Toggle({ on, onChange, colors }) {
      return h("button", {
        type: "button",
        onClick: () => onChange(!on),
        style: {
          width: "40px", height: "22px", borderRadius: "999px", border: "none", cursor: "pointer",
          background: on ? colors.accent : colors.border, position: "relative", flex: "none",
        },
      }, h("span", {
        style: {
          position: "absolute", top: "2px", left: on ? "20px" : "2px", width: "18px", height: "18px",
          borderRadius: "50%", background: colors.accentForeground, transition: "left .12s ease",
        },
      }));
    }
