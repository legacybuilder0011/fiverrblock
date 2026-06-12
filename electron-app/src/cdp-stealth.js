"use strict";

// Inject the fingerprint spoofer via CDP so it runs in EVERY frame (main + iframes)
// before any page script. The Electron preload only fires in the top frame, which
// is why bot.sannysoft's HEADCHR_IFRAME test still detected us — iframes were
// unspoofed. Page.addScriptToEvaluateOnNewDocument runs in every frame at
// document_start, fixing iframe leaks.
//
// We reuse the existing preload source as the payload, stubbing out the
// ipcRenderer.require so the script is self-contained and the config is baked
// in literal-JSON at injection time. Keeping a single source of truth means
// fingerprint logic doesn't drift between the two delivery paths.

const fs = require("fs");
const path = require("path");

const PRELOAD_PATH = path.join(__dirname, "preload-fingerprint.js");
let cachedSource = null;

function loadSource() {
  if (cachedSource == null) {
    cachedSource = fs.readFileSync(PRELOAD_PATH, "utf8");
  }
  return cachedSource;
}

function buildPayload(config) {
  const cfgJson = JSON.stringify(config || {});
  // Replace the electron require with an ipcRenderer stub whose sendSync returns
  // our literal config. One surgical replacement — rest of the preload runs
  // verbatim, so spoof behaviour stays identical across both delivery paths.
  return loadSource().replace(
    /const\s*\{\s*ipcRenderer\s*\}\s*=\s*require\(["']electron["']\)\s*;?/,
    `const ipcRenderer = { sendSync: function () { return ${cfgJson}; } };`
  );
}

// Worker threads (Web/Shared/Service) have their OWN navigator, Intl and Date.
// The frame preload never reaches them, so a detector that reads UA / core count
// / timezone inside a Worker and compares to the main thread sees a mismatch —
// a well-known CreepJS / PerimeterX correlation tell. This compact payload runs
// the high-value subset that is actually readable from worker scope. We keep it
// minimal (no DOM globals) so it can't throw in the worker and break the page.
function buildWorkerPayload(config) {
  const c = config || {};
  const worker = {
    ua: c.userAgent || "",
    platform: c.platform || "",
    hc: Number(c.hardwareConcurrency) || 0,
    dm: Number(c.deviceMemory) || 0,
    lang: c.language || "en-US",
    langs: Array.isArray(c.languages) ? c.languages : [c.language || "en-US"],
    tz: c.spoofTimezone ? (c.timezone || "") : "",
    mobile: Boolean(c._mobile)
  };
  const wJson = JSON.stringify(worker);
  return `(function(){"use strict";try{var W=${wJson};
    function ro(o,p,v){try{Object.defineProperty(o,p,{get:function(){return typeof v==="function"?v():v;},configurable:true});}catch(e){}}
    if(typeof navigator!=="undefined"){
      if(W.ua){ro(navigator,"userAgent",W.ua);ro(navigator,"appVersion",W.ua.replace(/^Mozilla\\//,""));}
      if(W.platform)ro(navigator,"platform",W.platform);
      if(W.hc)ro(navigator,"hardwareConcurrency",W.hc);
      if(W.dm)ro(navigator,"deviceMemory",W.dm);
      if(W.lang)ro(navigator,"language",W.lang);
      if(W.langs)ro(navigator,"languages",Object.freeze(W.langs.slice()));
    }
    if(W.tz&&typeof Intl!=="undefined"){
      try{var OR=Intl.DateTimeFormat.prototype.resolvedOptions;Intl.DateTimeFormat.prototype.resolvedOptions=function(){var r=OR.call(this);r.timeZone=W.tz;return r;};}catch(e){}
      try{
        var probe=new Intl.DateTimeFormat("en-US",{timeZone:W.tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
        Date.prototype.getTimezoneOffset=function(){try{var d=this instanceof Date?this:new Date();var p=probe.formatToParts(d).reduce(function(a,x){a[x.type]=x.value;return a;},{});var u=Date.UTC(+p.year,p.month-1,+p.day,+p.hour===24?0:+p.hour,+p.minute,+p.second);return Math.round((d.getTime()-u)/60000);}catch(e){return 0;}};
      }catch(e){}
    }
  }catch(e){}})();`;
}

async function attachStealth(webContents, config, logger) {
  if (!webContents || webContents.isDestroyed()) return false;
  const log = typeof logger === "function" ? logger : () => {};

  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }
  } catch (err) {
    log(`stealth-cdp attach failed: ${err.message || err}`);
    return false;
  }

  try {
    await webContents.debugger.sendCommand("Page.enable");
  } catch (err) {
    log(`stealth-cdp Page.enable failed: ${err.message || err}`);
    // Continue anyway — Page.addScriptToEvaluateOnNewDocument often works without explicit enable
  }

  try {
    const payload = buildPayload(config);
    const result = await webContents.debugger.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: payload }
    );
    log(`stealth-cdp installed profile=${(config && config._profileId) || "?"} bytes=${payload.length} id=${result && result.identifier}`);
  } catch (err) {
    log(`stealth-cdp install failed: ${err.message || err}`);
    return false;
  }

  // Auto-attach to worker targets and inject the worker-scope spoof so the
  // navigator/timezone a detector reads inside a Worker matches the main thread.
  try {
    const workerPayload = buildWorkerPayload(config);
    webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Target.attachedToTarget") return;
      const sessionId = params && params.sessionId;
      const type = params && params.targetInfo && params.targetInfo.type;
      if (!sessionId) return;
      const isWorker = /worker/i.test(String(type || ""));
      // ALWAYS resume the paused target afterwards — a target left waiting on the
      // debugger (e.g. an out-of-process iframe) would otherwise hang the page.
      const resume = () => webContents.debugger
        .sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .catch(() => {});
      if (!isWorker) { resume(); return; }
      webContents.debugger
        .sendCommand("Runtime.evaluate", { expression: workerPayload, includeCommandLineAPI: false }, sessionId)
        .catch((e) => log(`stealth-cdp worker inject failed: ${e && (e.message || e)}`))
        .finally(resume);
    });
    await webContents.debugger.sendCommand("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    });
    log(`stealth-cdp worker auto-attach armed profile=${(config && config._profileId) || "?"}`);
  } catch (err) {
    // Non-fatal: frame spoofing still works even if worker auto-attach is unavailable.
    log(`stealth-cdp worker auto-attach unavailable: ${err && (err.message || err)}`);
  }
  return true;
}

module.exports = { attachStealth };
