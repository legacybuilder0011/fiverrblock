"use strict";

// Camoufox "Stealth Engine" — a patched-Firefox anti-detect browser launched as
// a separate Playwright-driven process for the sites the in-app Chromium can't
// beat (Fiverr / PerimeterX "Press & Hold", aggressive Cloudflare / reCAPTCHA).
//
// Why a second engine: Privacy Shield's own browser spoofs via preload JS + CDP,
// which leaks — and attaching CDP is itself a bot-detection tell. Camoufox patches
// fingerprints inside Firefox's C++, so there's NO JS-injection footprint, and each
// profile gets its own engine-level hardware identity + persistent storage, so
// accounts run on one device don't share a signature.
//
// This module is intentionally additive: it never touches the existing Chromium
// browser path. If the optional engine/binary isn't installed, launchProfile()
// returns a clear {ok:false, ...} instead of throwing.

const path = require("path");
const fs = require("fs");

let electronApp = null;
try { ({ app: electronApp } = require("electron")); } catch (_) {}

// Resolve the Camoufox binary to a stable app-managed location (not the transient
// per-user cache) so the engine survives across sessions and is easy to bundle or
// pre-seed. camoufox-js reads CAMOUFOX_INSTALL_DIR at import time, so this MUST run
// before the lazy require below — module load (at app startup) satisfies that.
if (!process.env.CAMOUFOX_INSTALL_DIR && electronApp) {
  try { process.env.CAMOUFOX_INSTALL_DIR = path.join(electronApp.getPath("userData"), "camoufox-engine"); } catch (_) {}
}

// Lazy-load the optional dependency. camoufox-js is an ESM package with a large
// dependency tree (incl. native modules). In a packaged app the app code lives
// INSIDE app.asar but node_modules is unpacked to app.asar.unpacked — and bare
// ESM resolution from inside the asar resolves to the packed copy, whose deps
// then fail with ERR_MODULE_NOT_FOUND. So resolve the entry, rewrite it to the
// unpacked location, and load THAT explicitly (dev paths are unaffected — the
// rewrite is a no-op when there's no app.asar in the path).
let _cam = null;
async function loadCamoufox() {
  if (_cam) return _cam;

  let entry;
  try { entry = require.resolve("camoufox-js"); } catch (_) { entry = null; }
  // Fallback: derive from our own location (…/app.asar/src/camoufox-manager.js)
  // in case require.resolve can't resolve across the asar boundary.
  if (!entry) entry = path.join(__dirname, "..", "node_modules", "camoufox-js", "dist", "index.js");

  if (/([\\/])app\.asar\1/.test(entry) && !entry.includes("app.asar.unpacked")) {
    entry = entry.replace(/([\\/])app\.asar\1/, "$1app.asar.unpacked$1");
  }

  try {
    _cam = require(entry);
  } catch (err) {
    if (err && (err.code === "ERR_REQUIRE_ESM" || /require\(\) of ES Module/i.test(String(err.message)))) {
      const { pathToFileURL } = require("url");
      const spec = /[\\/]/.test(entry) ? pathToFileURL(entry).href : entry;
      _cam = await import(spec);
    } else {
      throw err;
    }
  }
  return _cam;
}

// A STABLE per-profile Camoufox fingerprint. Camoufox generates a NEW random
// fingerprint on every launch when none is passed — so a returning account would
// show a different canvas/GPU/screen each session, a detection red flag. Generate
// one Firefox fingerprint per profile (same generator config Camoufox uses),
// persist it, and reuse it on every launch → identical across sessions AND unique
// per profile. Falls back to Camoufox's own generation if unavailable.
function getStableFingerprint(profile) {
  if (!electronApp || !profile || !profile.id) return null;
  const safe = String(profile.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) return null;
  const dir = path.join(electronApp.getPath("userData"), "camoufox-profiles");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const fpFile = path.join(dir, safe + "-fingerprint.json");
  try { if (fs.existsSync(fpFile)) return JSON.parse(fs.readFileSync(fpFile, "utf8")); } catch (_) {}
  try {
    const { FingerprintGenerator } = require("fingerprint-generator");
    const os = mapOs(profile.os);
    const gen = new FingerprintGenerator({ browsers: ["firefox"], operatingSystems: [os] });
    const { fingerprint } = gen.getFingerprint({ operatingSystems: [os] });
    try { fs.writeFileSync(fpFile, JSON.stringify(fingerprint)); } catch (_) {}
    return fingerprint;
  } catch (_) {
    return null;
  }
}

