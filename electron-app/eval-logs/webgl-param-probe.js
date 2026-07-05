// Dumps the full WebGL numeric-capability vector per profile so we can judge:
// (a) are profiles identical on these caps (cross-profile linkable)?
// (b) are the values unusual (identifying) or the ubiquitous D3D11 values?
// (c) are they coherent with each profile's claimed GPU?
// Usage: electron webgl-param-probe.js -- <id1,id2,id3>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const store = require("../src/profile-store");
const sessionMgr = require("../src/session-manager");
const ARGS = process.argv.slice(2).filter((a) => a !== "--");
const IDS = (ARGS[0] || "").split(",").filter(Boolean);
const PRELOAD = path.join(__dirname, "..", "src", "preload-fingerprint.js");
const wcToConfig = new Map();
ipcMain.on("GET_PROFILE_CONFIG", (e) => { e.returnValue = wcToConfig.get(e.sender.id) || null; });

function probe() {
  const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
  if (!gl) return { err: "no-gl" };
  const P = {
    MAX_TEXTURE_SIZE: 3379, MAX_CUBE_MAP_TEXTURE_SIZE: 34076, MAX_RENDERBUFFER_SIZE: 34024,
    MAX_VIEWPORT_DIMS: 3386, MAX_TEXTURE_IMAGE_UNITS: 34930, MAX_VERTEX_ATTRIBS: 34921,
    MAX_VERTEX_UNIFORM_VECTORS: 36347, MAX_FRAGMENT_UNIFORM_VECTORS: 36349,
    MAX_VARYING_VECTORS: 36348, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
    ALIASED_LINE_WIDTH_RANGE: 33902, ALIASED_POINT_SIZE_RANGE: 33901,
    RED_BITS: 3410, GREEN_BITS: 3411, BLUE_BITS: 3412, DEPTH_BITS: 3414, STENCIL_BITS: 3415,
  };
  const out = {};
  for (const k in P) { try { const v = gl.getParameter(P[k]); out[k] = (v && v.length !== undefined) ? Array.from(v).join(",") : v; } catch (e) { out[k] = "ERR"; } }
  // shader precision (float high) — GPU-family specific
  try { const pf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT); out.FRAG_HIGH_FLOAT = pf.rangeMin + "/" + pf.rangeMax + "/" + pf.precision; } catch (e) { out.FRAG_HIGH_FLOAT = "ERR"; }
  try { const ext = gl.getExtension("WEBGL_debug_renderer_info"); out.RENDERER = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(none)"; } catch (e) { out.RENDERER = "ERR"; }
  try { const ext2 = gl.getExtension("EXT_texture_filter_anisotropic"); out.MAX_ANISOTROPY = ext2 ? gl.getParameter(ext2.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : "(none)"; } catch (e) { out.MAX_ANISOTROPY = "ERR"; }
  return out;
}

async function openProfile(id) {
  const p = store.getProfiles().find((x) => x.id === id && !x.deletedAt);
  if (!p) return { id, error: "no-profile" };
  const cfg = store.buildConfigFromProfile(p);
  const sess = sessionMgr.getSessionForProfile(p.id);
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { session: sess, preload: PRELOAD, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  wcToConfig.set(win.webContents.id, cfg);
  try { await win.loadURL("https://example.com/"); } catch (_) {}
  return { id, name: p.name, win, claimedGpu: cfg._gpuRenderer };
}

app.whenReady().then(async () => {
  const opened = await Promise.all(IDS.map(openProfile));
  await new Promise((r) => setTimeout(r, 1500));
  const results = [];
  for (const o of opened) {
    if (!o.win) { results.push({ id: o.id, error: o.error }); continue; }
    let data = {};
    try { data = await o.win.webContents.executeJavaScript("(" + probe.toString() + ")()", true); } catch (e) { data = { execErr: String(e.message || e) }; }
    results.push({ name: o.name, claimedGpu: o.claimedGpu, ...data });
  }
  console.log("WEBGL_JSON:" + JSON.stringify(results, null, 1));
  app.exit(0);
}).catch((e) => { console.log("PROBE_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
