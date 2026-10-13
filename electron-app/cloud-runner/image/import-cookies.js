// One-shot: load cookies moved from the PC (/data/ps-import-cookies.json) into
// this box's Chromium profile via DevTools on the box's own loopback, then exit.
// Run by entrypoint.sh before the normal (no-debug-port) browser start.
const fs = require("fs");

const FILE = "/data/ps-import-cookies.json";
const PORT_FILE = "/data/DevToolsActivePort";

// Network.Cookie (what the PC read) → Network.CookieParam (what setCookies takes).
function toParam(c) {
  const p = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (c.sameSite) p.sameSite = c.sameSite;
  if (!c.session && c.expires > 0) p.expires = c.expires;
  if (c.priority) p.priority = c.priority;
  if (c.sourceScheme) p.sourceScheme = c.sourceScheme;
  if (c.partitionKey && typeof c.partitionKey === "object") p.partitionKey = c.partitionKey;
  return p;
}

(async () => {
  const cookies = JSON.parse(fs.readFileSync(FILE, "utf8")).map(toParam);
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { port = Number(fs.readFileSync(PORT_FILE, "utf8").split("\n")[0]) || 0; } catch (_) {}
  }
  if (!port) throw new Error("browser did not start for import");
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const my = ++id;
    const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", onMsg); resolve(m); } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let r = await call("Storage.setCookies", { cookies });
  if (r.error) {
    // One bad cookie fails the batch — fall back to one at a time.
    let ok = 0;
    for (const c of cookies) { const one = await call("Storage.setCookies", { cookies: [c] }); if (!one.error) ok++; }
    console.log(`imported ${ok}/${cookies.length} cookies (batch failed: ${r.error.message})`);
  } else {
    console.log(`imported ${cookies.length} cookies`);
  }
  await call("Browser.close");
  process.exit(0);
})().catch((e) => { console.log("cookie import failed:", e.message); process.exit(1); });
