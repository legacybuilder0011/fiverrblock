// Checks residual same-machine correlation vectors that fingerprinters use to
// LINK profiles on one device: Battery, AudioContext sampleRate/latency,
// mediaDevices counts, navigator.connection, performance timing origin.
// Any value IDENTICAL across profiles AND rare = linkable. Common = safe.
// Usage: electron residual-probe.js -- <id1,id2,id3>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");
const ARGS = process.argv.slice(2).filter((a) => a !== "--");
const IDS = (ARGS[0] || "").split(",").filter(Boolean);
const PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");
const wcToConfig = new Map();
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = wcToConfig.get(e.sender.id) || null; });

async function probe() {
  const o = {};
  try { const ac = new (window.AudioContext || window.webkitAudioContext)(); o.sampleRate = ac.sampleRate; o.baseLatency = ac.baseLatency; o.maxChannel = ac.destination.maxChannelCount; ac.close(); } catch (e) { o.audioCtx = "ERR"; }
  try { o.devMem = navigator.deviceMemory; o.cores = navigator.hardwareConcurrency; } catch (e) {}
  try { const c = navigator.connection || {}; o.conn = [c.effectiveType, c.downlink, c.rtt].join("/"); } catch (e) { o.conn = "?"; }
  try { o.platform = navigator.platform; o.oscpu = navigator.oscpu || "-"; } catch (e) {}
  try { const md = await navigator.mediaDevices.enumerateDevices(); o.mediaKinds = md.map((d) => d.kind).sort().join(","); o.mediaCount = md.length; } catch (e) { o.media = "ERR:" + e.message; }
  o.battery = await (navigator.getBattery ? navigator.getBattery().then((b) => [b.charging, b.level, b.chargingTime, b.dischargingTime].join("/")).catch((e) => "ERR") : Promise.resolve("no-api"));
  return o;
}

async function openProfile(id) {
  const p = store.getProfiles().find((x) => x.id === id && !x.deletedAt);
  if (!p) return { id, error: "no-profile" };
  const cfg = store.buildConfigFromProfile(p);
  const sess = sessionMgr.getSessionForProfile(p.id);
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { session: sess, preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  wcToConfig.set(win.webContents.id, cfg);
  try { await win.loadURL("https://example.com/"); } catch (_) {}
  return { id, name: p.name, win };
}

app.whenReady().then(async () => {
  const opened = await Promise.all(IDS.map(openProfile));
  await new Promise((r) => setTimeout(r, 1500));
  const results = [];
  for (const o of opened) {
    if (!o.win) { results.push({ id: o.id, error: o.error }); continue; }
    let data = {};
    try { data = await o.win.webContents.executeJavaScript("(" + probe.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
    results.push({ name: o.name, ...data });
  }
  console.log("RESID_JSON:" + JSON.stringify(results, null, 1));
  app.exit(0);
}).catch((e) => { console.log("PROBE_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
