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

// Lazy-load the optional dependency so the app still boots if it isn't installed.
// camoufox-js is ESM. require() of it works on modern Node, but Electron's bundled
// Node can differ — fall back to dynamic import() so the packaged app can't break.
let _cam = null;
async function loadCamoufox() {
  if (_cam) return _cam;
  try {
    _cam = require("camoufox-js");
  } catch (err) {
    if (err && (err.code === "ERR_REQUIRE_ESM" || /require\(\) of ES Module/i.test(String(err.message)))) {
      _cam = await import("camoufox-js");
    } else {
      throw err;
    }
  }
  return _cam;
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
  const lang = fp.languageValue || fp.language;
  if (lang && lang !== "auto") return lang;
  return "en-US";
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
    opts.geoip = true;
  }

  // Pin the window/screen to the profile's resolution so it matches its identity.
  const w = Number(fp.screenWidth), h = Number(fp.screenHeight);
  if (w > 0 && h > 0) {
    opts.screen = { minWidth: w, minHeight: h, maxWidth: w, maxHeight: h };
  }

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
  isEngineReady,
  closeAll,
  profileToOptions, // exported for tests
};
