"use strict";
// Watch extension service workers' console, exceptions and network for N seconds.
// node cdp-watch-ext.js <seconds> [popupUrl to open] [expression to run in popup after 3s]
(async () => {
  const [secs = "40", popup, expr] = process.argv.slice(2);
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {}; const names = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const t0 = Date.now();
  const log = (sid, ...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), (names[sid] || "?").padEnd(8), ...a);
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; return; }
    const sid = m.sessionId, p = m.params || {};
    if (m.method === "Target.attachedToTarget") {
      const ti = p.targetInfo; names[p.sessionId] = ti.type === "service_worker" ? ti.url.split("/")[2].slice(0, 8) : ti.type.slice(0, 8);
      log(p.sessionId, "ATTACHED", ti.type, ti.url.slice(0, 80));
      for (const d of ["Runtime.enable", "Log.enable", "Network.enable"]) send(d, {}, p.sessionId);
      send("Runtime.runIfWaitingForDebugger", {}, p.sessionId);
    } else if (m.method === "Runtime.consoleAPICalled") {
      log(sid, "console." + p.type, p.args.map((x) => x.value !== undefined ? JSON.stringify(x.value) : (x.description || x.type)).join(" ").slice(0, 400));
    } else if (m.method === "Runtime.exceptionThrown") {
      log(sid, "EXCEPTION", (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text).slice(0, 300));
    } else if (m.method === "Log.entryAdded") {
      log(sid, "log." + p.entry.level, p.entry.text.slice(0, 300), p.entry.url || "");
    } else if (m.method === "Network.requestWillBeSent") {
      log(sid, "REQ", p.request.method, p.request.url.replace(/([?&](token|auth|key)=)[^&]+/gi, "$1***").slice(0, 160));
    } else if (m.method === "Network.responseReceived") {
      log(sid, "RES", p.response.status, p.response.url.slice(0, 140));
    } else if (m.method === "Network.loadingFailed") {
      log(sid, "FAIL", p.errorText, p.blockedReason || "", p.corsErrorStatus ? JSON.stringify(p.corsErrorStatus) : "");
    } else if (m.method === "Target.detachedFromTarget") {
      log(p.sessionId, "DETACHED");
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "service_worker" }, { type: "page", exclude: true }] });
  const { result } = await send("Target.getTargets");
  for (const t of result.targetInfos.filter((x) => x.type === "service_worker")) {
    const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    if (a.result) ws.onmessage({ data: JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: a.result.sessionId, targetInfo: t } }) });
  }
  if (popup) {
    const t = await send("Target.createTarget", { url: popup, background: true });
    const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
    names[a.result.sessionId] = "popup";
    for (const d of ["Runtime.enable", "Log.enable", "Network.enable"]) send(d, {}, a.result.sessionId);
    if (expr) setTimeout(async () => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, a.result.sessionId);
      log(a.result.sessionId, "EVAL", JSON.stringify(r.result ? r.result.result.value : r.error).slice(0, 1500));
    }, 3000);
  }
  setTimeout(() => process.exit(0), Number(secs) * 1000);
})();
