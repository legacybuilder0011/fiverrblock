"use strict";
// Launch a browser on a throwaway profile with extra flags and report what a page sees.
// node flag-probe.js <exe> [flags...]
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const { spawn, execSync } = require("child_process");
const [exe, ...flags] = process.argv.slice(2);
const PAGE = `<!doctype html><script>(async()=>{const r={};
r.gpuApi=!!navigator.gpu;try{const a=navigator.gpu&&await navigator.gpu.requestAdapter();r.adapter=a?(a.info?a.info.vendor+"/"+a.info.architecture:"yes"):String(a)}catch(e){r.adapter=String(e)}
r.workerGpu=await new Promise(res=>{const w=new Worker(URL.createObjectURL(new Blob(['postMessage(!!navigator.gpu)'])));w.onmessage=e=>res(e.data);setTimeout(()=>res("timeout"),3000)});
r.screen=[screen.width,screen.height,screen.availWidth,screen.availHeight,devicePixelRatio,screen.colorDepth].join(",");r.outer=[outerWidth,outerHeight].join(",");r.touch=navigator.maxTouchPoints;
try{const g=document.createElement("canvas").getContext("webgl");const e=g.getExtension("WEBGL_debug_renderer_info");r.gl=g.getParameter(e.UNMASKED_RENDERER_WEBGL)}catch(e){r.gl=String(e)}
r.geoPerm=await navigator.permissions.query({name:"geolocation"}).then(p=>p.state);
await fetch("/r",{method:"POST",body:JSON.stringify(r)})})()</script>`;
let done = false;
const srv = http.createServer((q, s) => {
  if (q.method === "POST") { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => { console.log(b); s.end("ok"); finish(); }); return; }
  s.setHeader("content-type", "text/html"); s.end(PAGE);
}).listen(0, "127.0.0.1", () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "ps-flag-"));
  const child = spawn(exe, [`--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", ...flags, `http://127.0.0.1:${srv.address().port}/`], { stdio: "ignore" });
  global.finish = () => { if (done) return; done = true; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {} setTimeout(() => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} process.exit(0); }, 1500); };
  setTimeout(() => { console.log("timeout"); finish(); }, 30000);
});
function finish() { global.finish(); }
