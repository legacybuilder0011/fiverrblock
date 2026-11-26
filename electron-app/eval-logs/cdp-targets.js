"use strict";
// List every CDP target (pages, workers, extension pages) on port 9555.
(async () => {
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  console.log("browser", v.Browser);
  const { result } = await send("Target.getTargets");
  for (const t of result.targetInfos) console.log(t.type.padEnd(16), t.attached ? "A" : " ", t.url.slice(0, 110), "|", t.title.slice(0, 40));
  process.exit(0);
})();
setTimeout(() => process.exit(0), 15000);
