// Concurrent multi-profile leak test on REAL target domains. Opens N profiles'
// Chromium engine (each profile's session + preload-fingerprint.js, per-window
// config lookup exactly like the app) AT THE SAME TIME against one domain, then
// extracts what that domain's scripts would collect. Verifies: (a) each profile
// shows a DIFFERENT device (no cross-profile linkage), (b) NO real GPU/timezone/
// canvas/audio leaks, (c) reports any bot/captcha wall.
// Usage: electron concurrent-harness.js <url> <id1,id2,id3>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");

// The machine's REAL GPU (to detect leaks). Populated once from a raw context.
const ARGS = process.argv.slice(2).filter((a) => a !== "--");
const URL = ARGS[0] || "https://www.fiverr.com/";
const IDS = (ARGS[1] || "").split(",").filter(Boolean);
const PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");

const wcToConfig = new Map(); // webContents.id -> config
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = wcToConfig.get(e.sender.id) || null; });

function extract() {
  const h = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return (x >>> 0).toString(16); };
  const o = {};
  o.tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "?"; } })();
  o.hwc = navigator.hardwareConcurrency; o.webdriver = navigator.webdriver;
  o.screen = screen.width + "x" + screen.height;
  try { const c = document.createElement("canvas"); c.width = 240; c.height = 60; const x = c.getContext("2d"); x.textBaseline = "top"; x.font = "14px Arial"; x.fillStyle = "#f60"; x.fillRect(10, 10, 100, 30); x.fillStyle = "#069"; x.fillText("dev \u{1F512} id", 12, 15); o.canvas = h(c.toDataURL()); } catch (e) { o.canvas = "ERR"; }
  try { const gl = document.createElement("canvas").getContext("webgl"); const ext = gl.getExtension("WEBGL_debug_renderer_info"); o.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(none)"; } catch (e) { o.gpu = "ERR"; }
  try { const span = document.createElement("span"); span.style.cssText = "position:absolute;left:-9999px;font-size:72px;"; span.textContent = "mmmlliWQ"; document.body.appendChild(span); let ws = ""; for (const f of ["Arial", "Segoe UI", "Consolas", "Verdana"]) { span.style.fontFamily = "'" + f + "',sans-serif"; ws += span.offsetWidth + ","; } document.body.removeChild(span); o.fontW = h(ws); } catch (e) { o.fontW = "ERR"; }
  // combined device id (what a fingerprinting service keys on)
  return new Promise((resolve) => {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext; const ac = new Ctx(1, 44100, 44100);
      const osc = ac.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000; const comp = ac.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ac.destination); osc.start(0); ac.startRendering();
      ac.oncomplete = (e) => { const d = e.renderedBuffer.getChannelData(0); let a = 0; for (let i = 4000; i < 5000; i++) a += Math.abs(d[i]); o.audio = h(String(a)); o.deviceId = h([o.canvas, o.gpu, o.audio, o.fontW, o.screen, o.tz].join("|")); resolve(o); };
      setTimeout(() => { o.audio = o.audio || "T"; o.deviceId = h([o.canvas, o.gpu, o.audio, o.fontW, o.screen, o.tz].join("|")); resolve(o); }, 2500);
    } catch (e) { o.audio = "ERR"; o.deviceId = h([o.canvas, o.gpu, o.fontW, o.screen, o.tz].join("|")); resolve(o); }
  });
}

async function openProfile(id) {
  const p = store.getProfiles().find((x) => x.id === id && !x.deletedAt);
  if (!p) return { id, error: "no-profile" };
  const cfg = store.buildConfigFromProfile(p);
  const sess = sessionMgr.getSessionForProfile(p.id);
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { session: sess, preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  wcToConfig.set(win.webContents.id, cfg);
  try { await win.loadURL(URL); } catch (_) {}
  return { id, name: p.name, win };
}

app.whenReady().then(async () => {
  console.log("STEP: ready, IDS=", IDS.length);
  // open ALL profiles concurrently against the same domain
  const opened = await Promise.all(IDS.map(openProfile));
  console.log("STEP: opened", opened.map(o => o.win ? "ok" : ("err:" + o.error)).join(","));
  await new Promise((r) => setTimeout(r, 7000)); // let bot/fingerprint scripts run
  console.log("STEP: waited, extracting");
  const results = [];
  for (const o of opened) {
    if (!o.win) { results.push({ id: o.id, error: o.error }); continue; }
    let data = {}; let pageInfo = {};
    try { data = await o.win.webContents.executeJavaScript("(" + extract.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
    try { pageInfo = await o.win.webContents.executeJavaScript(`({title:document.title.slice(0,50), wall:/robot|captcha|press.{0,4}hold|blocked|unusual traffic|access denied|verify you|are you human/i.test(document.title+' '+(document.body?document.body.innerText.slice(0,3000):''))})`, true); } catch (e) { pageInfo = {}; }
    results.push({ id: o.id, name: o.name, ...data, title: pageInfo.title, botWall: pageInfo.wall });
  }
  console.log("CONC_JSON:" + JSON.stringify({ url: URL, results }));
  app.exit(0);
}).catch((e) => { console.log("HARNESS_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