// Per-profile persistent storage dir (cookies/localStorage) → account isolation.
function profileUserDataDir(profileId) {
  if (!electronApp) return null;
  const safe = String(profileId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) return null;
  const dir = path.join(electronApp.getPath("userData"), "camoufox-profiles", safe);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function mapOs(osName) {
  const o = String(osName || "windows").toLowerCase();
  if (o === "macos" || o === "mac") return "macos";
  if (o === "linux") return "linux";
  // Camoufox desktop supports linux/macos/windows only; mobile OSes fall back to
  // windows (mobile Firefox emulation is out of scope for the stealth engine).
  return "windows";
}

function localeFor(profile) {
  const fp = profile.fingerprint || {};
  const px = profile.proxy || {};
  if (fp.language === "manual" && fp.languageValue) return fp.languageValue;
  if (fp.language && fp.language !== "auto" && fp.language !== "manual") return fp.language;
  // Same country table as Patched Chromium. A Swiss exit is de-CH, fr-CH, or
  // it-CH. An Indian exit is en-IN or hi-IN. The old short map forced de-DE and hi-IN.
  const cc = px.detectedCountryCode || fp.countryCode;
  if (cc) {
    try {
      const store = require("./profile-store");
      if (typeof store.pickLanguageForCountry === "function") {
        return store.pickLanguageForCountry(fp.fingerprintSeed || profile.id || "default", cc);
      }
    } catch (_) {}
  }
  return "en-US";
}

// Resolve the profile's timezone/geolocation the same way the Chromium engine
// does: manual value wins, else the captured VPN/proxy exit (proxy.detected*).
// Passed to Camoufox EXPLICITLY so the Stealth engine can never fall back to the
// real OS timezone/location (which leaks + mismatches the network).
function resolveLocation(profile) {
  const fp = profile.fingerprint || {};
  const px = profile.proxy || {};
  let tz = "";
  if (fp.timezone === "manual" && fp.timezoneValue) tz = fp.timezoneValue;
  else if (px.detectedTimezone) tz = px.detectedTimezone;
  let lat, lon;
  if (fp.geolocation === "manual") { lat = Number(fp.geoLat); lon = Number(fp.geoLng); }
  else if (px.detectedLatitude != null || px.detectedLat != null) { lat = Number(px.detectedLatitude != null ? px.detectedLatitude : px.detectedLat); lon = Number(px.detectedLongitude != null ? px.detectedLongitude : px.detectedLng); }
  return { tz, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null };
}

// Map one saved profile to Camoufox launch options.
function profileToOptions(profile) {
  const fp = profile.fingerprint || {};
  const px = profile.proxy || {};

  const opts = {
    headless: false,
    os: mapOs(profile.os),
    humanize: true,       // human-like cursor movement
    block_webrtc: true,   // never leak the real IP behind the proxy
    locale: localeFor(profile),
  };

  const udd = profileUserDataDir(profile.id);
  if (udd) opts.user_data_dir = udd;

  // Proxy + GeoIP: when a proxy is configured, route through it and let Camoufox
  // derive geo / timezone / locale from the proxy's exit IP so the whole identity
  // matches the network automatically (no manual tz/geo drift).
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (mode === "proxy" && px.host && px.port) {
    const scheme = String(px.scheme || "http").toLowerCase();
    opts.proxy = { server: `${scheme}://${px.host}:${px.port}` };
    if (px.username) opts.proxy.username = px.username;
    if (px.password) opts.proxy.password = px.password;
  }

  // Timezone + geolocation: pin them EXPLICITLY from the profile's resolved
  // location (manual value or captured VPN/proxy exit) so the Stealth engine
  // reports the network's location, never the real OS timezone (a leak + a
  // mismatch). Only fall back to geoip (derive from the proxy exit IP over the
  // wire) when we have no resolved timezone AND a proxy is set.
  const loc = resolveLocation(profile);
  const geoCfg = {};
  if (loc.tz) geoCfg["timezone"] = loc.tz;
  if (loc.lat != null && loc.lon != null) {
    geoCfg["geolocation:latitude"] = loc.lat;
    geoCfg["geolocation:longitude"] = loc.lon;
    geoCfg["geolocation:accuracy"] = 50;
  }
  if (!loc.tz && mode === "proxy" && px.host && px.port) {
    opts.geoip = true; // last resort: let Camoufox detect via the proxy
  }

  // Screen comes from the profile. The window is clamped to this display so it
  // still fits, and it is never larger than the screen the page is told about.
  let dispScreen = null;
  try {
    const { screen: elScreen } = require("electron");
    const disp = elScreen && elScreen.getPrimaryDisplay ? elScreen.getPrimaryDisplay() : null;
    if (disp) {
      const full = disp.size || {};
      const wa = disp.workAreaSize || full;
      if (full.width && full.height) dispScreen = { w: Math.round(full.width), h: Math.round(full.height), aw: Math.round(wa.width || full.width), ah: Math.round(wa.height || full.height) };
    }
  } catch (_) {}
  const wantedW = Number(fp.screenWidth);
  const wantedH = Number(fp.screenHeight);
  const hasWanted = Number.isFinite(wantedW) && Number.isFinite(wantedH) && wantedW >= 320 && wantedH >= 480;
  const reported = hasWanted
    ? { w: Math.round(Math.min(3840, wantedW)), h: Math.round(Math.min(2160, wantedH)) }
    : (dispScreen ? { w: dispScreen.w, h: dispScreen.h } : null);
  let windowSize = null;
  if (reported) {
    const outerW = dispScreen ? Math.min(reported.w, dispScreen.aw) : reported.w;
    const outerH = dispScreen ? Math.min(reported.h, dispScreen.ah) : reported.h;
    opts.screen = { minWidth: reported.w, minHeight: reported.h, maxWidth: reported.w, maxHeight: reported.h };
    windowSize = [Math.max(320, outerW), Math.max(480, outerH)];
    opts.window = windowSize;
  }

  // Stable per-profile fingerprint (identical across sessions, unique per profile).
  const stableFp = getStableFingerprint(profile);
  if (stableFp) {
    // CRITICAL: when a custom fingerprint is passed, camoufox-js IGNORES opts.window
    // (generateFingerprint — which applies the window tuple — only runs when NO
    // fingerprint is given). The actual on-screen window is sized from the
    // fingerprint's own screen.outer/inner values. Write the profile's screen
    // there, and keep the window no larger than this display.
    if (reported && stableFp.screen && typeof stableFp.screen === "object") {
      const s = stableFp.screen;
      const chrome = 88; // Firefox tab+toolbar height (approx) so inner < outer
      const outerW = windowSize ? windowSize[0] : reported.w;
      const outerH = windowSize ? windowSize[1] : reported.h;
      s.width = reported.w; s.height = reported.h;
      s.availWidth = reported.w; s.availHeight = Math.max(400, reported.h - 40);
      s.availTop = 0; s.availLeft = 0;
      s.outerWidth = outerW; s.outerHeight = outerH;
      s.innerWidth = outerW; s.innerHeight = Math.max(400, outerH - chrome);
      s.screenX = 0; s.screenY = 0;
      if ("pageXOffset" in s) s.pageXOffset = 0;
      if ("pageYOffset" in s) s.pageYOffset = 0;
      if ("clientWidth" in s) s.clientWidth = outerW;
      if ("clientHeight" in s) s.clientHeight = Math.max(400, outerH - chrome);
    }
    opts.fingerprint = stableFp;
    if (!reported) delete opts.screen;
    // Camoufox otherwise re-randomizes the GPU, canvas AA offset and font spacing
    // on EVERY launch (separate from the fingerprint object). Pin all three per
    // profile so the WHOLE fingerprint — GPU, canvas, text — is identical across
    // sessions yet unique per profile.
    const seedInt = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return x >>> 0; };
    const vc = stableFp.videoCard || {};
    if (vc.vendor && vc.renderer) opts.webgl_config = [vc.vendor, vc.renderer];
    opts.config = {
      "canvas:aaOffset": (seedInt(profile.id) % 101) - 50,
      "canvas:aaCapOffset": true,
      "fonts:spacing_seed": seedInt(profile.id + "|spacing") % 1073741824,
    };
  }

  // Merge the explicit timezone/geolocation into the config (works with or
  // without a stable fingerprint) so the resolved location always wins.
  if (Object.keys(geoCfg).length) opts.config = Object.assign({}, opts.config, geoCfg);

  return opts;
}

