"use strict";
// Measure what a REAL website script (page main world) can see in the running app:
// Node/Electron artifacts, IPC handles, and custom antidetect globals. Uses a
// data: URL with an INLINE <script> so it runs exactly like a detector's code,
// then reads the result back from document.title.
const { chromium } = require("playwright-core");
function L(...a){console.log(a.join(" "));}

const CHECK = `
  var r = {};
  try { r.process = typeof process; } catch(e){ r.process = 'throw'; }
  try { r.require = typeof require; } catch(e){ r.require = 'throw'; }
  try { r.module = typeof module; } catch(e){ r.module = 'throw'; }
  try { r.global = typeof global; } catch(e){ r.global = 'throw'; }
  try { r.Buffer = typeof Buffer; } catch(e){ r.Buffer = 'throw'; }
  try { r.__dirname = typeof __dirname; } catch(e){ r.__dirname = 'throw'; }
  try { r.electron = (typeof process!=='undefined' && process && process.versions) ? (process.versions.electron||null) : null; } catch(e){ r.electron = 'throw'; }
  try { r.nodever = (typeof process!=='undefined' && process && process.versions) ? (process.versions.node||null) : null; } catch(e){ r.nodever = 'throw'; }
  try { r.chromever = (typeof process!=='undefined' && process && process.versions) ? (process.versions.chrome||null) : null; } catch(e){ r.chromever = 'throw'; }
  try { r.ptype = (typeof process!=='undefined' && process) ? process.type : null; } catch(e){ r.ptype = 'throw'; }
  try { r.ipcRenderer = typeof window.ipcRenderer; } catch(e){ r.ipcRenderer = 'throw'; }
  try { r.electronApi = typeof window.electron; } catch(e){ r.electronApi = 'throw'; }
  try { r.psProfile = typeof window.__privacyShieldProfile; } catch(e){ r.psProfile = 'throw'; }
  try { r.webdriver = navigator.webdriver; } catch(e){ r.webdriver = 'throw'; }
  try { r.chromeRuntime = !!(window.chrome && window.chrome.runtime); } catch(e){ r.chromeRuntime='throw'; }
  try { r.uaData = !!(navigator.userAgentData); } catch(e){ r.uaData='throw'; }
  try { r.suspectGlobals = Object.getOwnPropertyNames(window).filter(function(k){return /^(process|require|module|global|Buffer|__dirname|__filename|electron|ipcRenderer|_electron)/.test(k) || /privacyShield|__ps|antidetect/i.test(k);}); } catch(e){ r.suspectGlobals = 'throw'; }
  document.title = 'PSCHK' + JSON.stringify(r);
`;
const DATAURL = "data:text/html,<html><head><title>x</title><script>" + encodeURIComponent(CHECK) + "<\\/script></head><body>probe</body></html>";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let page = null;
  for (const c of b.contexts()) for (const p of c.pages()) { let u=""; try{u=p.url();}catch(_){}
    if (u.startsWith("http")) { page = p; break; } }
  if (!page) { L("no browsing tab — open Profile 5"); await b.close(); return; }

  // Navigate to a real site first (data: URLs can behave oddly), then inject an
  // inline script element into the live page main world.
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e=>L("nav:",e.message));
  const title = await page.evaluate((code) => {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.textContent = code;
      document.documentElement.appendChild(s);
      setTimeout(() => resolve(document.title), 100);
    });
  }, CHECK).catch(e => "EVAL FAIL " + e.message);

  const json = String(title).startsWith("PSCHK") ? String(title).slice(5) : title;
  L("=== WHAT A WEBSITE SCRIPT SEES IN YOUR APP ===");
  try {
    const r = JSON.parse(json);
    for (const k of Object.keys(r)) L(("  " + k).padEnd(20), ":", JSON.stringify(r[k]));
    L("\n=== VERDICT ===");
    const leaks = [];
    if (r.process !== "undefined") leaks.push("process exposed ("+r.process+")");
    if (r.electron) leaks.push("process.versions.electron = " + r.electron);
    if (r.require !== "undefined") leaks.push("require exposed");
    if (r.module !== "undefined") leaks.push("module exposed");
    if (r.global !== "undefined") leaks.push("global exposed");
    if (r.ipcRenderer !== "undefined") leaks.push("window.ipcRenderer exposed");
    if (r.psProfile !== "undefined") leaks.push("window.__privacyShieldProfile exposed ("+r.psProfile+")");
    if (r.webdriver === true) leaks.push("navigator.webdriver = true");
    if (Array.isArray(r.suspectGlobals) && r.suspectGlobals.length) leaks.push("suspect globals: " + r.suspectGlobals.join(","));
    L(leaks.length ? "LEAKS FOUND:\n  - " + leaks.join("\n  - ") : "NO Node/Electron leaks detected");
  } catch (e) { L("parse fail:", json); }
  await b.close();
})();
