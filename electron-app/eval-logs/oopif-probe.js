"use strict";
// Decisive test in the REAL running profile: open a fresh tab and navigate it to
// a standard reCAPTCHA demo (same out-of-process-iframe mechanism as the fbsbx
// captcha), and report whether the reCAPTCHA iframe renders or aborts.
const { chromium } = require("playwright-core");
const DEMO = "https://www.google.com/recaptcha/api2/demo";
function ts(){return new Date().toISOString().slice(11,23);}
function L(...a){console.log(ts(),a.join(" "));}

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  L("connected");
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let u=""; try{u=p.url();}catch(_){}
      if (u.startsWith("http")) { page = p; L("using tab:", u); break; }
    }
    if (page) break;
  }
  if (!page) { L("no browsing tab found — open Profile 5 first"); await browser.close(); return; }

  let aborted = 0;
  page.on("requestfailed", (r)=>{ const u=r.url(); const err=r.failure()&&r.failure().errorText; if(/recaptcha|gstatic|captcha/i.test(u)) { aborted++; L("REQFAIL", u.slice(0,100), "::", err); }});
  page.on("framenavigated",(f)=>{const u=f.url(); if(/recaptcha|gstatic/i.test(u)) L("FRAMEnav", u.slice(0,100));});

  L("navigating to reCAPTCHA demo...");
  try { await page.goto(DEMO, { waitUntil:"domcontentloaded", timeout:45000 }); } catch(e){ L("nav err", e.message.slice(0,100)); }
  await page.waitForTimeout(6000);

  const info = await page.evaluate(()=>{
    const frames = Array.from(document.querySelectorAll("iframe")).map(f=>{const r=f.getBoundingClientRect();return{src:(f.src||"").slice(0,70),w:Math.round(r.width),h:Math.round(r.height)};});
    const anchor = frames.find(f=>/recaptcha.*anchor/.test(f.src));
    return { frameCount: frames.length, frames, anchorVisible: !!(anchor && anchor.w>0 && anchor.h>0) };
  }).catch(e=>({err:e.message}));
  L("RESULT:", JSON.stringify(info));
  L("VERDICT:", info && info.anchorVisible === true ? "PASS — reCAPTCHA OOPIF RENDERS (captcha fixed)" : "FAIL — still blank/aborted");
  L("captcha aborts:", aborted);
  await browser.close();
})();
