"use strict";
// IP leak check for the patched-chromium engine, through the real manager:
//   - the IP websites see must be the proxy's, not this PC's real IP
//   - WebRTC (STUN) must not expose the real public IP or a LAN IP
// Proxy comes from a file (one line: scheme://user:pass@host:port), never printed.
// Run: node_modules/electron/dist/electron.exe eval-logs/patched-ip-leak-check.js <proxy-file>

const { app, net } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

const realBrowser = require(path.join(__dirname, "..", "src", "real-browser-manager"));

const u = new URL(fs.readFileSync(process.argv[process.argv.length - 1], "utf8").trim());
const proxy = {
  networkMode: "proxy", enabled: true, scheme: u.protocol.replace(":", ""),
  host: u.hostname, port: Number(u.port),
  username: decodeURIComponent(u.username), password: decodeURIComponent(u.password)
};
const PROFILE = {
  id: "leak-check", name: "leak-check", os: "windows", browserApp: "chrome", engine: "patched-chromium",
  proxy, fingerprint: { browser: "chrome", fingerprintSeed: "leak-check-seed", canvas: "noise", webgl: "noise", audio: "noise" }
};

const PAGE = `<!doctype html><meta charset=utf-8><body>leak<script>
(async function(){
  var out = { ip: "", ice: [] };
  try { out.ip = (await (await fetch("https://api.ipify.org?format=json")).json()).ip; } catch (e) { out.ip = "ERR " + e.message; }
  try {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.createDataChannel("x");
    pc.onicecandidate = function (e) { if (e.candidate) out.ice.push(e.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(function (r) { setTimeout(r, 4000); });
    out.sdp = pc.localDescription ? pc.localDescription.sdp : "";
  } catch (e) { out.ice.push("ERR " + e.message); }
  navigator.sendBeacon("/report", JSON.stringify(out));
})();
</script></body>`;

const isLan = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

app.whenReady().then(async () => {
  if (!realBrowser.patchedChromiumReady()) { console.log("BINARY NOT READY — run patched-engine-verify.js once first"); return app.quit(); }
  const realIp = await new Promise((resolve) => {
    const req = net.request("https://api.ipify.org");
    let b = ""; req.on("response", (r) => { r.on("data", (c) => (b += c)); r.on("end", () => resolve(b.trim())); });
    req.on("error", () => resolve("")); req.end();
  });
  if (!realIp) { console.log("Could not read this PC's real IP — abort"); return app.quit(); }

  let report = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/report") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.end("ok"); try { report = JSON.parse(b); } catch (_) {} }); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const res = await realBrowser.launchProfile(PROFILE, `http://127.0.0.1:${server.address().port}/`, {});
  console.log("launch ok:", res.ok, res.reason || "");
  for (let i = 0; i < 60 && !report && res.ok; i++) await new Promise((r) => setTimeout(r, 500));
  await realBrowser.closeProfile(PROFILE.id).catch(() => {});
  server.close();

  if (!report) { console.log("NO REPORT — page never finished (proxy down?)"); return app.quit(); }
  const ice = report.ice.concat((report.sdp || "").split("\n"));
  const iceIps = [...new Set(ice.join(" ").match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || [])];
  const lanIps = iceIps.filter(isLan);
  console.log("\n============ VERDICT ============");
  console.log(`Website sees: ${report.ip === realIp ? "YOUR REAL IP" : report.ip.startsWith("ERR") ? report.ip : "a different IP (the proxy)"}`);
  console.log(`IP via proxy:  ${report.ip !== realIp && !report.ip.startsWith("ERR") ? "PASS" : "FAIL"}`);
  console.log(`WebRTC real IP hidden: ${iceIps.includes(realIp) ? "FAIL" : "PASS"}`);
  console.log(`WebRTC LAN IP hidden:  ${lanIps.length ? "FAIL (" + lanIps.length + " LAN address)" : "PASS"}`);
  console.log(`ICE candidates seen: ${report.ice.length}`);
  app.quit();
});
