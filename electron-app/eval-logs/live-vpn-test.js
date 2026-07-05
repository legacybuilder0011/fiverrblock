// LIVE VPN test. Uses the machine's REAL connected VPN. For each profile: sets
// tz/lang/geo=auto, captures the live VPN exit (exactly what openProfileWindow
// persists into proxy.detected*), rebuilds config, and opens the profile in a
// real Chromium tab against a real domain — all 3 concurrently. Verifies each
// profile: (a) reports the VPN's country (tz/lang/geo), not the real machine
// zone; (b) leaks no real GPU/canvas/local-IP; (c) shows a DIFFERENT device
// than the others. Machine real zone = Africa/Lagos; VPN = US/Miami.
// Usage: electron live-vpn-test.js -- <url> <id1,id2,id3>
const { app, BrowserWindow, ipcMain, net } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");
const ARGS = process.argv.slice(2).filter((a) => a !== "--");
const URL = ARGS[0] || "https://www.fiverr.com/";
const IDS = (ARGS[1] || "").split(",").filter(Boolean);
const PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");
const wcToConfig = new Map();
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = wcToConfig.get(e.sender.id) || null; });

function getJson(url) { return new Promise((res) => { const r = net.request({ url, useSessionCookies: false }); let b = ""; r.on("response", (x) => { x.on("data", (d) => b += d); x.on("end", () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); }); r.on("error", () => res(null)); setTimeout(() => { try { r.abort(); } catch (_) {} res(null); }, 9000); r.end(); }); }

async function captureLive() {
  const d = await getJson("http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,lat,lon,timezone,proxy,query");
  if (!d || d.status !== "success") return null;
  return { detectedCountryCode: String(d.countryCode || "").toLowerCase(), detectedCountry: d.country, detectedCity: d.city, detectedState: d.regionName, detectedTimezone: d.timezone, detectedLatitude: d.lat, detectedLongitude: d.lon, detectedIp: d.query, proxyType: d.proxy ? "vpn" : "direct", networkMode: "direct" };
}

async function readSignals() {
  const h = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return (x >>> 0).toString(16); };
  const o = {};
  try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { o.tz = "ERR"; }
  try { o.offJan = new Date(2025, 0, 15).getTimezoneOffset(); o.offJul = new Date(2025, 6, 15).getTimezoneOffset(); } catch (e) {}
  try { o.lang = navigator.language; } catch (e) {}
  try { const c = document.createElement("canvas"); c.width = 240; c.height = 60; const x = c.getContext("2d"); x.textBaseline = "top"; x.font = "14px Arial"; x.fillStyle = "#f60"; x.fillRect(10, 10, 100, 30); x.fillStyle = "#069"; x.fillText("dev id", 12, 15); o.canvas = h(c.toDataURL()); } catch (e) { o.canvas = "ERR"; }
  try { const gl = document.createElement("canvas").getContext("webgl"); const ext = gl.getExtension("WEBGL_debug_renderer_info"); o.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(none)"; } catch (e) { o.gpu = "ERR"; }
  o.geo = await new Promise((res) => { try { navigator.geolocation.getCurrentPosition((p) => res([+p.coords.latitude.toFixed(2), +p.coords.longitude.toFixed(2)]), (e) => res("ERR:" + e.code), { timeout: 4000 }); } catch (e) { res("THROW"); } });
  o.rtc = await new Promise((res) => { try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }); const ips = new Set(); pc.onicecandidate = (e) => { if (!e.candidate) { res(ips.size ? Array.from(ips).join(",") : "no-candidates"); return; } const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate || ""); if (m) ips.add(m[1]); }; pc.createDataChannel("x"); pc.createOffer().then((dd) => pc.setLocalDescription(dd)); setTimeout(() => res(ips.size ? Array.from(ips).join(",") : "no-candidates"), 4000); } catch (e) { res("THROW"); } });
  o.deviceId = h([o.canvas, o.gpu, o.tz].join("|"));
  return o;
}

app.whenReady().then(async () => {
  const live = await captureLive();
  if (!live) { console.log("LIVE_JSON:" + JSON.stringify({ error: "no live capture — is the VPN/network up?" })); return app.exit(1); }
  console.log("LIVE_EXIT:" + JSON.stringify({ cc: live.detectedCountryCode, city: live.detectedCity, tz: live.detectedTimezone, ip: live.detectedIp, proxy: live.proxyType }));
  const opened = [];
  for (const id of IDS) {
    let p = store.getProfiles().find((x) => x.id === id && !x.deletedAt);
    if (!p) { opened.push({ id, error: "no-profile" }); continue; }
    const fp = { ...(p.fingerprint || {}), timezone: "auto", language: "auto", geolocation: "auto" };
    p = store.updateProfile(id, { fingerprint: fp, proxy: { ...(p.proxy || {}), ...live } });
    const cfg = store.buildConfigFromProfile(p);
    const sess = sessionMgr.getSessionForProfile(p.id);
    try { sess.setPermissionRequestHandler((wc, perm, cb) => cb(true)); } catch (_) {}
    const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { session: sess, preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false } });
    wcToConfig.set(win.webContents.id, cfg);
    opened.push({ id, name: p.name, win, cfgTz: cfg.timezone, cfgLang: cfg.language });
  }
  await Promise.all(opened.filter((o) => o.win).map((o) => o.win.loadURL(URL).catch(() => {})));
  await new Promise((r) => setTimeout(r, 8000));
  const results = [];
  for (const o of opened) {
    if (!o.win) { results.push({ id: o.id, error: o.error }); continue; }
    let data = {}, page = {};
    try { data = await o.win.webContents.executeJavaScript("(" + readSignals.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
    try { page = await o.win.webContents.executeJavaScript(`({title:document.title.slice(0,40), wall:/robot|captcha|press.{0,4}hold|blocked|unusual traffic|access denied|verify you|are you human/i.test(document.title+' '+(document.body?document.body.innerText.slice(0,3000):''))})`, true); } catch (e) {}
    results.push({ name: o.name, cfgTz: o.cfgTz, cfgLang: o.cfgLang, ...data, title: page.title, botWall: page.wall });
  }
  console.log("LIVE_JSON:" + JSON.stringify({ url: URL, live: { cc: live.detectedCountryCode, tz: live.detectedTimezone, ip: live.detectedIp }, results }, null, 1));
  app.exit(0);
}).catch((e) => { console.log("LIVE_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
