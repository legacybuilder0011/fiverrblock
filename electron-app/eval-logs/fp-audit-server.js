"use strict";
// Full fingerprint audit: serves a page that reads everything a website can see,
// records the request headers, and saves one JSON per profile.
// node fp-audit-server.js <outDir> [port]  -> open http://127.0.0.1:<port>/?p=<label>
const http = require("http"), fs = require("fs"), path = require("path");
const [outDir, port = "47320"] = process.argv.slice(2);
const FONTS = ["Arial", "Calibri", "Cambria", "Segoe UI", "Consolas", "Tahoma", "Verdana", "Georgia", "Impact", "Comic Sans MS",
  "Papyrus", "Jokerman", "Rockwell", "Bodoni MT", "Wide Latin", "Helvetica Neue", "Menlo", "Monaco", "San Francisco", "Ubuntu",
  "DejaVu Sans", "Noto Sans", "Roboto", "Segoe UI Variable", "Bahnschrift", "Ink Free", "Sitka Text", "Leelawadee UI", "Nirmala UI"];
const PAGE = `<!doctype html><meta charset=utf-8><title>fp audit</title><pre id=o>running…</pre><script>
const h=async s=>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].slice(0,6).map(x=>x.toString(16).padStart(2,"0")).join("")};
(async()=>{const r={};const n=navigator;
r.ua=n.userAgent;r.appVersion=n.appVersion;r.platform=n.platform;r.vendor=n.vendor;
try{r.uaData=await n.userAgentData.getHighEntropyValues(["platform","platformVersion","architecture","bitness","model","fullVersionList","uaFullVersion"]);}catch(e){r.uaData=String(e)}
r.langs=n.languages;r.lang=n.language;r.intlLocale=Intl.DateTimeFormat().resolvedOptions().locale;
r.tz=Intl.DateTimeFormat().resolvedOptions().timeZone;r.offset=new Date().getTimezoneOffset();r.date=String(new Date()).slice(16);
r.cores=n.hardwareConcurrency;r.mem=n.deviceMemory;r.touch=n.maxTouchPoints;
r.screen={w:screen.width,h:screen.height,aw:screen.availWidth,ah:screen.availHeight,cd:screen.colorDepth,pd:screen.pixelDepth,dpr:devicePixelRatio,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,orient:screen.orientation&&screen.orientation.type};
// canvas
try{const c=document.createElement("canvas");c.width=240;c.height=60;const x=c.getContext("2d");x.textBaseline="top";x.font="16px Arial";x.fillStyle="#f60";x.fillRect(100,1,62,20);x.fillStyle="#069";x.fillText("Cwm fjordbank glyphs vext quiz 😃",2,15);x.fillStyle="rgba(102,204,0,0.7)";x.fillText("Cwm fjordbank",4,35);
 const d1=c.toDataURL();const d2=c.toDataURL();r.canvas=await h(d1);r.canvasStable=d1===d2;}catch(e){r.canvas=String(e)}
// webgl
try{const g=document.createElement("canvas").getContext("webgl");const e=g.getExtension("WEBGL_debug_renderer_info");
 r.webgl={vendor:g.getParameter(e.UNMASKED_VENDOR_WEBGL),renderer:g.getParameter(e.UNMASKED_RENDERER_WEBGL),maxTex:g.getParameter(g.MAX_TEXTURE_SIZE),ext:g.getSupportedExtensions().length};
 g.clearColor(0.2,0.4,0.6,1);g.clear(g.COLOR_BUFFER_BIT);const px=new Uint8Array(4);g.readPixels(0,0,1,1,g.RGBA,g.UNSIGNED_BYTE,px);r.webgl.pixel=[...px].join(",");}catch(e){r.webgl=String(e)}
// webgl in worker (OffscreenCanvas) - real GPU leaks here if only the page is patched
r.workerGl=await new Promise(res=>{try{const w=new Worker(URL.createObjectURL(new Blob(['try{const g=new OffscreenCanvas(1,1).getContext("webgl");const e=g.getExtension("WEBGL_debug_renderer_info");postMessage({renderer:g.getParameter(e.UNMASKED_RENDERER_WEBGL),tz:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency,ua:navigator.userAgent.slice(-40)})}catch(x){postMessage(String(x))}'])));w.onmessage=e=>res(e.data);setTimeout(()=>res("timeout"),4000)}catch(e){res(String(e))}});
// webgpu
try{if(n.gpu){const a=await n.gpu.requestAdapter();r.webgpu=a?(a.info?{vendor:a.info.vendor,arch:a.info.architecture,device:a.info.device,desc:a.info.description}:"adapter, no info"):"no adapter";}else r.webgpu="not available"}catch(e){r.webgpu=String(e)}
// audio
try{const ac=new OfflineAudioContext(1,44100,44100);const o=ac.createOscillator();o.type="triangle";o.frequency.value=10000;const cp=ac.createDynamicsCompressor();o.connect(cp);cp.connect(ac.destination);o.start(0);const buf=await ac.startRendering();const d=buf.getChannelData(0);let s=0;for(let i=4500;i<5000;i++)s+=Math.abs(d[i]);r.audio=s.toFixed(10);}catch(e){r.audio=String(e)}
// client rects
try{const sp=document.createElement("span");sp.style.font="13.37px Times New Roman";sp.textContent="Client rects measure ÄÖÜ 123";document.body.appendChild(sp);const b=sp.getBoundingClientRect();r.rects=[b.width,b.height].map(v=>v.toFixed(6)).join("x");sp.remove();}catch(e){r.rects=String(e)}
// fonts
try{const base=["monospace","serif","sans-serif"];const m=document.createElement("span");m.style.fontSize="72px";m.textContent="mmmmmmmmmmlli";document.body.appendChild(m);const w={};for(const b of base){m.style.fontFamily=b;w[b]=m.offsetWidth+"x"+m.offsetHeight;}
 r.fonts=${JSON.stringify(FONTS)}.filter(f=>base.some(b=>{m.style.fontFamily="'"+f+"',"+b;return (m.offsetWidth+"x"+m.offsetHeight)!==w[b];}));m.remove();}catch(e){r.fonts=String(e)}
// media devices
try{const ds=await n.mediaDevices.enumerateDevices();r.media=ds.map(d=>d.kind).reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{});r.mediaLabels=ds.some(d=>d.label);}catch(e){r.media=String(e)}
// geolocation
r.geoPerm=await n.permissions.query({name:"geolocation"}).then(p=>p.state).catch(e=>String(e));
r.geo=r.geoPerm==="denied"?"denied":await new Promise(res=>{try{n.geolocation.getCurrentPosition(p=>res([p.coords.latitude.toFixed(4),p.coords.longitude.toFixed(4),p.coords.accuracy]),e=>res("error "+e.code+" "+e.message),{timeout:5000});setTimeout(()=>res("no answer (prompt?)"),6000)}catch(e){res(String(e))}});
// network info
r.conn=n.connection?{type:n.connection.type,eff:n.connection.effectiveType,downlink:n.connection.downlink,rtt:n.connection.rtt}:"n/a";
// privacy extras
r.dnt=n.doNotTrack;r.gpc=n.globalPrivacyControl;r.webdriver=n.webdriver;r.plugins=n.plugins.length;r.pdf=n.pdfViewerEnabled;r.cookies=n.cookieEnabled;
r.storage=await n.storage.estimate().then(e=>Math.round(e.quota/1e9)+"GB quota").catch(e=>String(e));
r.toStringClean=Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL).includes("[native code]");
// ports: probe local ports a site would scan
r.ports={};for(const p of [3389,5938,5900,9222]){const t=performance.now();try{await fetch("http://127.0.0.1:"+p+"/",{mode:"no-cors",signal:AbortSignal.timeout(3000)});r.ports[p]="open "+Math.round(performance.now()-t)+"ms"}catch(e){r.ports[p]=(e.name==="TimeoutError"?"timeout":"refused/blocked")+" "+Math.round(performance.now()-t)+"ms"}}
// webrtc
r.rtc=await new Promise(res=>{const c=[];try{const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});pc.createDataChannel("x");pc.onicecandidate=e=>{if(e.candidate)c.push(e.candidate.candidate.split(" ").slice(4,8).join(" "));else res(c)};pc.createOffer().then(o=>pc.setLocalDescription(o));setTimeout(()=>res(c),5000)}catch(e){res(String(e))}});
// IP
try{r.ip=(await (await fetch("https://api.ipify.org?format=json")).json()).ip}catch(e){r.ip=String(e)}
await fetch("/r"+location.search,{method:"POST",body:JSON.stringify(r)});document.getElementById("o").textContent="done";})();
</script>`;
const headers = {};
http.createServer((q, s) => {
  const label = new URL(q.url, "http://x").searchParams.get("p") || "x";
  if (q.method === "POST") {
    let b = ""; q.on("data", (d) => (b += d));
    q.on("end", () => { const r = JSON.parse(b); r.headers = headers[label]; fs.writeFileSync(path.join(outDir, label + ".json"), JSON.stringify(r, null, 1)); console.log("saved", label); s.end("ok"); });
    return;
  }
  if (q.url.startsWith("/?")) headers[label] = { ua: q.headers["user-agent"], lang: q.headers["accept-language"], chua: q.headers["sec-ch-ua"], chPlatform: q.headers["sec-ch-ua-platform"], chMobile: q.headers["sec-ch-ua-mobile"], dnt: q.headers["dnt"] };
  s.setHeader("content-type", "text/html"); s.end(PAGE);
}).listen(Number(port), "127.0.0.1", () => console.log("listening", port));
