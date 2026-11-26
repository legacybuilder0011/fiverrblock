"use strict";
// Ask a PIA proxy server whether it accepts this profile's saved token.
// Reads the token over CDP (port 9555) and never prints it.
// node pia-proxy-probe.js <proxyHost> [more hosts...]
const tls = require("tls");
async function token() {
  const v = await (await fetch("http://127.0.0.1:9555/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  const t = await send("Target.createTarget", { url: "chrome-extension://jplnlifepflhkbkgonidnobkakhmpnmh/src/popup.html", background: true });
  const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
  await new Promise((r) => setTimeout(r, 2000));
  const r = await send("Runtime.evaluate", { expression: "chrome.storage.local.get('PIA_proxy_auth_token').then(o=>o.PIA_proxy_auth_token.value)", awaitPromise: true, returnByValue: true }, a.result.sessionId);
  await send("Target.closeTarget", { targetId: t.result.targetId });
  ws.close();
  return r.result.result.value;
}
function probe(host, user, pass) {
  return new Promise((res) => {
    const s = tls.connect({ host, port: 443, servername: host }, () => {
      const auth = Buffer.from(`${user}:${pass}`).toString("base64");
      s.write(`CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    s.setTimeout(15000, () => { res("timeout"); s.destroy(); });
    s.once("data", (d) => { res(String(d).split("\r\n")[0]); s.destroy(); });
    s.on("error", (e) => res("error " + e.message));
  });
}
(async () => {
  let tok = await token();
  if (typeof tok !== "string") tok = JSON.stringify(tok);
  console.log("token length", tok.length);
  const half = Math.floor(tok.length / 2);
  for (const host of process.argv.slice(2)) {
    console.log(host, "->", await probe(host, tok.slice(0, half), tok.slice(half)));
  }
  process.exit(0);
})();