// profileId -> { handle, startedAt }. `handle` is a persistent BrowserContext
// (when user_data_dir is set) or a Browser (fallback) — both expose newPage().
const instances = new Map();

function isConnected(handle) {
  try {
    if (!handle) return false;
    if (typeof handle.isConnected === "function") return handle.isConnected();
    // Persistent context: no isConnected(); treat "has a browser" as connected.
    if (typeof handle.browser === "function") return Boolean(handle.browser());
    return true;
  } catch (_) { return false; }
}

async function firstPage(handle) {
  // Persistent context ships with an initial page; reuse it instead of stacking
  // a blank one. A plain Browser has no pages() until we open one.
  try {
    if (typeof handle.pages === "function") {
      const pages = handle.pages();
      if (pages && pages.length) return pages[0];
    }
  } catch (_) {}
  return handle.newPage();
}

// Verify the Camoufox binary actually exists WITHOUT triggering a ~150MB
// download. camoufoxPath(false) can return a path even when the file is missing,
// so we stat it; fall back to probing CAMOUFOX_INSTALL_DIR directly.
async function isEngineReady() {
  try {
    const cam = await loadCamoufox();
    if (typeof cam.camoufoxPath === "function") {
      const p = cam.camoufoxPath(false);
      if (p && fs.existsSync(p)) return true;
    }
    const dir = process.env.CAMOUFOX_INSTALL_DIR;
    if (dir) {
      const exe = process.platform === "win32" ? "camoufox.exe" : "camoufox";
      return fs.existsSync(path.join(dir, exe));
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function launchProfile(profile, startUrl) {
  if (!profile || !profile.id) return { ok: false, reason: "no-profile" };

  // Reuse a live instance for this profile instead of opening a second window.
  const existing = instances.get(profile.id);
  if (existing && isConnected(existing.handle)) {
    try {
      const page = await firstPage(existing.handle);
      if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.bringToFront().catch(() => {});
      return { ok: true, reused: true };
    } catch (_) { instances.delete(profile.id); }
  }

  let Camoufox;
  try { ({ Camoufox } = await loadCamoufox()); }
  catch (err) { return { ok: false, reason: "engine-not-installed", detail: String(err && (err.message || err)) }; }

  const opts = profileToOptions(profile);
  let handle;
  try {
    handle = await Camoufox(opts);
  } catch (err) {
    const msg = String(err && (err.message || err));
    // The library throws a NotInstalled-style error when the binary is missing.
    const reason = /not installed|download|camoufoxPath|fetch/i.test(msg) ? "binary-missing" : "launch-failed";
    return { ok: false, reason, detail: msg };
  }

  instances.set(profile.id, { handle, startedAt: Date.now() });
  try {
    handle.on("close", () => instances.delete(profile.id));            // persistent context
    if (typeof handle.on === "function") handle.on("disconnected", () => instances.delete(profile.id)); // browser
  } catch (_) {}

  try {
    const page = await firstPage(handle);
    if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  } catch (err) {
    return { ok: true, warning: "opened-but-no-nav", detail: String(err && (err.message || err)) };
  }
  return { ok: true };
}

async function closeProfile(profileId) {
  const inst = instances.get(profileId);
  if (!inst) return { ok: true, alreadyClosed: true };
  try { await inst.handle.close(); } catch (_) {}
  instances.delete(profileId);
  return { ok: true };
}

function isProfileRunning(profileId) {
  const inst = instances.get(profileId);
  return Boolean(inst && isConnected(inst.handle));
}

// IDs of all profiles with a live Camoufox window — lets the UI show Live/Stop
// for the Stealth engine the same way it does for the Chromium engine.
function runningIds() {
  const ids = [];
  for (const [id, inst] of instances) {
    if (isConnected(inst.handle)) ids.push(id);
    else instances.delete(id);
  }
  return ids;
}

async function closeAll() {
  for (const [id, inst] of instances) {
    try { await inst.handle.close(); } catch (_) {}
    instances.delete(id);
  }
}

module.exports = {
  launchProfile,
  closeProfile,
  isProfileRunning,
  runningIds,
  isEngineReady,
  closeAll,
  profileToOptions, // exported for tests
};
