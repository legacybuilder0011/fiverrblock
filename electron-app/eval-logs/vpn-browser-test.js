// Browser-level VPN alignment proof. Builds two profiles simulating a German
// and a Japanese VPN exit (proxy.detected* = what captureCurrentNetwork writes
// at launch), opens each in a real Chromium tab, and reads what a site sees:
// Intl timezone + live offset, navigator.language(s), geolocation, and WebRTC
// ICE candidates (to confirm the real IP never leaks). The real machine is in
// Africa/Lagos — neither profile may show that.
// Usage: electron vpn-browser-test.js
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");
const PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");
const wcToConfig = new Map();
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = wcToConfig.get(e.sender.id) || null; });

const SIMS = {
  "VPN-DE": { detectedCountryCode: "de", detectedCountry: "Germany", detectedCity: "Berlin", detectedTimezone: "Europe/Berlin", detectedLatitude: 52.52, detectedLongitude: 13.405, detectedIp: "91.10.20.30", proxyType: "vpn", networkMode: "vpn", enabled: false },
  "VPN-JP": { detectedCountryCode: "jp", detectedCountry: "Japan", detectedCity: "Tokyo", detectedTimezone: "Asia/Tokyo", detectedLatitude: 35.68, detectedLongitude: 139.76, detectedIp: "126.10.20.30", proxyType: "vpn", networkMode: "vpn", enabled: false },
};

function ensureProfile(name, detected) {
  let p = store.getProfiles().find((x) => !x.deletedAt && x.name === name);
  if (!p) p = store.createProfile({ name, os: "windows", browserApp: "chrome" });
  const fp = { ...(p.fingerprint || {}), timezone: "auto", language: "auto", geolocation: "auto" };
  return store.updateProfile(p.id, { fingerprint: fp, proxy: { ...(p.proxy || {}), ...detected } });
}

async function readSignals() {
  const o = {};
  try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { o.tz = "ERR"; }
  // Live offset for Jan and Jul (proves DST-correct, per-zone, not a static number)
  try { o.offJan = new Date(2025, 0, 15).getTimezoneOffset(); o.offJul = new Date(2025, 6, 15).getTimezoneOffset(); } catch (e) {}
  try { o.lang = navigator.language; o.langs = (navigator.languages || []).join(","); } catch (e) {}
  o.geo = await new Promise((res) => {
    try { navigator.geolocation.getCurrentPosition(
      (pos) => res([+pos.coords.latitude.toFixed(3), +pos.coords.longitude.toFixed(3)]),
      (err) => res("ERR:" + err.code + ":" + err.message), { timeout: 4000 }); }
    catch (e) { res("THROW:" + e.message); }
  });
  o.rtc = await new Promise((res) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      const ips = new Set();
      pc.onicecandidate = (e) => {
        if (!e.candidate) { res(ips.size ? Array.from(ips).join(",") : "no-candidates"); return; }
        const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate || "");
        if (m) ips.add(m[1]);
      };
      pc.createDataChannel("x"); pc.createOffer().then((d) => pc.setLocalDescription(d));
      setTimeout(() => res(ips.size ? Array.from(ips).join(",") : "no-candidates"), 4000);
    } catch (e) { res("THROW:" + e.message); }
  });
  return o;
}

app.whenReady().then(async () => {
  const results = [];
  for (const [name, detected] of Object.entries(SIMS)) {
    const p = ensureProfile(name, detected);
    const cfg = store.buildConfigFromProfile(p);
    const sess = sessionMgr.getSessionForProfile(p.id);
    try { sess.setPermissionRequestHandler((wc, perm, cb) => cb(true)); } catch (_) {}
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { session: sess, preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false } });
    wcToConfig.set(win.webContents.id, cfg);
    try { await win.loadURL("https://example.com/"); } catch (_) {}
    let data = {};
    try { data = await win.webContents.executeJavaScript("(" + readSignals.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
    results.push({ profile: name, cfgTz: cfg.timezone, cfgLang: cfg.language, cfgGeo: cfg.geo ? [cfg.geo.latitude, cfg.geo.longitude] : null, browser: data });
  }
  console.log("VPNBR_JSON:" + JSON.stringify(results, null, 1));
  app.exit(0);
}).catch((e) => { console.log("VPNBR_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
