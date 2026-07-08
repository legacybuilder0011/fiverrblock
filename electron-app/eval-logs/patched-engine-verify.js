"use strict";
// Verify the patched-chromium engine THROUGH the manager (openProfileWindow path):
//   - two profiles (different seed + different GPU) => two different device fps
//   - same profile relaunched => identical device fp
//   - GPU renderer STRING now spoofed by the layered extension (closes the C++ gap)
// Run: node_modules/electron/dist/electron.exe eval-logs/patched-engine-verify.js
// Requires the extracted patched binary; this harness junctions it into userData.

const { app } = require("electron");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const store = require(path.join(__dirname, "..", "src", "profile-store"));
const realBrowser = require(path.join(__dirname, "..", "src", "real-browser-manager"));

// Junction the already-extracted patched binary into the location the manager
// expects (userData/fingerprint-chromium/<dirname>), so we don't re-download.
function ensureBinary() {
  const wantDir = path.dirname(realBrowser.patchedChromiumBinary()); // .../fingerprint-chromium/<dirname>
  const parent = path.dirname(wantDir);
  fs.mkdirSync(parent, { recursive: true });
  if (realBrowser.patchedChromiumReady()) return true;
  const src = path.join(process.env.CLAUDE_JOB_DIR, "tmp", "fpchromium", "ungoogled-chromium_148.0.7778.215-1.1_windows_x64");
  if (!fs.existsSync(path.join(src, "chrome.exe"))) { console.log("SRC MISSING:", src); return false; }
  try { fs.symlinkSync(src, wantDir, "junction"); } catch (e) { console.log("junction failed:", e.message); return false; }
  return realBrowser.patchedChromiumReady();
}

function profile(id, seed, gpuVendor, gpuRenderer, tz, geo) {
  return {
    id, name: id, os: "windows", browserApp: "chrome", engine: "patched-chromium",
    proxy: { networkMode: "direct", enabled: false },
    fingerprint: {
      browser: "chrome", fingerprintSeed: seed,
      webglInfo: "manual", webglVendor: gpuVendor, webglRenderer: gpuRenderer,
      timezone: "manual", timezoneValue: tz, timezoneOffset: tz === "Europe/Berlin" ? -60 : 300,
      geolocation: "manual", geoLat: geo[0], geoLng: geo[1], geoAccuracy: 40,
      canvas: "noise", webgl: "noise", audio: "noise"
    }
  };
}

const PA = profile("patched-A", "alpha-seed", "Google Inc. (AMD)", "ANGLE (AMD, AMD Radeon RX 6800 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Europe/Berlin", [52.52, 13.405]);
const PB = profile("patched-B", "beta-seed", "Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", "America/New_York", [40.71, -74.0]);

const PAGE = `<!doctype html><meta charset=utf-8><title>fp</title><body>fp<script>
(async function(){
  var c=document.createElement("canvas");c.width=240;c.height=60;var x=c.getContext("2d");
  x.textBaseline="top";x.font="16px Arial";x.fillStyle="#f60";x.fillRect(10,10,120,30);
  x.fillStyle="#069";x.fillText("Patched❤PC",12,14);var canvas=c.toDataURL().slice(-44);
  var gl=document.createElement("canvas").getContext("webgl");var e=gl.getExtension("WEBGL_debug_renderer_info");
  var glV=e?gl.getParameter(e.UNMASKED_VENDOR_WEBGL):"";var glR=e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):"";
  var audio="na";try{var Off=window.OfflineAudioContext;var oc=new Off(1,44100,44100);var o=oc.createOscillator();
  o.type="triangle";o.frequency.value=10000;var cp=oc.createDynamicsCompressor();o.connect(cp);cp.connect(oc.destination);
  o.start(0);var b=await oc.startRendering();var d=b.getChannelData(0);var s=0;for(var i=4000;i<5000;i++)s+=Math.abs(d[i]);audio=s.toString();}catch(_){}
  var geo=await new Promise(function(r){try{navigator.geolocation.getCurrentPosition(function(p){r(p.coords.latitude+","+p.coords.longitude);},function(){r("denied");},{timeout:2000});}catch(_){r("noapi");}});
  navigator.sendBeacon("/report?run="+RUNLABEL,JSON.stringify({ua:navigator.userAgent,cores:navigator.hardwareConcurrency,mem:navigator.deviceMemory,
    tz:Intl.DateTimeFormat().resolvedOptions().timeZone,canvas:canvas,glV:glV,glR:glR,audio:audio,geo:geo,webdriver:navigator.webdriver}));
})();
</script></body>`;

