    // 导入落点 Toast：DSH 有官方 Toast——@deepseek-ai/dsh-client-ui-primitives 的 Toast，
    // 顶部居中的临时横幅，owner 给 holdMs / onDone，组件 key 变化即重开一条。宿主自己的
    // 插件就是这么用的（dsh-client-ui-plugin-manager 在自己的 client bundle 里
    // require 该包，并把 toast 注册进 shell.overlay 的 plugin-manager.refresh-toast）。
    //
    // 插件声明支持 dsh ≥ 0.1.5-rc.1：旧宿主未必有该包（或换了 API），所以这里**缺包就
    // 退回自绘横幅**——一句「导入到哪了」的提示不值得把整个面板拖垮。这条 require 宿主
    // 客户端模块的例外记在 docs/architecture.md D17。
    let HostToast = null;
    try {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      HostToast = primitives && typeof primitives.Toast === "function" ? primitives.Toast : null;
    } catch {
      // 旧宿主没有该包：HostToast 保持 null，走 FallbackToast
      HostToast = null;
    }

    const TOAST_HOLD_MS = 6000;
    // 单一通道：ToastHost 挂在 shell.overlay 上，挂载时把 setter 交给这里，导入流程只调
    // showAppToast(text)——面板不需要知道自己在哪个槽里渲染。
    let toastPush = null;
    let toastSeq = 0;
    function showAppToast(text) {
      const line = typeof text === "string" ? text.trim() : "";
      if (line === "" || !toastPush) return;
      toastSeq += 1;
      toastPush({ seq: toastSeq, text: line });
    }

    function ToastHost() {
      const [toast, setToast] = useState(null);
      useEffect(() => {
        toastPush = setToast;
        return () => { if (toastPush === setToast) toastPush = null; };
      }, []);
      if (!toast) return null;
      if (HostToast) {
        return React.createElement(HostToast, {
          key: toast.seq,
          text: toast.text,
          holdMs: TOAST_HOLD_MS,
          onDone: () => setToast(null),
        });
      }
      return React.createElement(FallbackToast, { key: toast.seq, text: toast.text });
    }

    // 无 primitives 时的自绘横幅：顶部居中、holdMs 后自动消失（位置与官方 Toast 一致）
    function FallbackToast(props) {
      const colors = themeColors();
      const [shown, setShown] = useState(true);
      useEffect(() => {
        const timer = setTimeout(() => setShown(false), TOAST_HOLD_MS);
        return () => clearTimeout(timer);
      }, []);
      if (!shown) return null;
      return React.createElement("div", {
        role: "status",
        style: {
          position: "fixed",
          top: "12px",
          left: "50%",
          transform: "translateX(-50%)",
          maxWidth: "min(680px, calc(100vw - 48px))",
          padding: "8px 14px",
          borderRadius: "10px",
          background: colors.surface,
          color: colors.text,
          border: "1px solid " + colors.border,
          boxShadow: "0 6px 24px rgba(0, 0, 0, .18)",
          fontSize: "12.5px",
          lineHeight: "1.5",
          zIndex: 60,
          wordBreak: "break-all",
        },
      }, props.text);
    }
