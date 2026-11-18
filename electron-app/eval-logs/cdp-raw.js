"use strict";
// Minimal raw CDP: node cdp-raw.js <targetUrlPart> '[["Method",{params}],...]' -> prints the last result.
(async () => {
  const [part, steps] = process.argv.slice(2);
  const cmds = JSON.parse(steps);
  const list = await (await fetch("http://127.0.0.1:9555/json/list")).json();
  const t = list.find((x) => x.url.includes(part));
  if (!t) { console.log("no target", part); process.exit(0); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let i = 0;
  const next = () => ws.send(JSON.stringify({ id: ++i, method: cmds[i - 1][0], params: cmds[i - 1][1] || {} }));
  ws.onopen = next;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== i) return;
    if (i < cmds.length && !m.error) return next();
    console.log(JSON.stringify(m.result || m.error).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x").slice(0, 3000)); process.exit(0); };
  setTimeout(() => { console.log("timeout"); process.exit(0); }, 30000);
})();
