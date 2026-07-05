process.env.CAMOUFOX_INSTALL_DIR = "C:/Users/UPCOMING/AppData/Roaming/privacy-shield/camoufox-engine";
const fs = require("fs");
const path = require("path");
const BASE = "C:/Users/UPCOMING/AppData/Roaming/privacy-shield/camoufox-profiles";
function extract() {
  const h=(s)=>{let x=0x811c9dc5;for(let i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,0x01000193);}return (x>>>0).toString(16);};
  const o={ua:navigator.userAgent, hwc:navigator.hardwareConcurrency, dm:navigator.deviceMemory, screen:screen.width+"x"+screen.height, tz:Intl.DateTimeFormat().resolvedOptions().timeZone};
  try{const c=document.createElement("canvas");c.width=240;c.height=60;const x=c.getContext("2d");x.textBaseline="top";x.font="14px Arial";x.fillStyle="#f60";x.fillRect(10,10,100,30);x.fillStyle="#069";x.fillText("Privacy \u{1F512} test",12,15);o.canvas=h(c.toDataURL());}catch(e){o.canvas="ERR:"+e.message;}
  try{const gl=document.createElement("canvas").getContext("webgl");const ext=gl.getExtension("WEBGL_debug_renderer_info");o.webgl=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):"(none)";}catch(e){o.webgl="ERR:"+e.message;}
  return o;
}
(async () => {
  const id = process.argv[2];
  try { fs.mkdirSync(BASE, { recursive: true }); } catch(_){}
  const fpFile = path.join(BASE, id + "-fingerprint.json");
  let fingerprint=null;
  try { if (fs.existsSync(fpFile)) fingerprint=JSON.parse(fs.readFileSync(fpFile,"utf8")); } catch(_){}
  if (!fingerprint) {
    const { FingerprintGenerator } = require("fingerprint-generator");
    fingerprint = new FingerprintGenerator({ browsers:["firefox"], operatingSystems:["windows"] }).getFingerprint({ operatingSystems:["windows"] }).fingerprint;
    fs.writeFileSync(fpFile, JSON.stringify(fingerprint));
  }
  const { Camoufox } = await import("camoufox-js");
  const seedInt = (s)=>{let x=0x811c9dc5;for(let i=0;i<s.length;i++){x^=s.charCodeAt(i);x=Math.imul(x,0x01000193);}return x>>>0;};
  const aaOffset = (seedInt(id) % 101) - 50;
  const spacingSeed = seedInt(id + "|spacing") % 1073741824;
  const vc = fingerprint.videoCard || {};
  const opts = { headless:true, os:"windows", humanize:false, block_webrtc:true, locale:"en-US", user_data_dir: path.join(BASE, id), fingerprint,
    config: { "canvas:aaOffset": aaOffset, "canvas:aaCapOffset": true, "fonts:spacing_seed": spacingSeed } };
  if (vc.vendor && vc.renderer) opts.webgl_config = [vc.vendor, vc.renderer];
  const browser = await Camoufox(opts);
  const page = (browser.pages && browser.pages().length) ? browser.pages()[0] : await browser.newPage();
  await page.goto("https://example.com/").catch(()=>{});
  const data = await page.evaluate(extract);
  console.log("CFX_JSON:"+JSON.stringify({id, ...data}));
  await browser.close();
  process.exit(0);
})().catch(e=>{console.log("CFX_ERR:"+(e&&e.message));process.exit(1);});
