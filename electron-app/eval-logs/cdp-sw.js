"use strict";
// Raw browser-level CDP: evaluate an expression in an extension service worker.
// node cdp-sw.js <extIdPrefix> <expression>
(async () => {
  const [part, expr] = process.argv.slice(2);
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  const { result } = await send("Target.getTargets");
  const ts = result.targetInfos.filter((t) => t.type === "service_worker");
  console.log("workers:", ts.map((t) => t.url.split("/")[2].slice(0, 8)).join(", ") || "none");
  const t = ts.find((x) => x.url.includes(part));
  if (!t || !expr) process.exit(0);
  const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, a.result.sessionId);
  console.log(JSON.stringify(r.result ? (r.result.result.value !== undefined ? r.result.result.value : r.result) : r.error).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x").slice(0, 3000));
  process.exit(0);
})();
setTimeout(() => { console.log("timeout"); process.exit(0); }, 40000);
