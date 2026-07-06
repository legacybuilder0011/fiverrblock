"use strict";
// A/B verify the OOPIF captcha fix without touching the app build.
// Replicates the app's CDP setup (Page.addScriptToEvaluateOnNewDocument +
// Target.setAutoAttach) against the reCAPTCHA demo, and checks whether the
// reCAPTCHA OOPIF renders under each setAutoAttach config.
//   A: waitForDebuggerOnStart:true  (current app behavior)   -> expect BROKEN
//   B: waitForDebuggerOnStart:false (proposed fix)           -> expect OK
//   C: waitForDebuggerOnStart:true + filter excludes iframes -> expect OK
const { chromium } = require("playwright-core");
const DEMO = "https://www.google.com/recaptcha/api2/demo";
function L(...a){console.log(a.join(" "));}

async function trial(label, autoAttachParams) {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newContext().then(c=>c.newPage());
  const cdp = await page.context().newCDPSession(page);

  // Replicate app: resume any non-worker target that attaches (so a paused OOPIF
  // isn't left hanging), mirroring cdp-stealth.js's handler.
  cdp.on("Target.attachedToTarget", (params)=>{
    const sid = params && params.sessionId;
    const type = params && params.targetInfo && params.targetInfo.type;
    if (!sid) return;
    const isWorker = /worker/i.test(String(type||""));
    if (!isWorker) { cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(()=>{}); }
  });

  await cdp.send("Page.enable").catch(()=>{});
  try { await cdp.send("Target.setAutoAttach", autoAttachParams); }
  catch(e){ L(label, "setAutoAttach ERROR:", e.message.slice(0,120)); await browser.close(); return "setAutoAttach-error"; }

  let aborted = false;
  page.on("requestfailed",(r)=>{ if(/recaptcha\/api2\/anchor/.test(r.url())) aborted = true; });

  try { await page.goto(DEMO, { waitUntil:"domcontentloaded", timeout:40000 }); } catch(_){}
  await page.waitForTimeout(5000);
  const rendered = await page.evaluate(()=>{
    const f = Array.from(document.querySelectorAll("iframe")).find(x=>/recaptcha.*anchor/.test(x.src||""));
    if(!f) return false; const r=f.getBoundingClientRect(); return r.width>10 && r.height>10;
  }).catch(()=>false);
  await browser.close();
  const verdict = rendered ? "RENDERED (ok)" : (aborted ? "ABORTED (broken)" : "MISSING (broken)");
  L(label, "->", verdict);
  return rendered;
}

(async()=>{
  const A = await trial("A waitForDebuggerOnStart:true ", { autoAttach:true, waitForDebuggerOnStart:true, flatten:true });
  const B = await trial("B waitForDebuggerOnStart:false", { autoAttach:true, waitForDebuggerOnStart:false, flatten:true });
  const C = await trial("C filter workers-only         ", { autoAttach:true, waitForDebuggerOnStart:true, flatten:true,
    filter:[{type:"worker"},{type:"shared_worker"},{type:"service_worker"},{exclude:true}] });
  L("");
  L("SUMMARY: A(current)=", A?"ok":"broken", " B(false)=", B?"ok":"broken", " C(filter)=", C?"ok":"broken");
})();
