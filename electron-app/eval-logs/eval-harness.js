// Leak-evaluation harness for the CHROMIUM engine. Launches a profile exactly as
// the app does (its session + preload-fingerprint.js), loads a real fingerprinting
// domain, and extracts the raw signals a detector reads. Prints one EVAL_JSON line.
// Usage: electron eval-harness.js <profileId|first> <url>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");

const ARG_ID = process.argv[2] || "first";
const URL = process.argv[3] || "https://browserleaks.com/webgl";
const FINGERPRINT_PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");

let currentConfig = null;
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = currentConfig; });

function extract() {
  const out = {};
  const nav = navigator;
  out.ua = nav.userAgent;
  out.platform = nav.platform;
  out.webdriver = nav.webdriver;
  out.hardwareConcurrency = nav.hardwareConcurrency;
  out.deviceMemory = nav.deviceMemory;
  out.languages = nav.languages;
  out.vendor = nav.vendor;
  out.screen = screen.width + "x" + screen.height + "@" + (window.devicePixelRatio || 1);
  try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}
  try { out.tzOffset = new Date().getTimezoneOffset(); } catch (_) {}

  // tiny FNV hash
  const h = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return (x >>> 0).toString(16); };

  // Canvas fingerprint
  try {
    const c = document.createElement("canvas"); c.width = 240; c.height = 60;
    const ctx = c.getContext("2d");
    ctx.textBaseline = "top"; ctx.font = "14px Arial"; ctx.fillStyle = "#f60"; ctx.fillRect(10, 10, 100, 30);
    ctx.fillStyle = "#069"; ctx.fillText("Privacy \u{1F512} test", 12, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)"; ctx.fillText("Privacy \u{1F512} test", 14, 17);
    out.canvasHash = h(c.toDataURL());
  } catch (e) { out.canvasHash = "ERR:" + e.message; }

  // WebGL: spoofed strings + REAL capabilities (the coherence check)
  try {
    const gl = document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    out.webglUnmaskedVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "(no debug ext)";
    out.webglUnmaskedRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(no debug ext)";
    out.webglVendor = gl.getParameter(gl.VENDOR);
    out.webglRenderer = gl.getParameter(gl.RENDERER);
    out.webglVersion = gl.getParameter(gl.VERSION);
    out.webglSL = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    // REAL GPU capability signals — these come from the actual hardware and are
    // hard to spoof; a detector cross-checks them against the reported renderer.
    out.glMaxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.glMaxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) ? Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)).join("x") : null;
    out.glMaxRenderbuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const fp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    out.glPrecision = fp ? (fp.precision + "/" + fp.rangeMin + "/" + fp.rangeMax) : null;
    out.glExtCount = (gl.getSupportedExtensions() || []).length;
    // WebGL render hash
    gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4 * 64); gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.webglHash = h(Array.from(px).join(","));
  } catch (e) { out.webglRenderer = "ERR:" + e.message; }

  // Font fingerprint via text-width detection (the method real detectors use)
  try {
    const base = ["monospace", "sans-serif", "serif"];
    const probe = ["Arial", "Calibri", "Cambria", "Consolas", "Segoe UI", "Times New Roman",
      "Helvetica Neue", "Menlo", "Ubuntu", "Roboto", "Noto Sans", "DejaVu Sans", "Liberation Sans",
      "Comic Sans MS", "Impact", "Tahoma", "Verdana", "Georgia", "Courier New", "Trebuchet MS"];
    const span = document.createElement("span");
    span.style.cssText = "position:absolute;left:-9999px;font-size:72px;";
    span.textContent = "mmmmmmmmmmlli WQ";
    document.body.appendChild(span);
    const baseW = {};
    for (const b of base) { span.style.fontFamily = b; baseW[b] = span.offsetWidth; }
    const detected = [];
    for (const f of probe) {
      let hit = false;
      for (const b of base) { span.style.fontFamily = "'" + f + "'," + b; if (span.offsetWidth !== baseW[b]) { hit = true; break; } }
      if (hit) detected.push(f);
    }
    // width-HASH (what fingerprintjs actually hashes) — measured while still in DOM
    let ws = "";
    for (const f of probe) { span.style.fontFamily = "'" + f + "',sans-serif"; ws += span.offsetWidth + ":" + span.offsetHeight + ","; }
    out.fontWidthHash = h(ws);
    document.body.removeChild(span);
    out.fontsDetected = detected;
    out.fontsHash = h(detected.join(","));
  } catch (e) { out.fontsHash = "ERR:" + e.message; }

  // measureText-based text/font fingerprint (float widths — the canvas method)
  try {
    const c2 = document.createElement("canvas").getContext("2d");
    const fonts2 = ["16px Arial", "16px 'Times New Roman'", "16px Consolas", "72px Segoe UI", "10px monospace"];
    let s2 = "";
    for (const f of fonts2) { c2.font = f; s2 += c2.measureText("Privacy mmmlliWQ 0123").width.toFixed(5) + ","; }
    out.measureTextHash = h(s2);
    out.measureTextSample = s2.slice(0, 40);
  } catch (e) { out.measureTextHash = "ERR:" + e.message; }

  // getBoundingClientRect-based font/geometry fingerprint (float widths)
  try {
    const span = document.createElement("span");
    span.style.cssText = "position:absolute;left:-9999px;font-size:72px;";
    span.textContent = "mmmmmmmmmmlli WQ";
    document.body.appendChild(span);
    const probe = ["Arial", "Consolas", "Segoe UI", "Times New Roman", "Comic Sans MS", "Verdana"];
    let s3 = "";
    for (const f of probe) { span.style.fontFamily = "'" + f + "',sans-serif"; s3 += span.getBoundingClientRect().width.toFixed(5) + ","; }
    document.body.removeChild(span);
    out.gbcrHash = h(s3);
    out.gbcrSample = s3.slice(0, 40);
  } catch (e) { out.gbcrHash = "ERR:" + e.message; }

  // Render-sanity: page must still render (layout-break guard)
  try {
    out.bodyChildren = document.body ? document.body.children.length : -1;
    out.bodyWidth = document.body ? document.body.getBoundingClientRect().width : -1;
    out.docTitle = (document.title || "").slice(0, 30);
    // Coherence: offsetWidth must equal round(getBoundingClientRect().width)
    let coh = 0, tot = 0;
    for (const el of Array.from(document.querySelectorAll("div,p,span,a")).slice(0, 40)) {
      tot++; if (el.offsetWidth === Math.round(el.getBoundingClientRect().width)) coh++;
    }
    out.owVsGbcrCoherent = tot ? (coh + "/" + tot) : "n/a";
  } catch (e) { out.sanityErr = e.message; }

  // Automation / bot-detection signals
  try {
    out.autoWebdriver = nav.webdriver;
    out.autoChrome = typeof window.chrome + "/runtime:" + !!(window.chrome && window.chrome.runtime);
    out.pluginsLen = nav.plugins.length;
    out.pluginsIsArray = (typeof PluginArray !== "undefined") && (nav.plugins instanceof PluginArray);
    out.plugin0IsPlugin = (typeof Plugin !== "undefined") && nav.plugins[0] && (nav.plugins[0] instanceof Plugin);
    out.mimeIsMimeType = (typeof MimeType !== "undefined") && nav.plugins[0] && nav.plugins[0][0] && (nav.plugins[0][0] instanceof MimeType);
    out.uaDataBrands = (nav.userAgentData && nav.userAgentData.brands) ? nav.userAgentData.brands.map(b => b.brand + " " + b.version).join(", ") : null;
    out.toStringLeak = (Function.prototype.toString.toString().indexOf("[native code]") >= 0) ? "native-ok" : "LEAK";
    out.wgToStringLeak = (WebGLRenderingContext.prototype.getParameter.toString().indexOf("[native code]") >= 0) ? "native-ok" : "LEAK";
  } catch (e) { out.autoErr = e.message; }

  // Audio fingerprint
  return new Promise((resolve) => {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ac = new Ctx(1, 44100, 44100);
      const osc = ac.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000;
      const comp = ac.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ac.destination); osc.start(0);
      ac.startRendering();
      ac.oncomplete = (e) => {
        const d = e.renderedBuffer.getChannelData(0);
        let acc = 0; for (let i = 4000; i < 5000; i++) acc += Math.abs(d[i]);
        out.audioHash = h(String(acc));
        resolve(out);
      };
      setTimeout(() => { out.audioHash = out.audioHash || "TIMEOUT"; resolve(out); }, 2500);
    } catch (e) { out.audioHash = "ERR:" + e.message; resolve(out); }
  });
}

app.whenReady().then(async () => {
  const profiles = store.getProfiles();
  const profile = ARG_ID === "first" ? profiles.find((p) => !p.deletedAt) : profiles.find((p) => p.id === ARG_ID);
  if (!profile) { console.log("EVAL_JSON:" + JSON.stringify({ error: "no profile" })); app.exit(1); return; }
  currentConfig = store.buildConfigFromProfile(profile);
  const sess = sessionMgr.getSessionForProfile(profile.id);
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { session: sess, preload: FINGERPRINT_PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  try { await win.loadURL(URL); } catch (_) {}
  await new Promise((r) => setTimeout(r, 3500));
  let data = {};
  try { data = await win.webContents.executeJavaScript("(" + extract.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
  console.log("EVAL_JSON:" + JSON.stringify({ profile: profile.name, id: profile.id, url: URL, ...data }));
  app.exit(0);
});