const results = {};
const resolvers = {};
function fpHash(r){return crypto.createHash("sha256").update([r.canvas,r.glV,r.glR,r.audio].join("~")).digest("hex").slice(0,16);}

async function run(label, prof, port) {
  return new Promise(async (resolve) => {
    const res = await realBrowser.launchProfile(prof, `http://127.0.0.1:${port}/?run=${label}`, {});
    console.log(`[${label}] launch:`, JSON.stringify({ ok: res.ok, seed: res.seed, reason: res.reason, detail: res.detail }));
    if (!res.ok) return resolve(false);
    const timer = setTimeout(async () => { await realBrowser.closeProfile(prof.id).catch(()=>{}); resolve(false); }, 20000);
    resolvers[label] = async () => { clearTimeout(timer); await realBrowser.closeProfile(prof.id).catch(()=>{}); setTimeout(() => resolve(true), 800); };
  });
}

app.whenReady().then(async () => {
  if (!ensureBinary()) { console.log("BINARY NOT READY — abort"); return app.quit(); }
  console.log("patched binary:", realBrowser.patchedChromiumBinary());
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/report")) { let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ res.end("ok");
      const run=new URL(req.url,"http://x").searchParams.get("run"); try{results[run]=JSON.parse(b);}catch(_){}
      if(resolvers[run])resolvers[run](); }); return; }
    const label=new URL(req.url,"http://x").searchParams.get("run")||"";
    res.setHeader("Content-Type","text/html; charset=utf-8"); res.end(PAGE.replace("RUNLABEL", JSON.stringify(label)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  await run("A1", PA, port);
  await run("A2", PA, port);   // relaunch same profile → must match A1
  await run("B1", PB, port);   // different profile → must differ
  server.close();

  console.log("\n============ RESULTS ============");
  for (const k of ["A1","A2","B1"]) { const r=results[k]; if(!r){console.log(k,"NO REPORT");continue;}
    console.log(`[${k}] fp=${fpHash(r)} cores=${r.cores} mem=${r.mem} tz=${r.tz} glR=${r.glR} canvas=${r.canvas} audio=${r.audio} geo=${r.geo} wd=${r.webdriver}`); }
  console.log("\n============ VERDICT ============");
  const A1=results.A1,A2=results.A2,B1=results.B1;
  if(A1&&A2) console.log(`STABILITY (profile A twice): ${fpHash(A1)===fpHash(A2)?"PASS":"FAIL"} (${fpHash(A1)} vs ${fpHash(A2)})`);
  if(A1&&B1){
    console.log(`UNIQUENESS (A vs B): ${fpHash(A1)!==fpHash(B1)?"PASS":"FAIL"} (${fpHash(A1)} vs ${fpHash(B1)})`);
    console.log(`  canvas differ: ${A1.canvas!==B1.canvas} | GPU string differ: ${A1.glR!==B1.glR} | audio differ: ${A1.audio!==B1.audio} | tz differ: ${A1.tz!==B1.tz}`);
    console.log(`  GPU string spoofed to profile value? A=${A1.glR.includes("6800")} B=${B1.glR.includes("3060")}`);
    console.log(`  geo spoofed? A=${A1.geo} B=${B1.geo}`);
  }
  app.quit();
});
