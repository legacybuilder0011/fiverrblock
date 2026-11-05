"use strict";
// "Check this profile": opens the profile on a page served from this PC and
// reports what a website sees (IP, WebRTC, time zone, language, automation flag,
// fingerprint), compared with this PC's real network and the account's other
// profiles. The profile stays open afterwards so the member can log in.

const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { net } = require("electron");

const PAGE = `<!doctype html><meta charset=utf-8><title>Profile check</title>
<style>body{font:15px system-ui;margin:40px;color:#222}</style>
<h2>Checking this profile…</h2><p id=s>About 30 seconds. You can log in once the result shows in Privacy Shield.</p>
<script>
(async function () {
  var out = { ip: "", ice: [], tz: "", lang: navigator.language, langs: navigator.languages, webdriver: navigator.webdriver, ua: navigator.userAgent };
  try { out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  try { out.ip = (await (await fetch("https://api.ipify.org/?format=json", { cache: "no-store" })).json()).ip; } catch (e) { out.ip = "ERR " + e.message; }
  try {
    var c = document.createElement("canvas"); c.width = 240; c.height = 60; var x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#f60"; x.fillRect(10, 10, 120, 30);
    x.fillStyle = "#069"; x.fillText("Check\\u2764PC", 12, 14);
    var gl = document.createElement("canvas").getContext("webgl"), e = gl && gl.getExtension("WEBGL_debug_renderer_info");
    var oc = new OfflineAudioContext(1, 44100, 44100), o = oc.createOscillator(), cp = oc.createDynamicsCompressor();
    o.type = "triangle"; o.frequency.value = 10000; o.connect(cp); cp.connect(oc.destination); o.start(0);
    var b = await oc.startRendering(), d = b.getChannelData(0), s = 0; for (var i = 4000; i < 5000; i++) s += Math.abs(d[i]);
    out.fp = [c.toDataURL(), e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "", s, screen.width + "x" + screen.height, navigator.hardwareConcurrency].join("~");
  } catch (e) {}
  try {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.createDataChannel("x");
    pc.onicecandidate = function (ev) { if (ev.candidate) out.ice.push(ev.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(function (r) { setTimeout(r, 4000); });
    if (pc.localDescription) out.ice.push(pc.localDescription.sdp);
  } catch (e) {}
  await fetch("/report", { method: "POST", body: JSON.stringify(out) }).catch(function () {});
  document.getElementById("s").textContent = "Done. See the result in Privacy Shield.";
  document.querySelector("h2").textContent = "Profile check finished";
})();
</script>`;

function realIp() {
  return new Promise((resolve) => {
    const req = net.request("https://api.ipify.org");
    let body = "";
    req.on("response", (res) => { res.on("data", (c) => (body += c)); res.on("end", () => resolve(body.trim())); });
    req.on("error", () => resolve(""));
    req.end();
  });
}

function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && !i.internal).map((i) => i.address.split("%")[0].toLowerCase());
}

// open(url) launches the profile at url and resolves to the open result.
// others: [{ id, name, fpHash }] from the account's other profiles.
async function runCheck({ profile, config, open, others }) {
  let report = null;
  let resolveReport;
  const reported = new Promise((r) => (resolveReport = r));
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/report") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 200000) req.destroy(); });
      req.on("end", () => { res.end("ok"); try { report = JSON.parse(body); } catch (_) {} resolveReport(); });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const [myIp, opened] = await Promise.all([realIp(), open(`http://127.0.0.1:${server.address().port}/`)]);
    if (!opened || !opened.ok) return { ok: false, opened };
    await Promise.race([reported, new Promise((r) => setTimeout(r, 30000))]);
    if (!report) return { ok: false, error: "The profile opened but the check page did not finish in 30 seconds. Is the proxy working?" };
    return { ok: true, ...grade(report, { profile, config, myIp, lan: lanIps(), others }) };
  } finally {
    server.close();
  }
}

function grade(r, { profile, config, myIp, lan, others }) {
  const px = profile.proxy || {};
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const ipErr = !r.ip || String(r.ip).startsWith("ERR");
  if (ipErr) add("Website can reach the internet", false, "The profile could not load a website. The proxy may be down. " + (r.ip || ""));
  else if (mode === "proxy") add("Your real IP is hidden", r.ip !== myIp, r.ip !== myIp ? `Websites see ${r.ip}.` : "Websites see this PC's real IP. Do not log in.");
  else add("Network", null, `VPN mode: websites see ${r.ip}. Make sure that is your VPN, not your home internet.`);

  if (!ipErr) {
    const sharer = (others || []).find((o) => o.id !== profile.id && o.ip && o.ip === r.ip);
    add("IP not used by another profile", !sharer, sharer ? `"${sharer.name || "Another profile"}" uses the same IP ${r.ip}. Accounts on one IP can be linked.` : "No other profile in this account uses this IP.");
  }

  const ice = (r.ice || []).join(" ").toLowerCase();
  const webrtcLeak = (myIp && mode === "proxy" && ice.includes(myIp)) || lan.some((ip) => ice.includes(ip));
  add("WebRTC hides your IP", !webrtcLeak, webrtcLeak ? "WebRTC shows this PC's real or home-network address." : "No real or home-network address exposed.");

  const wantTz = config && config.timezone;
  if (wantTz) add("Time zone matches the profile", r.tz === wantTz, r.tz === wantTz ? r.tz : `Shows ${r.tz}, profile expects ${wantTz}.`);
  const wantLang = String((config && config.language) || "").split("-")[0];
  if (wantLang) add("Language matches the profile", String(r.lang || "").startsWith(wantLang), `Shows ${r.lang}.`);

  add("Not flagged as automated", r.webdriver !== true, r.webdriver === true ? "navigator.webdriver is true." : "Looks like a normal browser.");

  const fpHash = r.fp ? crypto.createHash("sha256").update(r.fp).digest("hex").slice(0, 16) : "";
  const twin = fpHash && (others || []).find((o) => o.id !== profile.id && o.fpHash === fpHash);
  if (fpHash) add("Fingerprint is unique", !twin, twin ? `Same fingerprint as "${twin.name || "another profile"}". The two can be linked.` : "Different from every other checked profile in this account.");

  return { checks, passed: checks.every((c) => c.ok !== false), fpHash, ip: ipErr ? "" : r.ip };
}

module.exports = { runCheck, grade };
