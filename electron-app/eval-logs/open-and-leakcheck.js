"use strict";
const { chromium } = require("playwright-core");
function L(...a){console.log(a.join(" "));}

const CHECK = `
  var r={};
  function t(f){try{return f();}catch(e){return 'throw';}}
  r.process=t(function(){return typeof process;});
  r.require=t(function(){return typeof require;});
  r.module=t(function(){return typeof module;});
  r.global=t(function(){return typeof global;});
  r.Buffer=t(function(){return typeof Buffer;});
  r.electron=t(function(){return (typeof process!=='undefined'&&process&&process.versions)?(process.versions.electron||null):null;});
  r.ipcRenderer=t(function(){return typeof window.ipcRenderer;});
  r.psProfile=t(function(){return typeof window.__privacyShieldProfile;});
  r.webdriver=t(function(){return navigator.webdriver;});
  r.chromeRuntime=t(function(){return !!(window.chrome&&window.chrome.runtime);});
  r.suspect=t(function(){return Object.getOwnPropertyNames(window).filter(function(k){return /privacyShield|ipcRenderer|__electron|electronAPI/i.test(k)||/^(process|require|module|global|Buffer)$/.test(k);});});
  document.title='PSCHK'+JSON.stringify(r);
`;

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let mgr = null;
  for (const c of b.contexts()) for (const p of c.pages()) { let u=""; try{u=p.url();}catch(_){}
    if (u.includes("profiles.html")) mgr = p; }
  if (!mgr) { L("no manager"); await b.close(); return; }

  // Click Start within the New Profile 5 card.
  const clicked = await mgr.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("div,li")).filter(e => /New Profile 5/i.test(e.textContent || ""));
    // pick the smallest element that still contains a Start button (the card)
    let best = null;
    for (const c of cards) { const btn = Array.from(c.querySelectorAll("button")).find(b => /^start/i.test((b.textContent||"").trim())); if (btn) { if (!best || c.textContent.length < best.textContent.length) best = c; } }
    if (!best) return "no-card";
    const btn = Array.from(best.querySelectorAll("button")).find(b => /^start/i.test((b.textContent||"").trim()));
    if (!btn) return "no-btn";
    btn.click();
    return "clicked";
  });
  L("start click:", clicked);

  // Wait for a browsing tab to appear.
  let page = null;
  for (let i = 0; i < 30; i++) {
    for (const c of b.contexts()) for (const p of c.pages()) { let u=""; try{u=p.url();}catch(_){}
      if (u.startsWith("http") || u.includes("browser-start")) { page = p; } }
    if (page) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!page) { L("no browsing tab appeared after Start"); await b.close(); return; }
  L("browsing tab:", page.url());

  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e=>L("nav:",e.message));
  const title = await page.evaluate((code) => new Promise((resolve) => {
    const s = document.createElement("script"); s.textContent = code; document.documentElement.appendChild(s);
    setTimeout(() => resolve(document.title), 120);
  }), CHECK).catch(e => "EVAL FAIL " + e.message);
  const json = String(title).startsWith("PSCHK") ? String(title).slice(5) : title;
  L("\n=== 1.17.9 — WHAT A WEBSITE SEES ===");
  try {
    const r = JSON.parse(json);
    for (const k of Object.keys(r)) L(("  "+k).padEnd(16), ":", JSON.stringify(r[k]));
    const leaks = [];
    if (r.process!=="undefined") leaks.push("process");
    if (r.require!=="undefined") leaks.push("require");
    if (r.electron) leaks.push("electron="+r.electron);
    if (r.ipcRenderer!=="undefined") leaks.push("ipcRenderer");
    if (r.psProfile!=="undefined") leaks.push("__privacyShieldProfile("+r.psProfile+")");
    if (r.webdriver===true) leaks.push("webdriver");
    if (Array.isArray(r.suspect)&&r.suspect.length) leaks.push("suspect:"+r.suspect.join(","));
    L("\nVERDICT:", leaks.length ? "LEAKS: "+leaks.join(", ") : "CLEAN — no Node/Electron/antidetect artifacts on real sites");
  } catch(e){ L("parse fail:", json); }
  await b.close();
})();
