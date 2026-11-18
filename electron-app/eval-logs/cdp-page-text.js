"use strict";
// Open a URL in the live browser (raw CDP) and print its text.
(async () => {
  const [url, filter] = process.argv.slice(2);
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  const c = await send("Target.createTarget", { url, background: true });
  await new Promise((r) => setTimeout(r, 3000));
  const a = await send("Target.attachToTarget", { targetId: c.result.targetId, flatten: true });
  const r = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, a.result.sessionId);
  let t = String(r.result.result.value || "");
  if (filter) t = t.split(/\n\s*\n/).filter((b) => new RegExp(filter, "i").test(b)).join("\n---\n");
  console.log(t.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x").slice(0, 3500));
  await send("Target.closeTarget", { targetId: c.result.targetId });
  process.exit(0);
})();
setTimeout(() => { console.log("timeout"); process.exit(0); }, 30000);
