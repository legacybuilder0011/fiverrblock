"use strict";
// Network mode "VPN extension in this profile": the profile's own VPN extension
// (ExpressVPN or any extension with the "proxy" permission) carries its traffic,
// so each profile can sit in its own country without a system-wide VPN.
// Two guards keep the real IP from showing:
//   - vendor/vpn-guard: blocks every website from browser start until the exit
//     IP differs from this PC's real IP, and again whenever the VPN drops.
//   - a connection page served here, opened first: shows "waiting for VPN",
//     then the VPN location, reports it so the fingerprint can follow, and
//     continues to the pages the profile was opening.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { app, net } = require("electron");

// Name of the first extension in this profile that can set the browser proxy.
function vpnExtensionName(profile) {
  for (const item of Array.isArray(profile && profile.extensions) ? profile.extensions : []) {
    const dir = typeof item === "string" ? item : item && item.path;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      if ((m.permissions || []).includes("proxy")) return (item && item.name) || m.name || "VPN extension";
    } catch (_) {}
  }
  return "";
}

let realIpCache = { ip: "", at: 0 };
function realIp() {
  if (realIpCache.ip && Date.now() - realIpCache.at < 120000) return Promise.resolve(realIpCache.ip);
  return new Promise((resolve) => {
    const req = net.request("https://api.ipify.org");
    let body = "";
    const done = (ip) => { if (ip) realIpCache = { ip, at: Date.now() }; resolve(ip); };
    req.on("response", (res) => { res.on("data", (c) => (body += c)); res.on("end", () => done(body.trim())); });
    req.on("error", () => done(""));
    req.end();
  });
}

// Per-profile copy of vendor/vpn-guard with this PC's real IP and this launch's
// connection page (the guard asks it whether the exit IP is free for the team).
function writeGuard(profileId, ip, statusUrl) {
  const src = path.join(__dirname, "..", "vendor", "vpn-guard").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  const dest = path.join(app.getPath("userData"), "vpn-guard", String(profileId).replace(/[^\w-]/g, "_"));
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["background.js", "block.json"]) fs.copyFileSync(path.join(src, name), path.join(dest, name));
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dest, "config.json"), JSON.stringify({ realIp: ip || "", statusUrl: statusUrl || "" }));
  return dest;
}

const PAGE = (s) => `<!doctype html><meta charset=utf-8><title>Connecting VPN…</title>
<style>
body{font:15px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:520px;padding:28px 32px;border:1px solid #334155;border-radius:14px;background:#111827}
h2{margin:0 0 10px;font-size:20px} .muted{color:#94a3b8;font-size:13px;line-height:1.5} .ok{color:#4ade80} .warn{color:#fbbf24}
a{color:#60a5fa}
</style>
<div class=box><h2 id=h>Waiting for ${s.extension}…</h2>
<p id=p class=muted>Click the <b>${s.extension}</b> icon in the toolbar (puzzle piece ▸ pin it), sign in once and connect to a country.
Websites stay blocked until the VPN is on, so nothing loads on your real IP.</p>
<p id=d class=muted></p></div>
<script>
var REAL = ${JSON.stringify(s.realIp)}, NEXT = ${JSON.stringify(s.next)}, done = false;
async function tick() {
  if (done) return;
  // The guard decides. Its canary rule always blocks one address, so a canary
  // that loads means its rules are not running yet (browser just started).
  // Websites count as open only when the canary is blocked and a site loads.
  var guardReady = false, open = false, ip = "";
  try { await fetch("https://www.gstatic.com/generate_204?ps-guard-canary=" + Date.now(), { mode: "no-cors", cache: "no-store" }); } catch (e) { guardReady = true; }
  if (guardReady) { try { await fetch("https://www.gstatic.com/generate_204?" + Date.now(), { mode: "no-cors", cache: "no-store" }); open = true; } catch (e) {} }
  try { ip = (await (await fetch("https://api.ipify.org/?format=json", { cache: "no-store" })).json()).ip; } catch (e) {}
  // Team IP check: another open profile of this team on the same VPN IP.
  if (ip && ip !== REAL) {
    var a = {};
    try { a = await (await fetch("allowed?ip=" + encodeURIComponent(ip), { cache: "no-store" })).json(); } catch (e) {}
    if (a.ok === false) {
      document.getElementById("h").textContent = "Pick a different VPN location";
      document.getElementById("h").className = "warn";
      document.getElementById("p").textContent = "Your VPN gave this profile the IP " + ip + ", which “" + a.inUseBy + "”" +
        (a.device ? " on " + a.device : "") + " is using right now. Two accounts on one IP can be linked.";
      document.getElementById("d").textContent = "Open the VPN extension and connect to a different city. This page continues by itself once the IP is free. Websites stay blocked until then.";
      setTimeout(tick, 3000);
      return;
    }
  }
  if (!open || !ip || ip === REAL) { setTimeout(tick, 2000); return; }
  done = true;
  document.getElementById("h").textContent = "VPN connected";
  document.getElementById("h").className = "ok";
  document.getElementById("p").textContent = "Websites see " + ip + ". Checking its location…";
  var info = {};
  try { info = await (await fetch("report", { method: "POST", body: JSON.stringify({ ip: ip }) })).json(); } catch (e) {}
  var where = [info.city, info.country].filter(Boolean).join(", ");
  document.getElementById("p").textContent = "Websites see " + ip + (where ? " in " + where : "") + ".";
  if (info.needsRestart) {
    document.getElementById("d").innerHTML = "<span class=warn>The VPN location changed to " + (info.country || "a new country") +
      ". Close this profile and click Start again so its time zone and language match.</span>";
    return;
  }
  if (NEXT.length) {
    document.getElementById("d").textContent = "Opening your pages…";
    setTimeout(function () { location.replace(NEXT[0]); }, 1200);
  } else {
    document.getElementById("d").textContent = "You can browse now.";
  }
}
tick();
</script>`;

// One local server for all profiles; each launch gets its own token.
const sessions = new Map();
let server = null;
function ensureServer() {
  if (server) return Promise.resolve(server.address().port);
  server = http.createServer((req, res) => {
    const [, token, action] = String(req.url).split("/");
    const s = sessions.get(token);
    if (!s) { res.writeHead(404); return res.end(); }
    // Asked by the page and by the guard extension (hence the CORS header).
    if (String(action).startsWith("allowed")) {
      const ip = new URL(req.url, "http://x").searchParams.get("ip") || "";
      Promise.resolve(s.checkIp ? s.checkIp(ip) : null).catch(() => null).then((holder) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify(holder ? { ok: false, inUseBy: holder.name, device: holder.device } : { ok: true }));
      });
      return;
    }
    if (req.method === "POST" && action === "report") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on("end", async () => {
        let out = {};
        try { out = (await s.onConnected(JSON.parse(body).ip)) || {}; } catch (_) {}
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(PAGE(s));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Returns the URL the profile should open first. onConnected(ip) resolves to
// { country, city, needsRestart }.
async function connectionPage({ extension, realIp: ip, next, onConnected, checkIp }) {
  const port = await ensureServer();
  const token = crypto.randomBytes(12).toString("hex");
  sessions.set(token, { extension: String(extension).replace(/[<>&"]/g, ""), realIp: ip, next: next || [], onConnected, checkIp });
  return `http://127.0.0.1:${port}/${token}/`;
}

module.exports = { vpnExtensionName, realIp, writeGuard, connectionPage };
