"use strict";
// IP / ISP / network-identity leak check for EVERY engine, through the app's own
// launch code, with a local test proxy (Basic auth) instead of a real one:
//   - plain-HTTP "what is my IP" answered BY THE PROXY with a fake IP -> page must see it
//   - HTTPS request must arrive at the proxy as CONNECT <hostname> (no bypass, no local DNS)
//   - WebRTC/STUN must not expose this PC's real public IP or any LAN IP
// Run: node_modules/electron/dist/electron.exe eval-logs/network-leak-check.js [engine ...]

const { app, BrowserWindow, net } = require("electron");
const http = require("http");
const netSock = require("net");
const os = require("os");
const path = require("path");

const src = (m) => require(path.join(__dirname, "..", "src", m));
const FAKE_IP = "203.0.113.7";
const AUTH = "Basic " + Buffer.from("psuser:pspass").toString("base64");
const ENGINES = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith(".js"));
const ALL = ["chromium", "patched-chromium", "real-chrome", "real-brave", "camoufox"];

const lanIps = Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && !i.internal).map((i) => i.address.split("%")[0].toLowerCase());

let seen = []; // what reached the proxy for the current engine
const proxy = http.createServer((req, res) => {
  if (req.headers["proxy-authorization"] !== AUTH) { res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="t"' }); return res.end(); }
  const u = new URL(req.url);
  seen.push("GET " + u.host);
  if (u.hostname === "api.ipify.org") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ ip: FAKE_IP }));
  }
  const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
proxy.on("connect", (req, sock, head) => {
  if (req.headers["proxy-authorization"] !== AUTH) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"t\"\r\n\r\n"); return; }
  seen.push("CONNECT " + req.url);
  const [host, port] = req.url.split(":");
  const up = netSock.connect(Number(port) || 443, host, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});

const PAGE = `<!doctype html><meta charset=utf-8><body>leak<script>
(async function(){
  var out = { httpIp: "", httpsOk: false, ice: [], sdp: "", conn: null };
  try { out.httpIp = (await (await fetch("http://api.ipify.org/?format=json")).json()).ip; } catch (e) { out.httpIp = "ERR " + e.message; }
  try { await fetch("https://api.ipify.org/?format=json"); out.httpsOk = true; } catch (e) {}
  try { var c = navigator.connection; out.conn = c ? { type: c.effectiveType, rtt: c.rtt, down: c.downlink } : null; } catch (e) {}
  try {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.createDataChannel("x");
    pc.onicecandidate = function (e) { if (e.candidate) out.ice.push(e.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(function (r) { setTimeout(r, 5000); });
    out.sdp = pc.localDescription ? pc.localDescription.sdp : "";
  } catch (e) { out.ice.push("ERR " + e.message); }
  navigator.sendBeacon("/report", JSON.stringify(out));
})();
</script></body>`;

let report = null;
const site = http.createServer((req, res) => {
  if (req.url === "/report") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.end("ok"); try { report = JSON.parse(b); } catch (_) {} }); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGE);
});

function profileFor(engine, proxyPort) {
  return {
    id: "leakcheck-" + engine, name: "leakcheck-" + engine, os: "windows", browserApp: "chrome", engine,
    proxy: { networkMode: "proxy", enabled: true, scheme: "http", host: "127.0.0.1", port: proxyPort, username: "psuser", password: "pspass" },
    fingerprint: { browser: "chrome", fingerprintSeed: "leakcheck-" + engine, timezone: "manual", timezoneValue: "America/New_York", canvas: "noise", webgl: "noise", audio: "noise" }
  };
}

// Built-in engine: the app's own session setup + the same native WebRTC policy addTab sets.
async function openBuiltIn(profile, url) {
  const sess = await src("session-manager").setupProfileSession(profile);
  const win = new BrowserWindow({ show: false, webPreferences: { session: sess, contextIsolation: true } });
  win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  win.loadURL(url);
  return () => win.destroy();
}

async function openEngine(engine, profile, url) {
  if (engine === "chromium") return openBuiltIn(profile, url);
  if (engine === "camoufox") {
    const cf = src("camoufox-manager");
    const r = await cf.launchProfile(profile, url);
    if (!r.ok) throw new Error(r.reason + " " + (r.detail || ""));
    return () => cf.closeProfile(profile.id);
  }
  const rb = src("real-browser-manager");
  const r = await rb.launchProfile(profile, url, {});
  if (!r.ok) throw new Error((r.reason || "") + " " + (r.detail || r.error || ""));
  return () => rb.closeProfile(profile.id);
}

app.whenReady().then(async () => {
  const realIp = await new Promise((resolve) => {
    const req = net.request("https://api.ipify.org");
    let b = ""; req.on("response", (r) => { r.on("data", (c) => (b += c)); r.on("end", () => resolve(b.trim())); });
    req.on("error", () => resolve("")); req.end();
  });
  if (!realIp) { console.log("Could not read this PC's real IP — abort"); return app.quit(); }
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const rows = [];
  for (const engine of ENGINES.length ? ENGINES : ALL) {
    seen = []; report = null;
    let close = null, err = "";
    try { close = await openEngine(engine, profileFor(engine, proxy.address().port), url); }
    catch (e) { err = String(e.message || e).slice(0, 2500); }
    for (let i = 0; i < 70 && !report && !err; i++) await new Promise((r) => setTimeout(r, 500));
    if (close) await Promise.resolve(close()).catch(() => {});
    if (err || !report) { rows.push({ engine, result: err ? "DID NOT OPEN: " + err : "NO REPORT" }); continue; }

    const iceText = report.ice.join(" ") + " " + report.sdp;
    const iceIps = [...new Set(iceText.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || [])].filter((ip) => ip !== "0.0.0.0" && ip !== "127.0.0.1");
    const checks = {
      "HTTP via proxy": report.httpIp === FAKE_IP ? "PASS" : (report.httpIp === realIp ? "FAIL real IP" : "FAIL " + report.httpIp),
      "HTTPS via proxy": seen.includes("CONNECT api.ipify.org:443") ? "PASS" : (report.httpsOk ? "FAIL bypassed proxy" : "FAIL blocked"),
      "DNS at proxy": seen.some((s) => /^CONNECT \d+\.\d+\.\d+\.\d+:/.test(s)) ? "FAIL resolved locally" : "PASS",
      "WebRTC real IP": iceIps.includes(realIp) ? "FAIL" : "PASS",
      "WebRTC LAN IP": lanIps.some((ip) => iceText.toLowerCase().includes(ip)) ? "FAIL" : "PASS"
    };
    rows.push({ engine, ...checks, conn: report.conn ? `${report.conn.type}/${report.conn.rtt}ms` : "none" });
  }
  console.log("\n============ NETWORK LEAK CHECK ============");
  console.table(rows);
  app.quit();
});
