/**
 * dsh-synology-calendar — client 半部分（配置页）
 *
 * url / username / calendars 走 settings；密码走本插件 remote（setPassword），
 * 落 dsh credentials（.credentials.yaml，0600）。
 */
window.__ModuleLoader__.load({
  id: "dsh-synology-calendar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

    const CONTRIBUTION = {
      package: "dsh-synology-calendar",
      descriptors: [
        { id: "dsh-synology-calendar#calendar/getConfig", service: "calendar", namespace: "calendar", method: "getConfig", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-synology-calendar#CalendarConfig") },
        { id: "dsh-synology-calendar#calendar/setConfig", service: "calendar", namespace: "calendar", method: "setConfig", invocation: { kind: "direct" }, parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-synology-calendar#SetPayload") }], result: codec("dsh-synology-calendar#SetResult") },
        { id: "dsh-synology-calendar#calendar/setPassword", service: "calendar", namespace: "calendar", method: "setPassword", invocation: { kind: "direct" }, parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-synology-calendar#SetPasswordPayload") }], result: codec("dsh-synology-calendar#SetResult") },
        { id: "dsh-synology-calendar#calendar/passwordState", service: "calendar", namespace: "calendar", method: "passwordState", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-synology-calendar#PasswordState") },
      ],
    };

    const inputStyle = { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", fontSize: 13 };
    const labelStyle = { flex: "0 0 130px", fontWeight: 500, fontSize: 13 };

    function Row({ label, children }) {
      return S.jsxs("div", { style: { margin: "8px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
        S.jsx("label", { style: labelStyle, children: label }),
        children,
      ] });
    }

    function CalendarSection(props) {
      const { getConfig, setConfig, setPassword, passwordState } = props;
      const [cfg, setCfg] = React.useState(null);
      const [pwState, setPwState] = React.useState(null);
      const [password, setPasswordInput] = React.useState("");
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [pwSaved, setPwSaved] = React.useState(false);
      const [showPw, setShowPw] = React.useState(false);

      React.useEffect(() => {
        let current = true;
        setLoading((prev) => prev || cfg === null);
        Promise.all([getConfig(), passwordState()]).then(([c, ps]) => {
          if (!current) return;
          setCfg(c || {});
          setPwState(ps || {});
          setLoading(false);
        }, () => { if (current) { setLoading(false); setError(true); } });
        return () => { current = false; };
      }, [getConfig, passwordState]);

      if (loading) return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取日历配置…" });
      if (error || !cfg) return S.jsxs("div", { children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "读取配置失败" }),
        S.jsx("button", { onClick: () => { setError(false); setLoading(true); setCfg(null); }, children: "重试" }),
      ] });

      const writable = cfg.writable;
      const set = (field, v) => setCfg((c) => ({ ...c, [field]: v }));

      const saveConfig = () => {
        Promise.resolve().then(() => setConfig({
          url: cfg.url, username: cfg.username, calendars: cfg.calendars || {},
        })).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); }).catch((e) => console.error("calendar save failed", e));
      };
      const savePassword = () => {
        Promise.resolve().then(() => setPassword({ password })).then(() => {
          setPasswordInput("");
          setPwState((s) => ({ ...(s || {}), configured: password.length > 0 }));
          setPwSaved(true);
          setTimeout(() => setPwSaved(false), 1500);
        }).catch((e) => console.error("calendar password save failed", e));
      };

      return S.jsxs("div", { style: { maxWidth: 640, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" },
          children: "群晖日历（Synology Calendar / CalDAV）：提供 calendar_* 与 todo_* 共 8 个工具。密码保存在 dsh credentials（.credentials.yaml，0600），不落 settings。" }),
        S.jsx(Row, { label: "CalDAV URL", children: S.jsx("input", { value: cfg.url ?? "", disabled: !writable, onChange: (e) => set("url", e.target.value), style: inputStyle, placeholder: "https://<synology-host>/caldav.php/" }) }),
        S.jsx(Row, { label: "用户名", children: S.jsx("input", { value: cfg.username ?? "", disabled: !writable, onChange: (e) => set("username", e.target.value), style: inputStyle, placeholder: "user@example.com" }) }),
        S.jsxs("div", { style: { margin: "8px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: labelStyle, children: "密码" }),
          S.jsx("input", { type: showPw ? "text" : "password", value: password, onChange: (e) => setPasswordInput(e.target.value), style: inputStyle, placeholder: pwState?.configured ? "已配置（留空不改）" : "CalDAV 密码（必填）" }),
          S.jsx("button", { type: "button", onClick: () => setShowPw((v) => !v), style: { flex: "0 0 auto", padding: "3px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", background: "transparent", cursor: "pointer", fontSize: 12 }, children: showPw ? "隐藏" : "显示" }),
          S.jsx("button", { type: "button", onClick: savePassword, style: { flex: "0 0 auto", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }, children: pwSaved ? "✓ 已保存" : "保存密码" }),
        ] }),
        S.jsx("p", { style: { margin: "2px 0 10px", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: pwState?.configured ? "✅ 密码已配置" : "⚠️ 密码未配置，工具调用会失败" }),
        S.jsxs("div", { style: { marginTop: 6, display: "flex", gap: 8 }, children: [
          S.jsx("button", { type: "button", disabled: !writable, onClick: saveConfig, style: { padding: "6px 14px", borderRadius: 8, fontWeight: 500, cursor: writable ? "pointer" : "default" }, children: saved ? "✓ 已保存（热生效）" : "保存配置" }),
        ] }),
      ] });
    }

    const inject = ["slots", "remote"];

    function apply(ctx) {
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.calendar");
        const result = await remote[method](...args);
        if (!result || !result.ok) throw new Error(`calendar.${method} failed`);
        return result.value;
      };
      const getConfig = () => callRemote("getConfig");
      const setConfig = (payload) => callRemote("setConfig", payload);
      const setPassword = (payload) => callRemote("setPassword", payload);
      const passwordState = () => callRemote("passwordState");
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "calendar", order: 24, label: () => "群晖日历", inject: () => ({ getConfig, setConfig, setPassword, passwordState }) },
        CalendarSection,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
