"use strict";
// Call an IPC handler through the running app's profiles page (app started with
// --remote-debugging-port=9333). node app-invoke.js <TYPE> '<json data>'
(async () => {
  const [type, data = "{}", outFile] = process.argv.slice(2);
  const page = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).find((t) => t.url.includes("profiles.html"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1 && outFile) { require("fs").writeFileSync(outFile, JSON.stringify(m.result.result.value, null, 1)); console.log("saved", outFile); process.exit(0); }
    if (m.id === 1) { console.log(JSON.stringify(m.result.result.value || m.result).slice(0, 2000)); process.exit(0); }
  };
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `window.electronAPI.invoke(${JSON.stringify(type)}, ${data})`, awaitPromise: true, returnByValue: true } }));
})();
setTimeout(() => { console.log("timeout"); process.exit(0); }, 120000);
