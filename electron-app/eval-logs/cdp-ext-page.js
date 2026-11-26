"use strict";
// Open an extension page in a background tab (wakes its service worker) and
// evaluate an expression there. node cdp-ext-page.js <url> <expression>
(async () => {
  const [url, expr] = process.argv.slice(2);
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  const t = await send("Target.createTarget", { url, background: true });
  const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
  await new Promise((r) => setTimeout(r, 2500));
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, a.result.sessionId);
  console.log(JSON.stringify(r.result ? (r.result.result.value !== undefined ? r.result.result.value : r.result) : r.error).slice(0, 3000));
  await send("Target.closeTarget", { targetId: t.result.targetId });
  process.exit(0);
})();
setTimeout(() => { console.log("timeout"); process.exit(0); }, 30000);
