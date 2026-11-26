"use strict";
// Patched Chromium + the slim fingerprint extension on a throwaway profile:
// does a page see the profile's screen/touch/GPU/WebGPU, and does Google sign-in
// still see the untouched browser? node patched-gaps-test.js <chrome.exe> <extDir>
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, execSync } = require("child_process");
const [exe, extDir] = process.argv.slice(2);
const PROBE = process.env.PROBE || `(async()=>{const r={screen:[screen.width,screen.height,screen.availWidth,screen.availHeight,devicePixelRatio].join(","),mq:matchMedia("(device-width: "+screen.width+"px)").matches,touch:navigator.maxTouchPoints,gpu:"gpu" in navigator,cores:navigator.hardwareConcurrency,tz:Intl.DateTimeFormat().resolvedOptions().timeZone};
try{const g=document.createElement("canvas").getContext("webgl");const e=g.getExtension("WEBGL_debug_renderer_info");r.gl=g.getParameter(e.UNMASKED_RENDERER_WEBGL)}catch(e){r.gl=String(e)}
r.workerGl=await new Promise(res=>{try{const w=new Worker(URL.createObjectURL(new Blob(['const g=new OffscreenCanvas(1,1).getContext("webgl");const e=g.getExtension("WEBGL_debug_renderer_info");postMessage({gl:g.getParameter(e.UNMASKED_RENDERER_WEBGL),gpu:"gpu" in navigator,tz:Intl.DateTimeFormat().resolvedOptions().timeZone})'])));w.onmessage=e=>res(e.data);setTimeout(()=>res("timeout"),3000)}catch(e){res(String(e))}});
r.native=Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Screen.prototype,"width").get).includes("[native code]");
return r})()`;
(async () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gaps-"));
  const args = [`--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=9556",
    "--fingerprint=804684135", "--fingerprint-platform=windows", "--fingerprint-hardware-concurrency=12", "--timezone=America/New_York",
    "--disable-spoofing=font", "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${extDir}`, "about:blank"];
  const child = spawn(exe, args, { stdio: "ignore" });
  const end = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {} setTimeout(() => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} process.exit(0); }, 1500); };
  setTimeout(() => { console.log("timeout"); end(); }, 90000);
  let v;
  for (let i = 0; i < 30 && !v; i++) { await new Promise((r) => setTimeout(r, 500)); try { v = await (await fetch("http://127.0.0.1:9556/json/version")).json(); } catch (_) {} }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0; const waits = {};
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits[i] = res; ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waits[m.id]) { waits[m.id](m); delete waits[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  for (const url of ["https://example.com/", "https://accounts.google.com/"]) {
    const t = await send("Target.createTarget", { url });
    const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
    let r;
    for (let k = 0; k < 6; k++) {
      await new Promise((res) => setTimeout(res, 4000));
      r = await send("Runtime.evaluate", { expression: PROBE, awaitPromise: true, returnByValue: true }, a.result.sessionId);
      if (r.result && r.result.result && r.result.result.value) break;
    }
    console.log(url, JSON.stringify(r.result && r.result.result ? r.result.result.value : r));
  }
  end();
})();

