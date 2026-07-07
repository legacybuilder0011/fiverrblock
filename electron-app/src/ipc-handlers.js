"use strict";

const { ipcMain, BrowserWindow, WebContentsView, Menu, net, nativeImage, dialog, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const store = require("./profile-store");
const sessionMgr = require("./session-manager");
const authStore = require("./auth-store");
const vpsProxy = require("./vps-proxy-manager");
const proxyBridge = require("./local-proxy-bridge");
const extensionManager = require("./extension-manager");

// Write to BOTH OneDrive Desktop and userData. OneDrive Files-On-Demand
// can silently swallow appendFileSync writes, so userData is the reliable
// copy. Defer userData resolution until first write because app may not
// be fully ready when this module is first required.
let LOG_TARGETS = null;
function getLogTargets() {
  if (LOG_TARGETS) return LOG_TARGETS;
  const { app } = require("electron");
  const targets = [];
  for (const dir of [path.join(os.homedir(), "OneDrive", "Desktop"), path.join(os.homedir(), "Desktop")]) {
    try { if (fs.existsSync(dir)) { targets.push(path.join(dir, "privacy-shield-error.txt")); break; } } catch (_) {}
  }
  try {
    const ud = app.getPath("userData");
    fs.mkdirSync(ud, { recursive: true });
    targets.push(path.join(ud, "privacy-shield-error.txt"));
  } catch (_) {}
  if (!targets.length) targets.push(path.join(os.tmpdir(), "privacy-shield-error.txt"));
  LOG_TARGETS = targets;
  return targets;
}
function logError(err) {
  const line = new Date().toISOString() + " " + String(err?.stack || err) + "\n";
  for (const t of getLogTargets()) {
    try { fs.appendFileSync(t, line, "utf8"); } catch (_) {}
  }
}
function logInfo(msg) {
  const line = new Date().toISOString() + " [info] " + String(msg) + "\n";
  for (const t of getLogTargets()) {
    try { fs.appendFileSync(t, line, "utf8"); } catch (_) {}
  }
}

async function loadExtensionIntoProfile(profileId, selectedPath, options = {}) {
  const prepared = options.archive
    ? await extensionManager.installZip(selectedPath, profileId)
    : extensionManager.resolveExtensionDirectory(selectedPath);
  const extensionPath = prepared.directory;
  const sess = sessionMgr.getSessionForProfile(profileId);
  if (typeof sess.loadExtension !== "function") {
    throw new Error("This Electron build does not support unpacked extensions");
  }

  const loaded = await sess.loadExtension(extensionPath, { allowFileAccess: true });
  const profile = store.getProfiles().find((entry) => entry.id === profileId && !entry.deletedAt);
  if (profile) {
    const existing = Array.isArray(profile.extensions) ? profile.extensions : [];
    const next = existing.filter((item) => item.path !== extensionPath && item.id !== loaded.id);
    next.push({
      id: loaded.id,
      name: loaded.name || prepared.manifest?.name || path.basename(extensionPath),
      path: extensionPath,
      sourceArchive: prepared.sourceArchive || null,
      loadedAt: Date.now()
    });
    store.updateProfile(profileId, { extensions: next });
  }
  logInfo(`extension loaded profile=${profileId} id=${loaded.id || ""} path=${extensionPath}`);
  return {
    id: loaded.id,
    name: loaded.name || prepared.manifest?.name || path.basename(extensionPath),
    path: extensionPath
  };
}

// Preload scripts are loaded by Electron via Node.js fs (ASAR-aware) — __dirname works fine.
const FINGERPRINT_PRELOAD = path.join(__dirname, "preload-fingerprint.js");
const RENDERER_PRELOAD    = path.join(__dirname, "renderer-preload.js");

const cdpStealth = require("./cdp-stealth");
const camoufox = require("./camoufox-manager");

// HTML files load via the psapp:// custom protocol (registered in main.js).
// file:// URLs to anything containing ".asar" in the path (including .asar.unpacked)
// fail with ERR_FAILED (-2) in Electron 31 BrowserWindow. psapp:// reads the bundled
// files via fs.readFileSync (which Node.js handles ASAR transparently for) and
// serves them as a normal HTTP response — no ASAR interception involved.
const BROWSER_START_URL = "psapp://app/renderer/browser-start.html";
const TAB_STRIP_URL     = "psapp://app/renderer/tab-strip.html";

const DESKTOP_CHROME_HEIGHT = 78; // tabs row (38) + url row (40)
const MOBILE_CHROME_HEIGHT = 56;  // compact address bar only
const MOBILE_BOTTOM_NAV_HEIGHT = 42; // phone-style bottom navigation bar

function profileInitials(name) {
  const words = String(name || "Profile").trim().split(/\s+/).filter(Boolean);
  const chars = words.length > 1
    ? words.slice(0, 2).map((word) => word[0]).join("")
    : String(words[0] || "P").slice(0, 2);
  return chars.toUpperCase().replace(/[^A-Z0-9]/g, "") || "P";
}

function profileAccentColor(profile) {
  const palette = ["#2563eb", "#0891b2", "#16a34a", "#ca8a04", "#dc2626", "#7c3aed", "#0f766e", "#be123c"];
  const seed = String(profile?.id || profile?.name || "profile");
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

// SVG icons are silently ignored by the Windows taskbar — we have to hand it
// raster PNG bytes via `nativeImage.toPNG()`. Without the explicit `resize`,
// the SVG rasterizer falls back to native pixel size which on HiDPI screens
// often comes out as a 1x1 dot, hence the "all green, no letter" symptom.
function buildProfileSvg(initials, color, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="56" fill="#0c0f14"/>
    <rect x="18" y="18" width="220" height="220" rx="44" fill="${color}"/>
    <text x="128" y="172" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="148" font-weight="800" fill="#ffffff">${initials}</text>
  </svg>`;
}

function createProfileIcon(profile) {
  try {
    const initials = profileInitials(profile?.name);
    const color = profileAccentColor(profile);
    const svg = buildProfileSvg(initials, color, 256);
    const img = nativeImage.createFromDataURL("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    // Force a raster pass at a Windows-friendly size; `toPNG()` returns the
    // encoded bytes so we can hand them back as a native PNG image.
    try {
      const png = img.resize({ width: 256, height: 256 }).toPNG();
      if (png && png.length) return nativeImage.createFromBuffer(png);
    } catch (_) {}
    return img;
  } catch (_) {
    return undefined;
  }
}

// Raw 16x16 BGRA buffer fallback: a filled circle in the profile's accent color.
// This bypasses the SVG rasterizer entirely and is guaranteed to produce a
// non-empty nativeImage on every platform. No text — that needs a font renderer.
function createOverlayDiskFallback(profile) {
  try {
    const size = 16;
    const hex = profileAccentColor(profile).replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const buf = Buffer.alloc(size * size * 4);
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const radius = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const i = (y * size + x) * 4;
        if (dist <= radius - 0.5) {
          // BGRA on Windows, RGBA elsewhere — nativeImage.createFromBitmap expects BGRA
          buf[i] = b;
          buf[i + 1] = g;
          buf[i + 2] = r;
          buf[i + 3] = 255;
        } else if (dist <= radius + 0.5) {
          // anti-aliased edge
          const a = Math.round(255 * (radius + 0.5 - dist));
          buf[i] = b;
          buf[i + 1] = g;
          buf[i + 2] = r;
          buf[i + 3] = a;
        }
      }
    }
    return nativeImage.createFromBitmap(buf, { width: size, height: size });
  } catch (_) {
    return undefined;
  }
}

function createProfileOverlayIcon(profile) {
  try {
    const initials = profileInitials(profile?.name).slice(0, 2);
    const color = profileAccentColor(profile);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
      <text x="16" y="22" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${initials.length > 1 ? 14 : 18}" font-weight="800" fill="#ffffff">${initials}</text>
    </svg>`;
    const img = nativeImage.createFromDataURL("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    try {
      const png = img.resize({ width: 16, height: 16 }).toPNG();
      if (png && png.length) return nativeImage.createFromBuffer(png);
    } catch (_) {}
    return img;
  } catch (_) {
    return undefined;
  }
}

function startPageUrl(errorMsg, failedUrl) {
  if (!errorMsg) return BROWSER_START_URL;
  return BROWSER_START_URL + "?error=" + encodeURIComponent(errorMsg) + (failedUrl ? "&url=" + encodeURIComponent(failedUrl) : "");
}

// profileId → BrowserWindow reference for profile browser windows
const profileWindows = new Map();
// profileId → { mode, anchor, requiresVpn, profileName } for the VPN kill-switch
const profileNetworkMeta = new Map();
const cloudPhoneWindows = new Map();
// windowId → { profileId, tabs: [{id, view, ...}], activeTabId }
const windowTabState = new Map();
// webContentsId → profileId (so the fingerprint preload can find its profile)
const webContentsProfileMap = new Map();
let nextTabId = 1;

// Sync handler so the fingerprint preload can get the profile config for its tab.
// Looks up the profile via webContents.id (which works for WebContentsView, unlike fromWebContents → BrowserWindow).
ipcMain.on("GET_PROFILE_CONFIG", (event) => {
  const profileId = webContentsProfileMap.get(event.sender.id)
    || (() => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return win ? sessionMgr.getProfileForWindow(win.id) : null;
    })();
  if (!profileId) { event.returnValue = null; return; }
  const profiles = store.getProfiles();
  const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
  event.returnValue = profile ? store.buildConfigFromProfile(profile) : null;
});

function registerIpcHandlers() {
  // ── Profile CRUD ──────────────────────────────────────────────────────────────

  ipcMain.handle("PROFILE_LIST", async (_ev, { showDeleted = false } = {}) => {
    const profiles = store.getProfiles();
    return { ok: true, profiles: showDeleted ? profiles : profiles.filter((p) => !p.deletedAt) };
  });

  ipcMain.handle("PROFILE_GET", async (_ev, { id }) => {
    const profiles = store.getProfiles();
    const p = profiles.find((p) => p.id === id);
    return { ok: Boolean(p), profile: p || null };
  });

  ipcMain.handle("PROFILE_CREATE", async (_ev, { data = {} } = {}) => {
    const profile = store.createProfile(data);
    return { ok: true, profile };
  });

  ipcMain.handle("PROFILE_COUNTRY_IDENTITY", async (_ev, { country = "us", index = 1, deviceClass = "desktop", browserApp = "random", os } = {}) => {
    return { ok: true, data: store.buildCountryProfileData(country, index, { deviceClass, browserApp, os }) };
  });

  ipcMain.handle("PROFILE_UPDATE", async (_ev, { id, data = {} } = {}) => {
    const profile = store.updateProfile(id, data);
    if (profile && profileWindows.has(id)) {
      // If the profile's browser window is open, update its session config.
      // Bad proxy config must NOT crash the app — keep the old session.
      try {
        await sessionMgr.setupProfileSession(profile);
      } catch (_) { /* ignore — old session keeps working */ }
    }
    return { ok: Boolean(profile), profile };
  });

  ipcMain.handle("PROFILE_DELETE", async (_ev, { id, hard = false } = {}) => {
    store.deleteProfile(id, hard);
    return { ok: true };
  });

  ipcMain.handle("PROFILE_PURGE_TRASH", async () => {
    const count = store.purgeDeletedProfiles();
    return { ok: true, count };
  });

  ipcMain.handle("PROFILE_RESTORE", async (_ev, { id } = {}) => {
    const profile = store.restoreProfile(id);
    return { ok: Boolean(profile), profile };
  });

  ipcMain.handle("PROFILE_DUPLICATE", async (_ev, { id } = {}) => {
    const profile = store.duplicateProfile(id);
    return { ok: Boolean(profile), profile };
  });

  // ── Camoufox "Stealth Engine" — patched-Firefox launch for hard bot-detection ──
  // sites (Fiverr/PerimeterX). Separate process, engine-level fingerprint, no JS
  // footprint. Additive: does not touch the in-app Chromium browser path.
  ipcMain.handle("PROFILE_OPEN_CAMOUFOX", async (_ev, { profileId, url } = {}) => {
    let profile = store.getProfiles().find((p) => p.id === profileId && !p.deletedAt);
    if (!profile) return { ok: false, reason: "no-profile" };
    try {
      // VPN/direct mode: the browser's location MUST match the ACTUAL exit IP, or
      // a site like Fiverr flags the mismatch (e.g. US timezone on a Nigerian IP →
      // press-and-hold) even though a plain browser on that same IP passes. So we
      // capture the LIVE exit and force timezone/language/geolocation to follow it
      // — overriding any stale "Miami" anchor or manual timezone. This makes the
      // Stealth engine coherent with wherever the traffic really exits.
      const px = profile.proxy || {};
      const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
      let liveCountry = "";
      if (mode === "vpn" || mode === "direct") {
        try {
          const cur = await captureCurrentNetwork();
          if (cur && cur.countryCode) {
            liveCountry = String(cur.countryCode).toLowerCase();
            profile = { ...profile,
              fingerprint: { ...(profile.fingerprint || {}), timezone: "auto", language: "auto", geolocation: "auto" },
              proxy: { ...px,
                detectedCountryCode: cur.countryCode, detectedCountry: cur.country, detectedCity: cur.city,
                detectedTimezone: cur.timezone, detectedLatitude: cur.latitude, detectedLongitude: cur.longitude,
                detectedIp: cur.ip } };
          }
        } catch (e) { logError(`camoufox: live location capture failed (${e && (e.message || e)}) — proceeding`); }
      }
      const res = await camoufox.launchProfile(profile, url || "");
      if (!res || !res.ok) { logError(`camoufox launch failed: reason=${res && res.reason} detail=${res && res.detail}`); return res; }
      // Register the Stealth window with the VPN kill-switch so it's closed if the
      // exit country changes or the network drops (same guard as the Chromium
      // engine, which previously did NOT cover Camoufox). Baseline to the country
      // the session actually STARTED on so a later VPN drop/switch triggers a kill.
      if (mode === "vpn" || mode === "direct") {
        profileNetworkMeta.set(profileId, {
          mode, camoufox: true, anchorCountry: liveCountry,
          anchorLabel: liveCountry ? liveCountry.toUpperCase() : "",
          profileName: profile.name || "Profile"
        });
        logError(`vpn kill-switch: now watching STEALTH profile=${profileId} mode=${mode} anchorCountry=${liveCountry || "(self-baseline)"}`);
        startVpnWatch();
      }
      return res;
    } catch (err) {
      logError(`camoufox launch threw: ${err && (err.stack || err.message || err)}`);
      return { ok: false, reason: "launch-failed", detail: String(err && (err.message || err)) };
    }
  });
  ipcMain.handle("PROFILE_CLOSE_CAMOUFOX", async (_ev, { profileId } = {}) => {
    try { return await camoufox.closeProfile(profileId); }
    catch (err) { return { ok: false, detail: String(err && (err.message || err)) }; }
  });
  ipcMain.handle("CAMOUFOX_STATUS", async (_ev, { profileId } = {}) => {
    return { ok: true, ready: await camoufox.isEngineReady(), running: profileId ? camoufox.isProfileRunning(profileId) : false };
  });
  ipcMain.handle("CAMOUFOX_RUNNING", async () => {
    try { return { ok: true, ids: camoufox.runningIds() }; }
    catch (_) { return { ok: true, ids: [] }; }
  });

  // Tab assignment — no-op in Electron (each window IS the profile)
  ipcMain.handle("PROFILE_ASSIGN_TAB", async () => ({ ok: true }));
  ipcMain.handle("PROFILE_GET_TAB", async () => ({ ok: true, profileId: null, profile: null }));

  // ── Cookie management ─────────────────────────────────────────────────────────

  ipcMain.handle("PROFILE_EXPORT_COOKIES", async (_ev, { profileId } = {}) => {
    const profiles = store.getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    return { ok: true, cookies: profile ? profile.cookies || [] : [] };
  });

  ipcMain.handle("PROFILE_IMPORT_COOKIES", async (_ev, { profileId, cookies = [] } = {}) => {
    const profile = store.updateProfile(profileId, { cookies: Array.isArray(cookies) ? cookies : [] });
    return { ok: Boolean(profile) };
  });

  // Capture/inject cookies from Electron session
  ipcMain.handle("PROFILE_CAPTURE_COOKIES", async (_ev, { profileId } = {}) => {
    if (!profileId) return { ok: false, error: "no profileId" };
    const win = profileWindows.get(profileId);
    if (!win || win.isDestroyed()) return { ok: false, error: "no window open" };
    try {
      const sess = sessionMgr.getSessionForProfile(profileId);
      const cookies = await sess.cookies.get({});
      const data = cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain,
        path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, expirationDate: c.expirationDate
      }));
      store.updateProfile(profileId, { cookies: data });
      return { ok: true, cookies: data, count: data.length };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("PROFILE_INJECT_COOKIES", async (_ev, { profileId } = {}) => {
    if (!profileId) return { ok: false, error: "no profileId" };
    const profiles = store.getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile || !profile.cookies || !profile.cookies.length) return { ok: true, count: 0 };
    const sess = sessionMgr.getSessionForProfile(profileId);
    let n = 0;
    for (const c of profile.cookies) {
      try {
        const protocol = c.secure ? "https://" : "http://";
        const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
        await sess.cookies.set({
          url: protocol + domain + (c.path || "/"),
          name: c.name, value: c.value,
          domain: c.domain, path: c.path || "/",
          secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
          sameSite: c.sameSite || "unspecified",
          expirationDate: c.expirationDate
        });
        n++;
      } catch (_) {}
    }
    return { ok: true, count: n };
  });

  // ── WebGL Presets ─────────────────────────────────────────────────────────────

  ipcMain.handle("PROFILE_WEBGL_PRESETS", async () => ({
    ok: true, presets: store.PROFILE_WEBGL_PRESETS
  }));

  ipcMain.handle("ENGINE_CAPABILITIES", async () => ({
    ok: true,
    capabilities: store.getEngineCapabilities()
  }));

  ipcMain.handle("PROFILE_AUDIT", async (_ev, { profileId, profile } = {}) => {
    const target = profile || store.getProfiles().find((p) => p.id === profileId && !p.deletedAt);
    if (!target) return { ok: false, error: "Profile not found" };
    return { ok: true, audit: store.validateProfileConsistency(target) };
  });

  // ── Window management ─────────────────────────────────────────────────────────

  ipcMain.handle("PROFILE_OPEN_WINDOW", async (_ev, { profileId, url, acceptNewLocation, acceptSharedIp } = {}) => {
    logError(`PROFILE_OPEN_WINDOW start profileId=${profileId} url=${url || "<none>"} acceptNewLocation=${Boolean(acceptNewLocation)} acceptSharedIp=${Boolean(acceptSharedIp)}`);
    try {
      const result = await openProfileWindow(profileId, url, { acceptNewLocation: Boolean(acceptNewLocation), acceptSharedIp: Boolean(acceptSharedIp) });
      logError(`PROFILE_OPEN_WINDOW result ok=${result?.ok} err=${result?.error || ""}`);
      return result;
    } catch (err) {
      logError(`PROFILE_OPEN_WINDOW threw: ${err.stack || err}`);
      return { ok: false, error: "Failed to open window: " + (err.message || err) };
    }
  });

  // Bulk profile generation
  ipcMain.handle("PROFILE_BULK_CREATE", async (_ev, { count, country, assignProxies, networkMode, deviceClass, browserApp } = {}) => {
    try {
      return await bulkCreateProfiles(count, country, assignProxies, networkMode, deviceClass, browserApp);
    } catch (err) {
      logError(err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("PROFILE_CLOSE_WINDOW", async (_ev, { profileId } = {}) => {
    const win = profileWindows.get(profileId);
    if (!win || win.isDestroyed()) return { ok: false, error: "no open window" };
    const saved = await saveWindowSession(profileId, win);
    win.close();
    return { ok: true, count: saved };
  });

  ipcMain.handle("PROFILE_SAVE_SESSION", async (_ev, { profileId } = {}) => {
    const win = profileWindows.get(profileId);
    if (!win || win.isDestroyed()) return { ok: false, error: "no open window" };
    const count = await saveWindowSession(profileId, win);
    return { ok: true, count };
  });

  ipcMain.handle("PROFILE_CLEAR_BROWSER_DATA", async (_ev, { profileId } = {}) => {
    try {
      const sess = sessionMgr.getSessionForProfile(profileId);
      await sess.clearStorageData({
        storages: [
          "appcache",
          "cookies",
          "filesystem",
          "indexdb",
          "localstorage",
          "shadercache",
          "websql",
          "serviceworkers",
          "cachestorage"
        ]
      });
      try { await sess.clearCache(); } catch (_) {}
      try { await sess.clearAuthCache(); } catch (_) {}
      try { await sess.clearHostResolverCache(); } catch (_) {}
      try { await sess.closeAllConnections(); } catch (_) {}
      store.updateProfile(profileId, { cookies: [], localStorageData: {}, session: null });
      return { ok: true };
    } catch (err) {
      logError(err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("PROFILE_GET_WINDOWS", async () => {
    return { ok: true, windows: sessionMgr.getAllProfileWindows() };
  });

  // Android Cloud Phones manager. Real phones must come from a provider; these
  // handlers persist provider/device records and open provider-hosted consoles.
  ipcMain.handle("CLOUD_PHONE_PROVIDER_GET", async () => {
    const config = store.getCloudPhoneProviderConfig();
    return { ok: true, config: { endpoint: config.endpoint, authMode: config.authMode, hasToken: Boolean(config.token) } };
  });

  ipcMain.handle("CLOUD_PHONE_PROVIDER_SAVE", async (_ev, { config = {} } = {}) => {
    const saved = store.saveCloudPhoneProviderConfig(config);
    return { ok: true, config: { endpoint: saved.endpoint, authMode: saved.authMode, hasToken: Boolean(saved.token) } };
  });

  ipcMain.handle("CLOUD_PHONE_LIST", async () => ({
    ok: true,
    phones: store.getCloudPhones()
  }));

  ipcMain.handle("CLOUD_PHONE_UPSERT", async (_ev, { phone = {} } = {}) => {
    const saved = store.upsertCloudPhone(phone);
    notifyManagerWindows("CLOUD_PHONES_CHANGED");
    return { ok: true, phone: saved };
  });

  ipcMain.handle("CLOUD_PHONE_DELETE", async (_ev, { id } = {}) => {
    store.deleteCloudPhone(id);
    const existing = cloudPhoneWindows.get(id);
    if (existing && !existing.isDestroyed()) existing.close();
    cloudPhoneWindows.delete(id);
    notifyManagerWindows("CLOUD_PHONES_CHANGED");
    return { ok: true };
  });

  ipcMain.handle("CLOUD_PHONE_OPEN", async (_ev, { id } = {}) => {
    return openCloudPhoneWindow(id);
  });

  // ── Proxy library ─────────────────────────────────────────────────────────────

  ipcMain.handle("PROXY_LIB_GET", async () => ({
    ok: true, library: store.getProxyLibrary()
  }));

  ipcMain.handle("PROXY_LIB_ADD", async (_ev, { entry = {} } = {}) => {
    const newEntry = store.addProxyEntry(entry);
    return { ok: true, entry: newEntry };
  });

  ipcMain.handle("PROXY_LIB_UPDATE", async (_ev, { id, data = {} } = {}) => {
    const entry = store.updateProxyEntry(id, data);
    if (!entry) return { ok: false, error: "not found" };
    return { ok: true, entry };
  });

  ipcMain.handle("PROXY_LIB_DELETE", async (_ev, { id } = {}) => {
    store.deleteProxyEntry(id);
    return { ok: true };
  });

  ipcMain.handle("PROXY_PROVIDER_GET", async () => {
    const cfg = store.getProxyProviderConfig();
    return {
      ok: true,
      config: {
        endpoint: cfg.endpoint,
        authMode: cfg.authMode,
        hasToken: Boolean(cfg.token)
      }
    };
  });

  ipcMain.handle("PROXY_PROVIDER_SAVE", async (_ev, { config = {} } = {}) => {
    const saved = store.saveProxyProviderConfig(config);
    return {
      ok: true,
      config: {
        endpoint: saved.endpoint,
        authMode: saved.authMode,
        hasToken: Boolean(saved.token)
      }
    };
  });

  ipcMain.handle("PROXY_GENERATE_PRIVATE", async (_ev, { country } = {}) => {
    const wantedCountry = String(country || "").toLowerCase();
    const pooled = pickVpsPrivateProxy(wantedCountry);
    if (pooled) {
      const used = store.markProxyUsed(pooled.id) || pooled;
      return { ok: true, entry: used, source: "vps" };
    }

    return {
      ok: false,
      error: `No private VPS proxy for ${wantedCountry ? wantedCountry.toUpperCase() : "this country"}. Add and install a VPS proxy first.`
    };
  });

  ipcMain.handle("VPS_PROXY_LIST", async () => ({
    ok: true,
    records: store.getVpsProxies()
  }));

  ipcMain.handle("VPS_PROXY_TEST_SSH", async (_ev, data = {}) => {
    try {
      const result = await vpsProxy.testSsh(data);
      return { ok: true, stdout: result.stdout };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("VPS_PROXY_INSTALL", async (_ev, data = {}) => {
    try {
      const existing = data.id
        ? store.getVpsProxies({ includeSecrets: true }).find((r) => r.id === data.id)
        : null;
      const installInput = { ...data };
      if (existing?.proxy) {
        installInput.proxyUsername = installInput.proxyUsername || existing.proxy.username || "";
        installInput.proxyPassword = installInput.proxyPassword || existing.proxy.password || "";
        installInput.proxyHost = installInput.proxyHost || existing.proxy.host || data.host || "";
      }
      const installed = await vpsProxy.installProxy(installInput);
      const recordId = data.id || store.generateId();
      const proxyEntryData = {
        id: existing?.proxyEntryId,
        label: installed.record.label,
        country: installed.record.country,
        scheme: installed.record.proxy.scheme || "socks5",
        host: installed.record.proxy.host,
        port: installed.record.proxy.port,
        username: installed.record.proxy.username,
        password: installed.record.proxy.password,
        bypassList: installed.record.proxy.bypassList || ["localhost", "127.0.0.1"],
        ispName: installed.record.proxy.ispName || "",
        ispAsn: installed.record.proxy.ispAsn || "",
        city: installed.record.proxy.city || "",
        private: true,
        source: "vps",
        vpsId: recordId,
        infoPort: installed.record.proxy.infoPort,
        httpPort: installed.record.proxy.httpPort
      };

      let proxyEntry = existing?.proxyEntryId
        ? store.updateProxyEntry(existing.proxyEntryId, proxyEntryData)
        : null;
      if (!proxyEntry) proxyEntry = store.addProxyEntry(proxyEntryData);
      const saved = store.upsertVpsProxy({
        ...installed.record,
        id: recordId,
        proxyEntryId: proxyEntry.id,
        proxy: { ...installed.record.proxy, id: proxyEntry.id }
      });
      return { ok: true, record: saved, proxy: proxyEntry };
    } catch (err) {
      logError(err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("VPS_PROXY_TEST", async (_ev, { id } = {}) => {
    try {
      const record = store.getVpsProxies({ includeSecrets: true }).find((r) => r.id === id);
      if (!record) return { ok: false, error: "VPS proxy not found" };
      const info = await vpsProxy.fetchInfo(record.proxy.host || record.ssh.host, record.proxy.infoPort || 8888);
      const proxy = await testProxy(
        record.proxy.host || record.ssh.host,
        record.proxy.port || 1080,
        record.proxy.scheme || "socks5",
        record.proxy.username || "",
        record.proxy.password || ""
      );
      return { ok: Boolean(proxy.ok), info, proxy, error: proxy.error || info.error || "" };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("VPS_PROXY_DELETE", async (_ev, { id } = {}) => {
    const record = store.getVpsProxies({ includeSecrets: true }).find((r) => r.id === id);
    if (record?.proxyEntryId) store.deleteProxyEntry(record.proxyEntryId);
    store.deleteVpsProxy(id);
    return { ok: true };
  });

  // ── Proxy test ────────────────────────────────────────────────────────────────

  ipcMain.handle("TEST_PROXY", async (_ev, { host, port, scheme, username, password } = {}) => {
    // Substitute {{profile}} placeholders with a stand-in so the test still
    // exercises a real session ID against the upstream — otherwise sticky
    // providers reject the request and the user can't validate their template.
    const expandedUsername = expandProxyTestUsername(username);
    return testProxy(host, port, scheme, expandedUsername, password);
  });

  ipcMain.handle("PROXY_DETECT_LOCATION", async (_ev, { host, port, scheme, username, password } = {}) => {
    if (!host || !port) return { ok: false, error: "missing host or port" };
    const { session: electronSession } = require("electron");
    const partitionId = "proxy-geo-" + Date.now();
    const tempSess = electronSession.fromPartition(partitionId, { cache: false });
    const expandedUsername = expandProxyTestUsername(username);
    const cleanupProxy = await configureTempProxySession(tempSess, partitionId, { host, port, scheme, username: expandedUsername, password });
    const GEO_URLS = [
      "https://ipwho.is/",
      "https://ipapi.co/json/",
      "http://ip-api.com/json/?fields=status,message,continent,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,query"
    ];
    let lastError = "";
    try {
      for (const geoUrl of GEO_URLS) {
        const result = await fetchJsonViaProxy(geoUrl, tempSess, expandedUsername, password);
        if (result.ok && result.data) {
          const n = normalizeNetworkCapture(result.data);
          if (n.ip) {
            n.proxyType = detectProxyType(n.ispName, n.ispAsn, n.organization);
            return { ok: true, network: n };
          }
        }
        lastError = result.error || lastError;
        if (result.fatal) break;
      }
    } finally {
      cleanupProxy();
    }
    return { ok: false, error: lastError || "Could not detect proxy location" };
  });

  ipcMain.handle("NETWORK_CAPTURE_CURRENT", async () => {
    try {
      const network = await captureCurrentNetwork();
      // Classify the live connection so the UI/launch gate can tell whether a
      // VPN is actually on: commercial VPN exits read as "datacenter", the
      // user's real home connection reads as "residential"/"mobile".
      network.connectionType = classifyConnection(network);
      network.isVpn = network.connectionType === "datacenter";
      return { ok: true, network };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────

  ipcMain.handle("AUTH_SESSION", async () => {
    const session = authStore.getSession();
    return { ok: true, session };
  });

  ipcMain.handle("AUTH_REGISTER", async (_ev, { email, password } = {}) => {
    const result = await authStore.register(email, password);
    // Only sync if no email confirmation is needed (user is immediately active)
    if (result.ok && !result.needsConfirmation) await postLoginSync();
    return result;
  });

  ipcMain.handle("AUTH_LOGIN", async (_ev, { email, password } = {}) => {
    const result = await authStore.login(email, password);
    if (result.ok) await postLoginSync();
    return result;
  });

  ipcMain.handle("AUTH_LOGOUT", async () => {
    await authStore.logout();
    return { ok: true };
  });

  // ── Cloud sync ────────────────────────────────────────────────────────────────

  ipcMain.handle("CLOUD_SYNC_NOW", async () => {
    return await postLoginSync();
  });

  // ── Tab management ────────────────────────────────────────────────────────────

  function getCallerWindowId(ev) {
    const win = BrowserWindow.fromWebContents(ev.sender);
    return win ? win.id : null;
  }

  ipcMain.handle("TAB_NEW", async (ev, { url } = {}) => {
    const winId = getCallerWindowId(ev);
    if (winId == null) return { ok: false };
    const id = addTab(winId, url || startPageUrl());
    return { ok: Boolean(id), tabId: id };
  });

  ipcMain.handle("TAB_CLOSE", async (ev, { tabId } = {}) => {
    const winId = getCallerWindowId(ev);
    if (winId == null) return { ok: false };
    closeTab(winId, tabId);
    return { ok: true };
  });

  ipcMain.handle("TAB_ACTIVATE", async (ev, { tabId } = {}) => {
    const winId = getCallerWindowId(ev);
    if (winId == null) return { ok: false };
    activateTab(winId, tabId);
    return { ok: true };
  });

  ipcMain.handle("TAB_NAVIGATE", async (ev, { url } = {}) => {
    const winId = getCallerWindowId(ev);
    const active = winId != null ? getActiveTab(winId) : null;
    if (!active) return { ok: false };
    const target = url === "home" ? startPageUrl() : url;
    active.view.webContents.loadURL(target);
    return { ok: true };
  });

  ipcMain.handle("TAB_BACK", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active) {
      const wc = active.view.webContents;
      if (wcCanGoBack(wc)) {
        try { if (wc.navigationHistory && typeof wc.navigationHistory.goBack === "function") wc.navigationHistory.goBack(); else if (typeof wc.goBack === "function") wc.goBack(); } catch (_) {}
      }
    }
    return { ok: true };
  });

  ipcMain.handle("TAB_FORWARD", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active) {
      const wc = active.view.webContents;
      if (wcCanGoForward(wc)) {
        try { if (wc.navigationHistory && typeof wc.navigationHistory.goForward === "function") wc.navigationHistory.goForward(); else if (typeof wc.goForward === "function") wc.goForward(); } catch (_) {}
      }
    }
    return { ok: true };
  });

  ipcMain.handle("TAB_RELOAD", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active) active.view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle("TAB_STOP", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active) {
      try { active.view.webContents.stop(); } catch (_) {}
    }
    return { ok: true };
  });

  ipcMain.handle("BROWSER_SHOW_MESSAGE", async (ev, opts = {}) => {
    const winId = getCallerWindowId(ev);
    const win = winId != null ? BrowserWindow.fromId(winId) : null;
    const type = opts.type === "error" || opts.type === "warning" || opts.type === "info" ? opts.type : "info";
    try {
      await dialog.showMessageBox(win || undefined, {
        type,
        title: String(opts.title || "Privacy Shield"),
        message: String(opts.message || ""),
        buttons: ["OK"]
      });
    } catch (_) {}
    return { ok: true };
  });

  ipcMain.handle("TAB_GET_STATE", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    if (!state) return { tabs: [], activeTabId: null };
    return {
      activeTabId: state.activeTabId,
      meta: getProfileBrowserMeta(state.profileId),
      tabs: state.tabs.map((t) => {
        const wc = t.view.webContents;
        const alive = !wc.isDestroyed();
        return {
          id: t.id,
          title: alive ? (wc.getTitle() || t.url || "New tab") : t.title,
          url: alive ? wc.getURL() : t.url,
          canBack: alive ? wcCanGoBack(wc) : false,
          canForward: alive ? wcCanGoForward(wc) : false,
          loading: alive ? wc.isLoadingMainFrame() : false
        };
      })
    };
  });

  ipcMain.handle("BROWSER_PROFILE_META", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    return { ok: Boolean(state), meta: state ? getProfileBrowserMeta(state.profileId) : null };
  });

  ipcMain.handle("BROWSER_LOAD_EXTENSION", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    const win = winId != null ? BrowserWindow.fromId(winId) : null;
    if (!state) return { ok: false, error: "Profile browser window not found" };

    const picked = await dialog.showOpenDialog(win || undefined, {
      title: "Load unpacked extension folder",
      properties: ["openDirectory"]
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };

    try {
      const loaded = await loadExtensionIntoProfile(state.profileId, picked.filePaths[0]);
      emitTabState(winId);
      return { ok: true, extension: loaded };
    } catch (err) {
      logError(`Load extension failed: ${err?.stack || err}`);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("BROWSER_INSTALL_EXTENSION_ZIP", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    const win = winId != null ? BrowserWindow.fromId(winId) : null;
    if (!state) return { ok: false, error: "Profile browser window not found" };

    const picked = await dialog.showOpenDialog(win || undefined, {
      title: "Install extension ZIP",
      properties: ["openFile"],
      filters: [
        { name: "Extension ZIP", extensions: ["zip"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };

    try {
      const loaded = await loadExtensionIntoProfile(state.profileId, picked.filePaths[0], { archive: true });
      emitTabState(winId);
      return { ok: true, extension: loaded };
    } catch (err) {
      logError(`Install extension ZIP failed: ${err?.stack || err}`);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("BROWSER_OPEN_DOWNLOADS", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    if (!state) return { ok: false, error: "Profile browser window not found" };
    const profile = store.getProfiles().find((entry) => entry.id === state.profileId && !entry.deletedAt);
    const directory = sessionMgr.getDownloadDirectory(profile || state.profileId);
    const error = await shell.openPath(directory);
    return error ? { ok: false, error } : { ok: true, path: directory };
  });

  ipcMain.handle("BROWSER_LIST_EXTENSIONS", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    if (!state) return { ok: false, error: "Profile browser window not found" };
    const sess = sessionMgr.getSessionForProfile(state.profileId);
    const loaded = typeof sess.getAllExtensions === "function" ? sess.getAllExtensions() : [];
    const profile = store.getProfiles().find((p) => p.id === state.profileId && !p.deletedAt);
    return {
      ok: true,
      extensions: loaded.map((ext) => ({ id: ext.id, name: ext.name, path: ext.path })),
      saved: Array.isArray(profile?.extensions) ? profile.extensions : []
    };
  });

  // Popup a native menu showing extensions + a Load Unpacked entry. Used by the
  // tab-strip gear button — the HTML dropdown is invisible because the tab-strip
  // BrowserWindow is only 78px tall, so we open a real OS context menu instead.
  ipcMain.handle("BROWSER_EXTENSIONS_MENU", async (ev) => {
    const winId = getCallerWindowId(ev);
    const win = winId != null ? BrowserWindow.fromId(winId) : null;
    const state = winId != null ? windowTabState.get(winId) : null;
    if (!win || !state) return { ok: false, error: "Profile browser window not found" };

    const sess = sessionMgr.getSessionForProfile(state.profileId);
    const loaded = typeof sess.getAllExtensions === "function" ? sess.getAllExtensions() : [];
    const profile = store.getProfiles().find((p) => p.id === state.profileId && !p.deletedAt);
    const saved = Array.isArray(profile?.extensions) ? profile.extensions : [];

    const items = loaded.length ? loaded.map((e) => ({ name: e.name || e.id, path: e.path || "" })) : saved.map((e) => ({ name: e.name || e.id || "Extension", path: e.path || "" }));

    const template = [
      { label: items.length ? `${items.length} extension${items.length === 1 ? "" : "s"} for this profile` : "No extensions loaded", enabled: false },
      { type: "separator" }
    ];
    for (const it of items) {
      template.push({ label: `  • ${it.name}${it.path ? "  —  " + it.path : ""}`, enabled: false });
    }
    if (items.length) template.push({ type: "separator" });
    template.push({
      label: "Load unpacked extension folder...",
      click: async () => {
        try {
          const r = await dialog.showOpenDialog(win, {
            properties: ["openDirectory"],
            title: "Choose extension folder"
          });
          if (r.canceled || !r.filePaths.length) return;
          try {
            const extension = await loadExtensionIntoProfile(state.profileId, r.filePaths[0]);
            emitTabState(winId);
            await dialog.showMessageBox(win, {
              type: "info",
              title: "Extension loaded",
              message: `Loaded: ${extension.name || r.filePaths[0]}`
            });
          } catch (err) {
            logError(`Load extension failed: ${err.stack || err}`);
            await dialog.showMessageBox(win, { type: "error", title: "Extension load failed", message: (err && err.message) || String(err) });
          }
        } catch (err) {
          logError(`Load extension flow failed: ${err.stack || err}`);
        }
      }
    });
    template.push({
      label: "Install extension from ZIP...",
      click: async () => {
        try {
          const r = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            title: "Choose extension ZIP",
            filters: [
              { name: "Extension ZIP", extensions: ["zip"] },
              { name: "All files", extensions: ["*"] }
            ]
          });
          if (r.canceled || !r.filePaths.length) return;
          try {
            const extension = await loadExtensionIntoProfile(state.profileId, r.filePaths[0], { archive: true });
            emitTabState(winId);
            await dialog.showMessageBox(win, {
              type: "info",
              title: "Extension installed",
              message: `Installed: ${extension.name || r.filePaths[0]}`
            });
          } catch (err) {
            logError(`Install extension ZIP failed: ${err.stack || err}`);
            await dialog.showMessageBox(win, { type: "error", title: "Extension install failed", message: (err && err.message) || String(err) });
          }
        } catch (err) {
          logError(`Install extension ZIP flow failed: ${err.stack || err}`);
        }
      }
    });
    template.push({ type: "separator" });
    template.push({
      label: "Open this profile's downloads",
      click: async () => {
        const currentProfile = store.getProfiles().find((entry) => entry.id === state.profileId && !entry.deletedAt);
        const directory = sessionMgr.getDownloadDirectory(currentProfile || state.profileId);
        const error = await shell.openPath(directory);
        if (error) {
          await dialog.showMessageBox(win, { type: "error", title: "Could not open downloads", message: error });
        }
      }
    });
    Menu.buildFromTemplate(template).popup({ window: win });
    return { ok: true };
  });
}

// On login/register, pull any cloud data into the per-user local dir, then
// push anything that exists locally only (first-time login on this PC).
async function postLoginSync() {
  try {
    const cloud = require("./cloud-sync");
    const localProfiles = store.getProfiles();
    const localProxies  = store.getProxyLibrary();

    // Push cloud-safe metadata only. Cookies, localStorage, sessions, and proxy
    // credentials stay in the local encrypted store and are merged back after pull.
    if (localProfiles.length) await cloud.pushAllProfiles(localProfiles);
    if (localProxies.length)  await cloud.pushAllProxies(localProxies);

    const remoteProfiles = await cloud.pullProfiles();
    const remoteProxies  = await cloud.pullProxies();
    const mergedProfiles = remoteProfiles.ok ? store.saveSyncedProfiles(remoteProfiles.profiles || []) : localProfiles;
    const mergedProxies = remoteProxies.ok ? store.saveSyncedProxyLibrary(remoteProxies.proxies || []) : localProxies;

    return { ok: true, profileCount: mergedProfiles.length, proxyCount: mergedProxies.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Profile window management ─────────────────────────────────────────────
function getProfileBrowserMeta(profileId) {
  const profile = store.getProfiles().find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return null;
  const fp = profile.fingerprint || {};
  const proxy = profile.proxy || {};
  const mode = proxy.networkMode || (proxy.enabled ? "proxy" : "direct");
  const browser = fp.browser || profile.browserApp || "chrome";
  const mobileModelLooksReal = Boolean(fp.mobileModel && String(fp.mobileModel).trim());
  const screenLooksMobile = Number(fp.screenWidth) > 0 && Number(fp.screenWidth) <= 480 && Number(fp.screenHeight) <= 1100;
  const deviceClass = (fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios" || (mobileModelLooksReal && screenLooksMobile)) ? "mobile" : "desktop";
  const browserLabels = {
    privacy: "Privacy Shield",
    chrome: "Google Chrome",
    brave: "Brave",
    edge: "Microsoft Edge",
    firefox: "Firefox",
    safari: "Safari"
  };
  const osLabels = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    android: "Android",
    ios: "iOS"
  };
  return {
    appName: browserLabels[browser] || "Chromium",
    runtimeName: "Privacy Shield Chromium",
    profileId: profile.id,
    profileName: profile.name || "Profile",
    country: fp.country || "",
    countryCode: fp.countryCode || "",
    city: fp.city || "",
    deviceClass,
    os: profile.os || "windows",
    osLabel: osLabels[profile.os || "windows"] || "Windows",
    browser,
    browserLabel: browserLabels[browser] || "Chromium",
    screen: fp.screenWidth && fp.screenHeight ? `${fp.screenWidth}x${fp.screenHeight}` : "",
    dpr: fp.devicePixelRatio || 1,
    mobileModel: fp.mobileModel || "",
    extensionCount: Array.isArray(profile.extensions) ? profile.extensions.length : 0,
    networkMode: mode,
    networkLabel: mode === "proxy" ? "VPS/proxy" : mode === "vpn" ? "VPN" : "Direct",
    proxyHost: mode === "proxy" && proxy.host ? `${proxy.host}:${proxy.port || ""}` : "",
    timezone: fp.timezoneValue || "",
    language: fp.languageValue || ""
  };
}

async function openCloudPhoneWindow(id) {
  const record = store.getCloudPhones().find((phone) => phone.id === id);
  if (!record) return { ok: false, error: "Cloud phone not found" };

  let remoteUrl;
  try {
    remoteUrl = new URL(record.remoteUrl);
    if (!["http:", "https:"].includes(remoteUrl.protocol)) throw new Error("unsupported protocol");
  } catch (_) {
    return { ok: false, error: "Add a valid provider console URL before opening this cloud phone" };
  }

  const existing = cloudPhoneWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true, windowId: existing.id, existing: true };
  }

  const win = new BrowserWindow({
    width: 430,
    height: 900,
    title: `Android Cloud Phone - ${record.label}`,
    backgroundColor: "#0c0f14",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  cloudPhoneWindows.set(id, win);
  store.upsertCloudPhone({ ...record, status: "running" });
  notifyManagerWindows("CLOUD_PHONES_CHANGED");

  win.on("closed", () => {
    cloudPhoneWindows.delete(id);
    const latest = store.getCloudPhones().find((phone) => phone.id === id);
    if (latest && latest.status === "running") store.upsertCloudPhone({ ...latest, status: "available" });
    notifyManagerWindows("CLOUD_PHONES_CHANGED");
  });

  try {
    await win.loadURL(remoteUrl.toString());
    return { ok: true, windowId: win.id };
  } catch (err) {
    logError(err);
    try { win.destroy(); } catch (_) {}
    return { ok: false, error: "Cloud phone console failed to load: " + (err.message || err) };
  }
}

function buildUserAgentMetadata(config) {
  const major = String(config._uaVersion || ((config.userAgent || "").match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || "150");
  const full = `${major}.0.0.0`;
  const browser = config._browserApp || "chrome";
  const brand = browser === "edge" ? "Microsoft Edge" : browser === "brave" ? "Brave" : browser === "privacy" ? "Privacy Shield Browser" : "Google Chrome";
  const isIos = config._uaOS === "iOS";
  return {
    brands: isIos ? [] : [
      { brand: "Not_A Brand", version: "8" },
      { brand: "Chromium", version: major },
      { brand, version: major }
    ],
    fullVersionList: isIos ? [] : [
      { brand: "Not_A Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: full },
      { brand, version: full }
    ],
    platform: config._uaOS || "Android",
    platformVersion: config._platformVersion || (isIos ? "17.2" : "14"),
    architecture: config._architecture || "arm",
    model: config._mobileModel || "",
    mobile: Boolean(config._mobile),
    bitness: config._bitness || "64",
    wow64: false
  };
}

async function applyTabEmulation(webContents, profile, hostWindow) {
  const config = store.buildConfigFromProfile(profile);
  if (config.userAgent) {
    try { webContents.setUserAgent(config.userAgent); } catch (_) {}
  }

  const screen = config.screen || {};
  const isMobile = Boolean(config._mobile || config._viewportMobile || config._touchEmulation);
  const rawW = Number(screen.width) || (isMobile ? 412 : 1366);
  const rawH = Number(screen.height) || (isMobile ? 915 : 768);

  // Separate viewport (CSS pixels the page renders at) from screen (what
  // window.screen.* reports). Conflating them caused pages to render at the
  // user's chosen "screen" size (e.g. 3840) inside a 1280px window — content
  // overflowed off-screen because the page believed it had a 4K viewport.
  const screenW = isMobile
    ? Math.max(320, Math.min(480, rawW > 600 ? 412 : rawW))
    : Math.max(800, Math.min(7680, rawW));
  const screenH = isMobile
    ? Math.max(640, Math.min(960, rawH > 1100 ? 915 : rawH))
    : Math.max(600, Math.min(4320, rawH));

  // Viewport = actual window content size for desktop (let Chromium use what
  // fits the window); mobile keeps the clamped phone width because the window
  // is sized to match.
  let viewportW = screenW;
  let viewportH = screenH;
  if (!isMobile) {
    try {
      const hostWin = hostWindow || BrowserWindow.fromWebContents(webContents);
      if (hostWin && !hostWin.isDestroyed()) {
        const [cw, ch] = hostWin.getContentSize();
        viewportW = Math.max(640, cw);
        viewportH = Math.max(480, Math.max(0, ch - getWindowChromeHeight(hostWin.id)));
      }
      // If we still can't find the host window, leave viewport equal to screen
      // (the legacy behaviour) so the page at least renders something —
      // returning a viewport that's too small to draw above the fold leaves the
      // user staring at a blank page.
    } catch (_) {}
  }
  if (isMobile) {
    try {
      const hostWin = hostWindow || BrowserWindow.fromWebContents(webContents);
      if (hostWin && !hostWin.isDestroyed()) {
        const [cw, ch] = hostWin.getContentSize();
        const topChrome = getWindowChromeHeight(hostWin.id);
        const bottomInset = getWindowBottomInset(hostWin.id);
        viewportW = Math.max(320, Math.min(screenW, cw));
        viewportH = Math.max(360, Math.min(screenH, Math.max(0, ch - topChrome - bottomInset)));
      }
    } catch (_) {}
  }
  const width = viewportW;
  const height = viewportH;
  const dpr = Math.max(1, Math.min(4, Number(config._devicePixelRatio) || (isMobile ? 2.625 : 1)));
  const send = async (method, params) => {
    try {
      await webContents.debugger.sendCommand(method, params);
    } catch (err) {
      logError(`Mobile emulation ${method} failed: ${err.message || err}`);
    }
  };

  try {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
  } catch (err) {
    logError(`Mobile emulation attach failed: ${err.message || err}`);
    return;
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: isMobile,
    screenWidth: screenW,
    screenHeight: screenH,
    positionX: 0,
    positionY: 0,
    scale: 1,
    screenOrientation: isMobile
      ? { type: "portraitPrimary", angle: 0 }
      : { type: "landscapePrimary", angle: 90 }
  });
  if (isMobile || config._touchEmulation) {
    // Touch capability flag: page sees navigator.maxTouchPoints > 0 and Touch API
    // — required to look like a real phone. Independent of how we route mouse.
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: Math.max(1, Number(config._maxTouchPoints) || 5)
    });
    // Mouse-to-touch conversion: when enabled, every mouse drag becomes a touch
    // drag (pan/scroll), which means the user cannot highlight text, can't drag
    // to select, and right-click context menu / DevTools become awkward.
    // Default OFF so the operator can interact with the page normally; pages
    // still see touch capability via setTouchEmulationEnabled above.
    if (config._emitTouchForMouse === true) {
      await send("Emulation.setEmitTouchEventsForMouse", {
        enabled: true,
        configuration: isMobile ? "mobile" : "desktop"
      });
    }
  }
  await send("Emulation.setUserAgentOverride", {
    userAgent: config.userAgent,
    platform: config.platform || (isMobile ? "Linux armv8l" : "Win32"),
    userAgentMetadata: buildUserAgentMetadata(config)
  });

  if (config.geo) {
    await send("Emulation.setGeolocationOverride", {
      latitude: Number(config.geo.latitude) || 0,
      longitude: Number(config.geo.longitude) || 0,
      accuracy: Number(config.geo.accuracy) || 50
    });
  }

  // CDP-level timezone override — applies to Workers and iframes, not just the main page.
  // This is harder to detect than JS Date.prototype.getTimezoneOffset patching.
  if (config.timezone) {
    await send("Emulation.setTimezoneOverride", { timezoneId: config.timezone });
  }

  // CDP-level locale override — affects Intl.* APIs at the Chromium binding layer.
  if (config.language) {
    await send("Emulation.setLocaleOverride", { locale: config.language });
  }

  // CDP-level hardware concurrency — applies inside WebWorkers where JS preload cannot reach.
  const concurrency = Number(config.hardwareConcurrency) || 4;
  await send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: concurrency });

  // Block cookies at the CDP layer (belt-and-suspenders on top of the JS override).
  if (config.blockCookies) {
    await send("Emulation.setDocumentCookieDisabled", { disabled: true });
  }
}

async function openProfileWindow(profileId, customUrl, options = {}) {
  // If already open, focus or open a new tab for the requested URL
  const existing = profileWindows.get(profileId);
  if (existing && !existing.isDestroyed()) {
    if (customUrl) addTab(existing.id, customUrl);
    existing.focus();
    return { ok: true, windowId: existing.id, existing: true };
  }

  // Memory guard: each open profile is a full Chromium renderer (~200-300 MB).
  // Without a ceiling, opening too many at once exhausts RAM and the OS kills
  // the whole app — losing every open session at once. Refuse gracefully with an
  // actionable message (the renderer surfaces {ok:false,error}) instead. Refocus
  // of an already-open profile is exempt (handled above, doesn't reach here).
  {
    const PER_PROFILE_MB = 300;
    const openCount = [...profileWindows.values()].filter((w) => w && !w.isDestroyed()).length;
    const totalMB = os.totalmem() / (1024 * 1024);
    const freeMB = os.freemem() / (1024 * 1024);
    // Absolute soft cap scaled to total RAM (min 5), plus a live free-RAM check.
    const capByTotal = Math.max(5, Math.floor(totalMB / 400));
    const tooMany = openCount >= capByTotal;
    const lowMemory = openCount > 0 && freeMB < PER_PROFILE_MB * 1.5;
    if (tooMany || lowMemory) {
      const reason = tooMany
        ? `You already have ${openCount} profiles open, which is the safe limit for this PC's memory (${Math.round(totalMB / 1024)} GB RAM).`
        : `This PC is low on free memory (${Math.round(freeMB)} MB left) — opening another profile could crash the app.`;
      return { ok: false, error: `${reason} Close some open profiles and try again.` };
    }
  }

  const profiles = store.getProfiles();
  let profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return { ok: false, error: "Profile not found" };

  // ── Required fields & consistency checks ─────────────────────────────────────
  let px = profile.proxy || {};
  const networkMode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (networkMode === "proxy" && px.enabled) {
    if (!px.host || !px.port) {
      return { ok: false, error: "Proxy is enabled but host/port are missing. Fill them in the Proxy tab and click Test, then save." };
    }
  }
  // ── Proxy geo auto-detection at launch ──────────────────────────────────────
  // For proxy profiles the exit is the proxy itself (not the OS network), so the
  // VPN location lock below — which reads the system connection — can't see it.
  // Route an IP-geo lookup THROUGH the proxy every launch and refresh the
  // detected* fields, so "Auto (from VPN / proxy IP)" timezone / language /
  // geolocation resolve to the proxy's REAL current location instead of a stale
  // Test result (or nothing, if the user never clicked Test). Placeholders are
  // expanded with this profile so the sticky session ID matches the browser's.
  if (networkMode === "proxy" && px.enabled && px.host && px.port) {
    try {
      const expandedUser = sessionMgr.expandProxyPlaceholders(px.username, profile);
      const geo = await detectProxyGeo({
        host: px.host, port: px.port, scheme: px.scheme,
        username: expandedUser, password: px.password
      });
      if (geo && geo.countryCode) {
        const updated = store.updateProfile(profileId, {
          proxy: {
            detectedCountryCode: geo.countryCode,
            detectedCountry: geo.country,
            detectedCity: geo.city,
            detectedState: geo.state,
            detectedTimezone: geo.timezone,
            detectedLatitude: geo.latitude,
            detectedLongitude: geo.longitude,
            detectedIp: geo.ip,
            proxyType: geo.proxyType || (geo.isMobile ? "mobile" : ""),
            detectedAt: Date.now()
          }
        });
        if (updated) { profile = updated; px = profile.proxy || {}; }
      } else {
        logError(`proxy geo auto-detect returned nothing profile=${profileId} host=${px.host}:${px.port}`);
      }
    } catch (err) {
      // Non-fatal: fall back to whatever was last detected. Never block a launch
      // just because the geo API was unreachable.
      logError(`proxy geo auto-detect failed profile=${profileId}: ${err && (err.message || err)}`);
    }
  }

  // Geo consistency: runs for both proxy and VPN modes
  if ((networkMode === "proxy" || networkMode === "vpn") && px.detectedCountryCode && profile.fingerprint) {
    const fp = profile.fingerprint;
    const tzMode = fp.timezone || "auto";
    if (tzMode === "manual" && fp.timezoneValue) {
      const tzCountry = guessCountryFromTimezone(fp.timezoneValue);
      const detectedCountry = String(px.detectedCountryCode).toLowerCase();
      if (tzCountry && tzCountry !== detectedCountry) {
        const networkLabel = networkMode === "vpn" ? "VPN" : "proxy";
        const locationLabel = px.detectedCountry || detectedCountry.toUpperCase();
        return { ok: false, error: `Geo mismatch: ${networkLabel} is in ${locationLabel} but timezone "${fp.timezoneValue}" belongs to ${tzCountry.toUpperCase()}. Fix timezone in the Fingerprint tab (or set it to Auto) and save.` };
      }
    }
  }

  // ── VPN location lock ───────────────────────────────────────────────────────
  // Runs for BOTH "vpn" and "direct" profiles: in either case the browser uses
  // the OS network (and so does Electron's net.request), so the live capture
  // reflects the real exit IP — which is whatever system-wide VPN is active.
  // (Skipped for "proxy" mode, where the exit is the proxy, not the system net.)
  // We lock each profile to the location it first launched on: if the exit is
  // now in a different place we DO NOT launch — we hand the renderer the old vs
  // new location and let the user either switch the VPN back or accept the new
  // one. This both prevents an accidental location swap and guards against
  // launching with no/leaky network when the VPN is actually down.
  if (networkMode === "vpn" || networkMode === "direct") {
    let current;
    try {
      current = await captureCurrentNetwork();
    } catch (err) {
      return { ok: false, error: "Couldn't verify your VPN location — no IP service was reachable. Make sure your VPN is connected, then click Start again.\n\nDetail: " + (err.message || err) };
    }

    const currentType = classifyConnection(current);
    const currentIsVpn = currentType === "datacenter";

    // The profile's ANCHOR location — what it's expected to run on. The location
    // the user captured for the profile ("Capture current VPN/IP" / country
    // setup → proxy.detected*) is authoritative; only if nothing was ever
    // captured do we fall back to the last launched location.
    const anchor = profileAnchor(profile);

    // A profile is "VPN-bound" if it was explicitly put in VPN mode, or its
    // anchor was a VPN/datacenter exit.
    const requiresVpn = networkMode === "vpn" || (anchor && anchor.isVpn === true);

    // No-VPN guard: a VPN-bound profile must NOT open on the user's real ISP.
    // Hard-block when the live connection looks like a consumer ISP
    // (residential/mobile); an "unknown" type is allowed through so an
    // unrecognised VPN host can never falsely lock the user out.
    if (requiresVpn && !currentIsVpn && (currentType === "residential" || currentType === "mobile")) {
      return {
        ok: false,
        error: "No VPN connected. This profile is set up to run behind a VPN — connect your VPN first, then click Start.\n\nRight now you're on what looks like a normal ISP"
          + (current.ispName ? ` (${current.ispName})` : "")
          + (current.country ? `, ${current.country}` : "") + "."
      };
    }

    if (anchor && !locationsMatch(anchor, current) && !options.acceptNewLocation) {
      // Different location than the profile's anchor → block and ask the user.
      return {
        ok: false,
        needsLocationConfirm: true,
        profileId,
        profileName: profile.name || "Profile",
        last: { ip: anchor.ip, country: anchor.country, countryCode: anchor.countryCode, city: anchor.city, state: anchor.state, capturedAt: anchor.capturedAt },
        current: { ip: current.ip, country: current.country, countryCode: current.countryCode, city: current.city, state: current.state }
      };
    }

    // Reaching here = no anchor (brand-new), location matches, or user accepted
    // the new location. Record the launched location. If the user explicitly
    // accepted a NEW location, re-anchor the profile to it (update the captured
    // proxy.detected* fields) so it becomes the profile's new expected home.
    try {
      // Always refresh the detected* fields from the LIVE exit so the
      // "Auto (from VPN / proxy IP)" timezone / language / geolocation resolve
      // to the REAL location of the VPN the user is on — including latitude/
      // longitude, which the old patch dropped (so geo-auto never worked for
      // VPN). Persisting to the store here means the fingerprint built
      // downstream (addTab / GET_PROFILE_CONFIG, which read the store) uses the
      // correct location. We only reach this line once `current` already
      // matched the profile's anchor country (or the user accepted a new one),
      // so refreshing every launch keeps the anchor consistent, not drifting.
      const patch = {
        lastVpnNetwork: {
          ip: current.ip,
          country: current.country,
          countryCode: current.countryCode,
          city: current.city,
          state: current.state,
          connectionType: currentType,
          isVpn: currentIsVpn,
          capturedAt: Date.now()
        },
        proxy: {
          detectedCountryCode: current.countryCode,
          detectedCountry: current.country,
          detectedCity: current.city,
          detectedState: current.state,
          detectedTimezone: current.timezone,
          detectedLatitude: current.latitude,
          detectedLongitude: current.longitude,
          detectedIp: current.ip,
          proxyType: currentIsVpn ? "vpn" : currentType,
          detectedAt: Date.now()
        }
      };
      const updated = store.updateProfile(profileId, patch);
      if (updated) profile = updated; // use the fresh object for THIS launch's session/config
    } catch (_) {}
  }

  // ── Same-exit-IP collision guard ────────────────────────────────────────────
  // Two profiles sharing ONE exit IP are linkable no matter how distinct their
  // fingerprints are — the dominant multi-account tell ("all these accounts come
  // from one machine"). By this point the exit IP is freshly known: proxy mode
  // refreshed it via the auto-detect above, vpn/direct via the location lock.
  // Warn (not block) if another saved profile is already on the same IP so the
  // user can give this profile its own proxy — or knowingly launch anyway.
  if (!options.acceptSharedIp) {
    const thisIp = String((profile.proxy && profile.proxy.detectedIp) || "").trim();
    if (thisIp) {
      const clash = store.getProfiles().find((p) =>
        p.id !== profileId && !p.deletedAt &&
        String((p.proxy && p.proxy.detectedIp) || "").trim() === thisIp
      );
      if (clash) {
        const otherWin = profileWindows.get(clash.id);
        const otherOpen = Boolean(otherWin && !otherWin.isDestroyed());
        logError(`ip collision profile=${profileId} shares ip=${thisIp} with profile=${clash.id} (${clash.name || ""}) open=${otherOpen}`);
        return {
          ok: false,
          needsIpConfirm: true,
          profileId,
          profileName: profile.name || "Profile",
          sharedIp: thisIp,
          otherProfileId: clash.id,
          otherProfileName: clash.name || "Another profile",
          otherProfileOpen: otherOpen
        };
      }
    }
  }

  let sess;
  try {
    sess = await sessionMgr.setupProfileSession(profile);
    sessionMgr.assertProfileSession(sess, profileId);
  } catch (err) {
    return { ok: false, error: "Profile session setup failed: " + (err.message || err) };
  }

  // The host window and every website tab share this profile's persistent
  // partition. No profile browser WebContents may use Electron's default session.
  const offset = profileWindows.size * 30;
  const fp = profile.fingerprint || {};
  const mobileModelLooksReal = Boolean(fp.mobileModel && String(fp.mobileModel).trim());
  const screenLooksMobile = Number(fp.screenWidth) > 0 && Number(fp.screenWidth) <= 480 && Number(fp.screenHeight) <= 1100;
  // profile.os is authoritative. If the user explicitly picked a desktop OS,
  // never treat as mobile — otherwise leftover fp.deviceClass / mobileModel /
  // small-screen values from a previous mobile session keep forcing mobile
  // layout even after the user switched to Windows/macOS/Linux.
  const osIsMobile = profile.os === "android" || profile.os === "ios";
  const osIsDesktop = profile.os === "windows" || profile.os === "macos" || profile.os === "linux";
  const isMobileProfile = osIsMobile
    || (!osIsDesktop && (fp.deviceClass === "mobile" || (mobileModelLooksReal && screenLooksMobile)));
  const mobW = Number(fp.screenWidth) || 412;
  const mobH = Number(fp.screenHeight) || 915;
  const mobileViewportWidth = Math.max(360, Math.min(460, mobW > 600 ? 412 : mobW));
  const mobileViewportHeight = Math.max(640, Math.min(932, mobH > 1100 ? 915 : mobH));
  const chromeHeight = isMobileProfile ? MOBILE_CHROME_HEIGHT : DESKTOP_CHROME_HEIGHT;
  const bottomInset = isMobileProfile ? MOBILE_BOTTOM_NAV_HEIGHT : 0;
  const winWidth = isMobileProfile ? mobileViewportWidth : 1280;
  // Cap window height to user's screen so the bottom doesn't go off-screen on
  // laptops with short displays (1366x768, 1440x900). Leave 60px headroom for
  // taskbar + window title bar. Allow resize when capped so user can fine-tune.
  const workArea = (() => {
    try { return screen.getPrimaryDisplay().workArea; } catch (_) { return { height: 800, y: 0 }; }
  })();
  const desiredMobileHeight = mobileViewportHeight + chromeHeight + bottomInset;
  const maxUsableHeight = Math.max(480, workArea.height - 60);
  const mobileHeightCapped = desiredMobileHeight > maxUsableHeight;
  const winHeight = isMobileProfile ? Math.min(desiredMobileHeight, maxUsableHeight) : 800;
  const meta = getProfileBrowserMeta(profileId) || {};
  const windowTitle = `${meta.browserLabel || "Browser"} - ${profile.name}`;
  const profileIcon = createProfileIcon(profile);
  const winOpts = {
    show: false,
    width: winWidth,
    height: winHeight,
    x: 80 + offset,
    y: 60 + offset,
    title: windowTitle,
    icon: profileIcon,
    backgroundColor: "#0c0f14",
    useContentSize: true,
    webPreferences: {
      session: sess,
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };
  if (isMobileProfile) {
    // Width is always locked to the emulated phone width (412px etc.)
    // Height locks only if the full phone height fits on this screen; otherwise
    // allow vertical resize so the user can drag to see the full page on small
    // laptop screens. Position at top of work area for max visible space.
    winOpts.maximizable = false;
    winOpts.fullscreenable = false;
    winOpts.minWidth = winWidth;
    winOpts.maxWidth = winWidth;
    if (mobileHeightCapped) {
      winOpts.resizable = true;
      winOpts.minHeight = 400;
    } else {
      winOpts.resizable = false;
      winOpts.minHeight = winHeight;
      winOpts.maxHeight = winHeight;
    }
    winOpts.y = Math.max(0, workArea.y);
  }
  const win = new BrowserWindow(winOpts);
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    try { win.setTitle(windowTitle); } catch (_) {}
  });
  win.setMenuBarVisibility(false);
  // Windows taskbar overlay: a small colored circle with the profile initials.
  // setOverlayIcon needs the image to be non-empty AFTER it's been delivered
  // to the OS — if the SVG rasterizer returns an empty image, fall back to a
  // raw RGBA buffer drawn pixel-by-pixel (a colored disk, no text).
  try {
    if (process.platform === "win32" && typeof win.setOverlayIcon === "function") {
      let overlay = createProfileOverlayIcon(profile);
      const empty = !overlay || overlay.isEmpty();
      logInfo(`setOverlayIcon: profile=${profile.name} svg-empty=${empty} sizeJSON=${empty ? "n/a" : JSON.stringify(overlay.getSize())}`);
      if (empty) overlay = createOverlayDiskFallback(profile);
      if (overlay && !overlay.isEmpty()) {
        win.once("ready-to-show", () => {
          try { win.setOverlayIcon(overlay, `${profile.name || "Profile"}`); } catch (_) {}
        });
        // Also set immediately in case the window is already visible
        try { win.setOverlayIcon(overlay, `${profile.name || "Profile"}`); } catch (_) {}
      } else {
        logError(`setOverlayIcon: both SVG and fallback empty for profile ${profile.name}`);
      }
    }
  } catch (err) { try { logError(`setOverlayIcon failed: ${err.stack || err}`); } catch (_) {} }
  try {
    if (typeof win.setAppDetails === "function") {
      win.setAppDetails({
        appId: `com.privacyshield.profile.${String(profile.id || "").replace(/[^a-zA-Z0-9.-]/g, "").slice(0, 48) || "profile"}`,
        relaunchDisplayName: `${meta.browserLabel || "Browser"} - ${profile.name || "Profile"}`
      });
    }
  } catch (_) {}

  // If the tab strip renderer crashes, save the session and destroy the window so
  // profileWindows is cleaned up and the user can click "Start" again immediately.
  // Wrap the whole handler so a throw here can't propagate as an uncaughtException
  // and kill the main process (which would close the entire app silently).
  win.webContents.on("render-process-gone", (_ev, details) => {
    try {
      const reason = (details && details.reason) || "unknown";
      const exitCode = (details && details.exitCode) != null ? details.exitCode : "?";
      logError(`Tab strip renderer gone reason=${reason} exitCode=${exitCode} profile=${profileId}`);
      const state = windowTabState.get(win.id);
      if (state && Array.isArray(state.tabs)) {
        const tabs = [];
        for (const t of state.tabs) {
          try {
            const wc = t && t.view && t.view.webContents;
            const url = wc && !wc.isDestroyed() ? wc.getURL() : (t && t.url) || "";
            if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
              tabs.push({ url, title: (t && t.title) || "" });
            }
          } catch (_) {}
        }
        if (tabs.length) {
          try { store.updateProfile(profileId, { session: { tabs, lastSaved: Date.now() } }); } catch (_) {}
        }
      }
    } catch (err) {
      try { logError(`render-process-gone handler threw: ${err.stack || err}`); } catch (_) {}
    }
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
  });

  // Init the tab state for this window
  windowTabState.set(win.id, {
    profileId,
    tabs: [],
    activeTabId: null,
    isMobileProfile,
    chromeHeight,
    bottomInset,
    mobileViewportWidth
  });

  profileWindows.set(profileId, win);
  sessionMgr.registerWindow(win.id, profileId);
  store.saveOpenProfiles([...profileWindows.keys()]);

  // ── VPN kill-switch registration ────────────────────────────────────────────
  // For vpn/direct profiles the browser rides the system-wide VPN. If that VPN
  // drops while browsing, the very next request would go out on the real ISP —
  // a hard deanonymization leak. Register this window with the watcher so it is
  // force-closed within seconds of the tunnel dropping. (proxy-mode profiles
  // exit through their own proxy, not the system VPN, so they're not watched.)
  if (networkMode === "vpn" || networkMode === "direct") {
    // Re-fetch so we pick up lastVpnNetwork just written by the launch lock.
    const freshProfile = store.getProfiles().find((p) => p.id === profileId) || profile;
    const anchor = profileAnchor(freshProfile);
    const anchorCountry = anchor && anchor.countryCode ? String(anchor.countryCode).toLowerCase() : "";
    profileNetworkMeta.set(profileId, {
      mode: networkMode,
      anchorCountry, // if empty, the watcher self-baselines from the first probe
      anchorLabel: anchor ? (anchor.city || anchor.country || String(anchor.countryCode || "").toUpperCase()) : "",
      profileName: profile.name || "Profile"
    });
    logError(`vpn kill-switch: now watching profile=${profileId} (${profile.name || "Profile"}) mode=${networkMode} anchorCountry=${anchorCountry || "(self-baseline)"}`);
    startVpnWatch();
  }

  const showProfileWindow = () => {
    if (win.isDestroyed()) return;
    try {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      win.moveTop();
    } catch (_) {}
  };

  // Open the first tab once the tab strip is loaded
  win.webContents.once("did-finish-load", () => {
    // Determine initial URL(s)
    const urls = [];
    if (customUrl) {
      urls.push(customUrl);
    } else if (profile.session && Array.isArray(profile.session.tabs) && profile.session.tabs.length) {
      for (const t of profile.session.tabs) {
        if (t.url && (t.url.startsWith("http://") || t.url.startsWith("https://"))) urls.push(t.url);
      }
    }
    if (!urls.length) urls.push(startPageUrl());
    for (const u of urls) addTab(win.id, u);
    showProfileWindow();
  });

  // Resize active tab view when window resizes, and re-apply viewport metrics
  // so the page reflows to the new size (otherwise the page keeps the original
  // viewport from when emulation was first applied).
  win.on("resize", () => {
    layoutActiveTab(win.id);
    const state = windowTabState.get(win.id);
    const active = state && state.tabs.find((t) => t.id === state.activeTabId);
    if (active && active.view && !active.view.webContents.isDestroyed()) {
      const profile = store.getProfiles().find((p) => p.id === state.profileId && !p.deletedAt);
      if (profile) applyTabEmulation(active.view.webContents, profile, win).catch(() => {});
    }
  });
  win.on("enter-full-screen", () => layoutActiveTab(win.id));
  win.on("leave-full-screen", () => layoutActiveTab(win.id));

  win.on("close", async () => {
    // Save URLs of all tabs as the session
    const state = windowTabState.get(win.id);
    if (state) {
      const tabs = state.tabs.map((t) => ({
        url: !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : "",
        title: !t.view.webContents.isDestroyed() ? t.view.webContents.getTitle() : ""
      })).filter((t) => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")));
      if (tabs.length) {
        store.updateProfile(profileId, { session: { tabs, lastSaved: Date.now() } });
      }
    }
  });

  win.on("closed", () => {
    // Clean up tab views + maps
    const state = windowTabState.get(win.id);
    if (state) {
      for (const t of state.tabs) {
        try { webContentsProfileMap.delete(t.view.webContents.id); } catch (_) {}
      }
      windowTabState.delete(win.id);
    }
    profileWindows.delete(profileId);
    profileNetworkMeta.delete(profileId);
    stopVpnWatchIfIdle();
    sessionMgr.unregisterWindow(win.id);
    store.saveOpenProfiles([...profileWindows.keys()]);
    notifyManagerWindows("WINDOWS_CHANGED");
  });

  // Capture the underlying failure reason if loadURL rejects — the rejected
  // promise only gives us "ERR_FAILED (-2)" which is not actionable.
  // Wrap the handlers themselves in try/catch so a logging mishap can't
  // bring down the main process.
  win.webContents.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    try {
      if (!isMainFrame) return;
      logError(`tab-strip did-fail-load code=${code} desc=${desc} url=${validatedURL}`);
    } catch (_) {}
  });
  win.webContents.on("console-message", (...args) => {
    try {
      // Electron 28+ changed signature from (e,level,msg,line,sourceId) to (e,details).
      // Handle both shapes so we don't crash on unexpected args.
      const a = args[1];
      let level, msg, line, sourceId;
      if (a && typeof a === "object" && "message" in a) {
        ({ level, message: msg, lineNumber: line, sourceId } = a);
      } else {
        [, level, msg, line, sourceId] = args;
      }
      logError(`tab-strip console L${level} ${sourceId || ""}:${line || ""} ${msg || ""}`);
    } catch (_) {}
  });

  try {
    await win.loadURL(TAB_STRIP_URL);
    showProfileWindow();
  } catch (err) {
    logError(`win.loadURL(${TAB_STRIP_URL}) rejected: ${err.stack || err}`);
    try { win.destroy(); } catch (_) {}
    return { ok: false, error: "Browser window failed to load: " + (err.message || err) };
  }

  notifyManagerWindows("WINDOWS_CHANGED");

  return { ok: true, windowId: win.id, tabCount: Math.max(1, windowTabState.get(win.id)?.tabs?.length || 0) };
}

// ── Tab management ───────────────────────────────────────────────────────────

function addTab(windowId, url) {
  const state = windowTabState.get(windowId);
  if (!state) return null;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return null;
  const profileId = state.profileId;
  const profile = store.getProfiles().find((p) => p.id === profileId && !p.deletedAt);
  const sess = sessionMgr.getSessionForProfile(profileId);

  const view = new WebContentsView({
    webPreferences: {
      session: sess,
      preload: FINGERPRINT_PRELOAD,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });
  sessionMgr.assertProfileSession(view.webContents.session, profileId);

  // ── Native WebRTC IP-leak guard ─────────────────────────────────────────────
  // Set at the Chromium layer, which a page cannot detect or bypass (the JS
  // RTCPeerConnection patch in the preload is only defense-in-depth on top of
  // this). WebRTC gathers ICE candidates over raw UDP, which normally ignores
  // the HTTP proxy and would expose the machine's REAL public IP via STUN — the
  // classic "proxy but WebRTC leaks your home IP" tell.
  //   • proxy mode  → disable_non_proxied_udp: no UDP may leave outside the
  //     proxy, so WebRTC can never reach the real IP.
  //   • vpn/direct  → default_public_interface_only: all traffic already rides
  //     the tunnel; we just stop Chromium enumerating extra local candidates.
  try {
    const _px = (profile && profile.proxy) || {};
    const _mode = _px.networkMode || (_px.enabled ? "proxy" : "direct");
    view.webContents.setWebRTCIPHandlingPolicy(
      _mode === "proxy" ? "disable_non_proxied_udp" : "default_public_interface_only"
    );
  } catch (err) {
    logError(`setWebRTCIPHandlingPolicy failed: ${err && (err.message || err)}`);
  }

  const tabId = "t_" + (nextTabId++);
  webContentsProfileMap.set(view.webContents.id, profileId);

  // Inject fingerprint spoof via CDP so it runs in every frame (incl. iframes)
  // BEFORE any page script. Preload still runs as a fallback in the top frame.
  // Fire-and-forget — failure is logged, browsing continues with preload-only spoofing.
  //
  // IMPORTANT (bot-detection): attaching the DevTools debugger is ITSELF a strong
  // automation signal. PerimeterX ("Press & Hold to confirm you are a human"),
  // Cloudflare Turnstile and reCAPTCHA all probe for an attached CDP session
  // (Runtime domain leaks, worker pause-on-start timing via waitForDebuggerOnStart,
  // etc.). A native browser on the same IP passes precisely because it has no
  // debugger footprint. So for STEALTH profiles — whose whole point is to pass
  // aggressive detection — we DON'T attach CDP at all: the top-frame preload spoof
  // is enough, and skipping CDP removes the biggest remaining "you are a bot" tell.
  // Full-spoof profiles keep CDP for iframe/worker coverage (farming/linkability).
  let skipHosts = [];
  try {
    const cfg = profile ? store.buildConfigFromProfile(profile) : null;
    if (cfg) skipHosts = Array.isArray(cfg._spoofSkipHosts) ? cfg._spoofSkipHosts.filter(Boolean) : [];
    if (cfg && cfg._stealth === true) {
      logError(`cdp-stealth skipped (stealth profile — no debugger footprint) profile=${cfg._profileId || "?"}`);
    } else if (cfg) {
      cdpStealth.attachStealth(view.webContents, cfg, logError).catch((err) => {
        logError(`cdp-stealth attachStealth threw: ${err && (err.message || err)}`);
      });
    }
  } catch (err) {
    logError(`cdp-stealth setup error: ${err && (err.message || err)}`);
  }

  // Per-site allowlist: a full-spoof profile keeps CDP for iframe/worker coverage,
  // but when it navigates to an allowlisted host (e.g. fiverr.com), the attached
  // debugger is the very thing PerimeterX "Press & Hold" detects. Detach it on the
  // way in so that host sees a near-native browser. The top-frame preload still
  // runs and already softens its own fingerprint for allowlisted hosts. We don't
  // re-attach on leaving (the injected-script id is gone) — a tab that has touched
  // an allowlisted host simply stays CDP-free, which is the safe direction.
  if (skipHosts.length) {
    const hostInSkip = (rawUrl) => {
      let host = "";
      try { host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch (_) { return false; }
      if (!host) return false;
      for (const raw of skipHosts) {
        const entry = String(raw || "").toLowerCase().trim().replace(/^\*?\.?/, "").replace(/^www\./, "");
        if (entry && (host === entry || host.endsWith("." + entry))) return true;
      }
      return false;
    };
    view.webContents.on("did-start-navigation", (_e, navUrl, _isInPlace, isMainFrame) => {
      if (!isMainFrame || !hostInSkip(navUrl)) return;
      try {
        if (view.webContents.debugger.isAttached()) {
          view.webContents.debugger.detach();
          logError(`cdp-stealth detached for allowlisted host: ${navUrl}`);
        }
      } catch (_) {}
    });
  }

  const tabEntry = { id: tabId, view, title: "New tab", url };
  state.tabs.push(tabEntry);

  // Reload tab strip on tab/page events
  const wc = view.webContents;
  wc.on("page-title-updated", (_e, title) => { tabEntry.title = title; emitTabState(windowId); });
  wc.on("did-navigate", (_e, navUrl) => { tabEntry.url = navUrl; emitTabState(windowId); });
  wc.on("did-navigate-in-page", (_e, navUrl) => { tabEntry.url = navUrl; emitTabState(windowId); });
  wc.on("did-start-loading", () => { tabEntry.loading = true; emitTabState(windowId); });
  wc.on("did-stop-loading", () => { tabEntry.loading = false; emitTabState(windowId); });
  wc.setWindowOpenHandler(({ url: u }) => { addTab(windowId, u); return { action: "deny" }; });

  // F12 / Ctrl+Shift+I — open DevTools for the active tab. Needed for
  // mobile-profile windows because the tab-strip's right-click menu doesn't
  // cover the WebContentsView area.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12") {
      event.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: "detach" });
    } else if (input.control && input.shift && (input.key === "I" || input.key === "i")) {
      event.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: "detach" });
    } else if (input.control && input.shift && (input.key === "C" || input.key === "c")) {
      event.preventDefault();
      if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: "detach" });
    }
  });

  // Right-click context menu with Inspect/Copy/Paste — the WebContentsView
  // has no menu by default, so users can't copy/paste/inspect on mobile.
  wc.on("context-menu", (_ev, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "back", enabled: wcCanGoBack(wc) },
      { role: "forward", enabled: wcCanGoForward(wc) },
      { role: "reload" },
      { type: "separator" },
      { role: "copy", enabled: Boolean(params.selectionText) },
      { role: "cut", enabled: params.isEditable && Boolean(params.selectionText) },
      { role: "paste", enabled: params.isEditable },
      { role: "selectAll" },
      { type: "separator" },
      { label: "Inspect Element", click: () => { try { wc.inspectElement(params.x, params.y); } catch (_) {} } }
    ]);
    try { menu.popup({ window: BrowserWindow.fromId(windowId) }); } catch (_) {}
  });

  wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return;
    if (validatedURL && (validatedURL.startsWith("file://") || validatedURL.startsWith("psapp://"))) return;
    logError(`tab did-fail-load profile=${profileId} code=${code} desc=${desc} url=${validatedURL}`);
    wc.loadURL(startPageUrl(desc || "Page failed to load", validatedURL || ""));
  });

  wc.on("did-fail-provisional-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return;
    if (validatedURL && (validatedURL.startsWith("file://") || validatedURL.startsWith("psapp://"))) return;
    logError(`tab did-fail-provisional-load profile=${profileId} code=${code} desc=${desc} url=${validatedURL}`);
    wc.loadURL(startPageUrl(desc || "Page failed to load", validatedURL || ""));
  });

  // If this tab's renderer crashes: clean it up, but if it was the only tab open
  // a recovery start-page tab instead of closing the whole window (which would make
  // it look like Start never worked). The recovery tab uses allowWindowClose:true so
  // a second consecutive crash will cleanly close the window.
  wc.on("render-process-gone", (_ev, details) => {
    logError(`Tab renderer gone (${details.reason}) for profile ${profileId}, tab ${tabId}`);
    closeTab(windowId, tabId, { crashRecovery: true });
  });

  win.contentView.addChildView(view);
  activateTab(windowId, tabId);

  // Load the URL immediately — do NOT wait for CDP emulation.
  // The fingerprint preload (runs before any page JS) covers JS-level spoofing.
  // CDP overrides are applied concurrently and take effect before page scripts run.
  if (!wc.isDestroyed()) wc.loadURL(url || startPageUrl());
  if (profile) applyTabEmulation(wc, profile, win).catch(logError);

  emitTabState(windowId);
  return tabId;
}

function activateTab(windowId, tabId) {
  const state = windowTabState.get(windowId);
  if (!state) return;
  state.activeTabId = tabId;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  // Hide all, then position active
  for (const t of state.tabs) {
    t.view.setVisible(t.id === tabId);
  }
  layoutActiveTab(windowId);
  emitTabState(windowId);
}

function layoutActiveTab(windowId) {
  const state = windowTabState.get(windowId);
  if (!state) return;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const chromeHeight = getWindowChromeHeight(windowId);
  const bottomInset = getWindowBottomInset(windowId);
  const viewWidth = state.isMobileProfile
    ? Math.min(w, Number(state.mobileViewportWidth) || w)
    : w;
  for (const t of state.tabs) {
    if (t.id === state.activeTabId) {
      t.view.setBounds({ x: 0, y: chromeHeight, width: viewWidth, height: Math.max(0, h - chromeHeight - bottomInset) });
    }
  }
}

function getWindowChromeHeight(windowId) {
  const state = windowTabState.get(windowId);
  return Number(state?.chromeHeight) || DESKTOP_CHROME_HEIGHT;
}

function getWindowBottomInset(windowId) {
  const state = windowTabState.get(windowId);
  return Math.max(0, Number(state?.bottomInset) || 0);
}

function closeTab(windowId, tabId, { crashRecovery = false } = {}) {
  const state = windowTabState.get(windowId);
  if (!state) return;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  try { webContentsProfileMap.delete(tab.view.webContents.id); } catch (_) {}
  try { win.contentView.removeChildView(tab.view); } catch (_) {}
  try { tab.view.webContents.close(); } catch (_) {}
  state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
    // Recovery is limited to 1 attempt per window. If the recovery tab also
    // crashes (= 2nd crash in this window), close the window rather than
    // looping forever — infinite addTab -> render-process-gone -> closeTab
    // recursion was crashing the whole app.
    state.crashCount = (state.crashCount || 0) + (crashRecovery ? 1 : 0);
    if (crashRecovery && state.crashCount <= 1) {
      addTab(windowId, startPageUrl("Browser tab crashed — recovered", ""));
    } else {
      win.close();
    }
    return;
  }
  // Activate adjacent tab if we closed the active one
  if (state.activeTabId === tabId) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    activateTab(windowId, next.id);
  } else {
    emitTabState(windowId);
  }
}

function getActiveTab(windowId) {
  const state = windowTabState.get(windowId);
  if (!state) return null;
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function wcCanGoBack(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === "function") return wc.navigationHistory.canGoBack();
    if (typeof wc.canGoBack === "function") return wc.canGoBack();
  } catch (_) {}
  return false;
}
function wcCanGoForward(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === "function") return wc.navigationHistory.canGoForward();
    if (typeof wc.canGoForward === "function") return wc.canGoForward();
  } catch (_) {}
  return false;
}

function emitTabState(windowId) {
  const state = windowTabState.get(windowId);
  if (!state) return;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  const tabs = state.tabs.map((t) => {
    const wc = t.view.webContents;
    const alive = !wc.isDestroyed();
    return {
      id: t.id,
      title: alive ? (wc.getTitle() || t.url || "New tab") : t.title,
      url: alive ? wc.getURL() : t.url,
      canBack: alive ? wcCanGoBack(wc) : false,
      canForward: alive ? wcCanGoForward(wc) : false,
      loading: alive ? wc.isLoadingMainFrame() : false
    };
  });
  try {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send("MAIN_EVENT", {
        type: "TAB_STATE",
        tabs,
        activeTabId: state.activeTabId,
        meta: getProfileBrowserMeta(state.profileId)
      });
    }
  } catch (err) {
    try { logError(`emitTabState send failed: ${err.stack || err}`); } catch (_) {}
  }
}

// ── Bulk profile generator ───────────────────────────────────────────────────
async function bulkCreateProfiles(count, countryCode, assignProxies, networkMode, deviceClass, browserApp) {
  const n = Math.max(1, Math.min(100, parseInt(count, 10) || 10));
  const COUNTRIES = ["us","gb","de","nl","fr","ca","au","jp","sg","br","in","ae","tr","se","ch","ng"];
  const created = [];
  const requestedMode = String(networkMode || "").toLowerCase();
  const mode = ["proxy", "vpn", "direct"].includes(requestedMode)
    ? requestedMode
    : (assignProxies ? "proxy" : "direct");
  const vpnNetwork = mode === "vpn" ? await captureCurrentNetwork() : null;
  const pending = [];
  const selectedProxyIds = new Set();

  for (let i = 0; i < n; i++) {
    const country = vpnNetwork?.countryCode || (countryCode === "random" || !countryCode
      ? COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)]
      : countryCode);
    const data = store.buildCountryProfileData(country, i + 1, { deviceClass: deviceClass || "desktop", browserApp: browserApp || "random" });
    let proxyMatch = null;

    if (mode === "vpn") {
      applyCapturedNetworkToProfileData(data, vpnNetwork);
    } else if (mode === "direct") {
      data.proxy = { ...(data.proxy || {}), networkMode: "direct", enabled: false };
    } else if (assignProxies || mode === "proxy") {
      proxyMatch = pickVpsPrivateProxy(country, selectedProxyIds) || pickVpsPrivateProxy("", selectedProxyIds);
      if (!proxyMatch) {
        throw new Error(`Not enough private VPS proxies for ${String(country).toUpperCase()}. Add one VPS/proxy per profile IP, or use VPN/direct mode.`);
      }
      selectedProxyIds.add(proxyMatch.id);
    }
    pending.push({ data, proxyMatch });
  }

  for (const item of pending) {
    if (item.proxyMatch) {
      const used = store.markProxyUsed(item.proxyMatch.id) || item.proxyMatch;
      item.data.proxy = {
        networkMode: "proxy",
        enabled: true,
        scheme: used.scheme || "socks5",
        host: used.host, port: used.port,
        username: used.username || "", password: used.password || "",
        bypassList: ["localhost", "127.0.0.1"]
      };
    }
  }
  // ONE read + ONE write + ONE batched cloud push instead of N of each.
  // Looping store.createProfile() here rewrote the whole (growing) file per
  // profile — O(n²) synchronous disk I/O that froze the UI on "generate 100".
  const batch = store.createProfilesBatch(pending.map((item) => item.data));
  created.push(...batch);
  return { ok: true, created: created.length, profiles: created };
}

function applyCapturedNetworkToProfileData(data, network) {
  const fp = data.fingerprint || {};
  const countryCode = String(network.countryCode || fp.countryCode || "").toLowerCase();
  data.fingerprint = {
    ...fp,
    timezone: "manual",
    timezoneValue: network.timezone || fp.timezoneValue || "UTC",
    timezoneOffset: timezoneOffsetMinutes(network.timezone || fp.timezoneValue || "UTC"),
    language: "manual",
    languageValue: languageForCountry(countryCode) || fp.languageValue || "en-US",
    geolocation: "manual",
    geoLat: Number(network.latitude) || fp.geoLat || 0,
    geoLng: Number(network.longitude) || fp.geoLng || 0,
    geoAccuracy: 50,
    city: network.city || fp.city || "",
    state: network.state || fp.state || "",
    ispName: network.ispName || fp.ispName || "",
    ispAsn: network.ispAsn || fp.ispAsn || "",
    ispOrg: network.ispOrg || fp.ispOrg || "",
    organization: network.organization || network.ispOrg || fp.organization || "",
    ip: network.ip || fp.ip || "",
    countryCode,
    country: network.country || fp.country || "",
    continent: network.continent || fp.continent || ""
  };
  data.proxy = { ...(data.proxy || {}), networkMode: "vpn", enabled: false };
}

function languageForCountry(countryCode) {
  const map = {
    us: "en-US", gb: "en-GB", ca: "en-CA", au: "en-AU", de: "de-DE", nl: "nl-NL",
    fr: "fr-FR", ch: "de-CH", se: "sv-SE", jp: "ja-JP", sg: "en-SG", br: "pt-BR",
    in: "en-IN", ae: "ar-AE", ru: "ru-RU", tr: "tr-TR", ng: "en-NG"
  };
  return map[String(countryCode || "").toLowerCase()] || "";
}

function timezoneOffsetMinutes(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset"
    }).formatToParts(new Date());
    const zoneName = parts.find((part) => part.type === "timeZoneName")?.value || "";
    if (zoneName === "GMT" || zoneName === "UTC") return 0;
    const match = zoneName.match(/(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!match) return 0;
    const total = Number(match[2]) * 60 + Number(match[3] || 0);
    return match[1] === "+" ? -total : total;
  } catch (_) {
    return 0;
  }
}

function pickVpsPrivateProxy(country, excludedIds = new Set()) {
  const wanted = String(country || "").toLowerCase();
  const candidates = store.getProxyLibrary()
    .filter((entry) => entry && entry.host && entry.port)
    .filter((entry) => !excludedIds.has(entry.id))
    .filter((entry) => entry.private !== false && entry.source === "vps")
    .filter((entry) => !wanted || entry.country === wanted || entry.country === "")
    .sort((a, b) => {
      const uses = Number(a.useCount || 0) - Number(b.useCount || 0);
      if (uses !== 0) return uses;
      return Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0);
    });
  return candidates[0] || null;
}

async function saveWindowSession(profileId, win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const state = windowTabState.get(win.id);
    if (!state) return 0;
    const tabs = state.tabs.map((t) => {
      const wc = t.view.webContents;
      if (wc.isDestroyed()) return null;
      const url = wc.getURL();
      if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) return null;
      return { url, title: wc.getTitle(), active: t.id === state.activeTabId };
    }).filter(Boolean);
    if (!tabs.length) return 0;
    store.updateProfile(profileId, { session: { tabs, lastSaved: Date.now() } });
    return tabs.length;
  } catch (_) { return 0; }
}

function notifyManagerWindows(type, payload) {
  // Broadcast to manager windows, not profile browser or provider console windows.
  const profileWinIds = new Set([
    ...[...profileWindows.values()].map((w) => w.id),
    ...[...cloudPhoneWindows.values()].map((w) => w.id)
  ]);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!profileWinIds.has(win.id) && !win.isDestroyed()) {
      try {
        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send("MAIN_EVENT", payload ? { type, ...payload } : { type });
        }
      } catch (_) {}
    }
  }
}

function isPrivateProviderHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.startsWith("127.")) return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  const m = h.match(/^172\.(\d{1,2})\./);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function validateProviderEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || ""));
  } catch (_) {
    throw new Error("Private provider URL is invalid");
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isPrivateProviderHost(url.hostname)) return url.toString();
  throw new Error("Private provider must use HTTPS, or HTTP on localhost/private LAN");
}

function normalizeGeneratedProxy(raw, country) {
  const data = raw && raw.proxy ? raw.proxy : raw;
  if (!data || typeof data !== "object") throw new Error("Provider returned no proxy");
  if (data.public === true || data.source === "public") throw new Error("Provider returned a public proxy; refused");

  const host = String(data.host || data.ip || data.server || "").trim();
  const port = Number(data.port || data.socks5_port || data.proxy_port || 0);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Provider returned an invalid host or port");
  }

  const scheme = ["socks5", "socks4", "http", "https"].includes(data.scheme) ? data.scheme : "socks5";
  const labelCountry = country ? country.toUpperCase() : "Private";

  return {
    label: String(data.label || `Private ${labelCountry} proxy`),
    country: String(data.country || country || "").toLowerCase(),
    scheme,
    host,
    port,
    username: String(data.username || data.user || ""),
    password: String(data.password || data.pass || ""),
    rotationUrl: String(data.rotationUrl || data.rotation_url || ""),
    ispName: String(data.ispName || data.isp || data.provider || ""),
    ispAsn: String(data.ispAsn || data.asn || ""),
    ispOrg: String(data.ispOrg || data.org || data.organization || ""),
    city: String(data.city || ""),
    private: true,
    source: "private-provider",
    providerId: data.id || data.proxyId || data.proxy_id || "",
    createdAt: Date.now()
  };
}

function requestPrivateProxyFromProvider(config, country, profileId) {
  const endpoint = validateProviderEndpoint(config.endpoint);
  const body = JSON.stringify({
    country,
    profileId: profileId || "",
    privateOnly: true,
    protocol: "socks5"
  });

  return new Promise((resolve, reject) => {
    const req = net.request({ method: "POST", url: endpoint });
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Accept", "application/json");
    if (config.token && config.authMode === "bearer") {
      req.setHeader("Authorization", `Bearer ${config.token}`);
    } else if (config.token && config.authMode === "x-api-key") {
      req.setHeader("X-API-Key", config.token);
    }

    let responseBody = "";
    req.on("response", (res) => {
      res.on("data", (chunk) => { responseBody += chunk.toString(); });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Private provider HTTP ${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(responseBody);
          resolve(normalizeGeneratedProxy(parsed, country));
        } catch (err) {
          reject(new Error(err.message || "Provider returned invalid JSON"));
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(String(err.message || err)));
    });
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      reject(new Error("Private provider timed out"));
    }, 15000);
    req.write(body);
    req.end();
  });
}

function expandProxyTestUsername(username) {
  return String(username || "").replace(/\{\{\s*profile(?:_id|_name)?\s*\}\}/gi, "test-session");
}

async function configureTempProxySession(tempSess, bridgeId, { host, port, scheme, username, password } = {}) {
  const normalizedScheme = String(scheme || "socks5").toLowerCase();
  const numericPort = parseInt(port, 10);
  if (!host || !numericPort) throw new Error("missing host or port");

  if ((normalizedScheme === "http" || normalizedScheme === "https") && (username || password)) {
    const local = await proxyBridge.getBridge(bridgeId, {
      scheme: normalizedScheme,
      host,
      port: numericPort,
      username,
      password
    });
    if (local) {
      await tempSess.setProxy({ proxyRules: `http://127.0.0.1:${local.port}` });
      return () => proxyBridge.stopBridge(bridgeId);
    }
  }

  await tempSess.setProxy({ proxyRules: `${normalizedScheme}://${host}:${numericPort}` });
  return () => {};
}

// Detect the real exit location of a proxy by routing an IP-geo lookup THROUGH
// it. `username` should already have any {{profile}} placeholders expanded so the
// sticky session ID matches the one the browser will use — otherwise a rotating
// provider could hand back a different exit IP than the profile actually runs on.
// Returns a normalized network capture (ip/country/timezone/lat/lng/…) or null.
async function detectProxyGeo({ host, port, scheme, username, password } = {}) {
  if (!host || !port) return null;
  const { session: electronSession } = require("electron");
  const partitionId = "proxy-geo-launch-" + Date.now();
  const tempSess = electronSession.fromPartition(partitionId, { cache: false });
  let cleanupProxy = () => {};
  try {
    cleanupProxy = await configureTempProxySession(tempSess, partitionId, { host, port, scheme, username, password });
  } catch (_) {
    return null;
  }
  const GEO_URLS = [
    "http://ip-api.com/json/?fields=status,message,continent,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query",
    "https://ipwho.is/",
    "https://ipapi.co/json/"
  ];
  try {
    for (const geoUrl of GEO_URLS) {
      const result = await fetchJsonViaProxy(geoUrl, tempSess, username, password);
      if (result.ok && result.data) {
        const n = normalizeNetworkCapture(result.data);
        if (n.ip) {
          n.proxyType = detectProxyType(n.ispName, n.ispAsn, n.organization);
          return n;
        }
      }
      if (result.fatal) break;
    }
  } finally {
    cleanupProxy();
  }
  return null;
}

async function testProxy(host, port, scheme, username, password) {
  if (!host || !port) return { ok: false, error: "missing host or port" };

  const { session: electronSession } = require("electron");
  const partitionId = "proxy-test-" + Date.now();
  const tempSess = electronSession.fromPartition(partitionId, { cache: false });

  const cleanupProxy = await configureTempProxySession(tempSess, partitionId, { host, port, scheme, username, password });

  // Test HTTPS first because browser failures happen on CONNECT tunnels.
  const TEST_URLS = [
    "https://api.ipify.org/?format=json",
    "https://ipwho.is/",
    "http://checkip.amazonaws.com/"
  ];

  let lastError = "";
  try {
    for (const testUrl of TEST_URLS) {
      const result = await tryTestUrl(testUrl, tempSess, username, password);
      if (result.ok) return result;
      lastError = result.error || lastError;
      if (result.fatal) break;
    }
  } finally {
    cleanupProxy();
  }
  // Return the specific error from the test attempts instead of a generic message
  return { ok: false, error: lastError || "Proxy unreachable — check host, port, and credentials" };
}

function fetchJsonViaProxy(url, session, username, password) {
  return new Promise((resolve) => {
    const req = net.request({ url, session, useSessionCookies: false });
    let authChallenged = false;
    req.on("login", (authInfo, callback) => {
      if (authInfo.isProxy) { authChallenged = true; callback(username || "", password || ""); }
      else callback("", "");
    });
    let body = "";
    req.on("response", (res) => {
      clearTimeout(timer);
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        if ((res.statusCode || 0) >= 400) {
          resolve({ ok: false, error: `Geo lookup HTTP ${res.statusCode}: ${body.trim().slice(0, 160)}`, fatal: res.statusCode === 401 || res.statusCode === 407 });
          return;
        }
        try { resolve({ ok: true, data: JSON.parse(body.trim()) }); }
        catch (_) { resolve({ ok: false, error: "Invalid JSON from geo API" }); }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err), fatal: String(err.message).includes("not supported") });
    });
    const timer = setTimeout(() => { try { req.abort(); } catch (_) {} resolve({ ok: false, error: "Geo lookup timed out" }); }, 12000);
    req.end();
  });
}

const _DC_RE = /hostin|server|cloud|vps|digitalocean|vultr|linode|hetzner|ovh|amazon|google|microsoft|azure|cloudflare|fastly|akamai|leaseweb|psychz|quadranet|coloc|colocation|datacenter|data\s?ctr|idc\b|teraserver|wholesale|dedicated/i;
const _MOBILE_RE = /mobile|4g|lte|5g|gsm|cellular|wireless/i;
const _RESI_RE = /comcast|xfinity|verizon|at&t|att\b|t-mobile|sprint|cox|charter|spectrum|rogers|bell\s|telus|vodafone|o2\b|\bee\b|orange\b|telecom|telefonica|telstra|optus|singtel|airtel|jio\b|bsnl|reliance|mtn\b|safaricom|etisalat|zain\b|celcom|indosat/i;
function detectProxyType(ispName, ispAsn, org) {
  const t = `${ispName || ""} ${org || ""}`;
  if (_MOBILE_RE.test(t)) return "mobile";
  if (_RESI_RE.test(t)) return "residential";
  if (_DC_RE.test(t)) return "datacenter";
  return "unknown";
}

const _TZ_COUNTRY = {
  "America/New_York":"us","America/Chicago":"us","America/Denver":"us","America/Los_Angeles":"us",
  "America/Phoenix":"us","America/Anchorage":"us","America/Honolulu":"us","America/Detroit":"us",
  "America/Indiana/Indianapolis":"us","America/Puerto_Rico":"us","Pacific/Honolulu":"us",
  "America/Toronto":"ca","America/Vancouver":"ca","America/Montreal":"ca","America/Edmonton":"ca",
  "America/Winnipeg":"ca","America/Halifax":"ca",
  "America/Sao_Paulo":"br","America/Manaus":"br","America/Fortaleza":"br","America/Recife":"br",
  "America/Argentina/Buenos_Aires":"ar","America/Buenos_Aires":"ar",
  "America/Mexico_City":"mx","America/Monterrey":"mx","America/Tijuana":"mx",
  "America/Bogota":"co","America/Lima":"pe","America/Santiago":"cl","America/Caracas":"ve",
  "Europe/London":"gb","Europe/Berlin":"de","Europe/Paris":"fr","Europe/Amsterdam":"nl",
  "Europe/Zurich":"ch","Europe/Vienna":"at","Europe/Brussels":"be","Europe/Madrid":"es",
  "Europe/Lisbon":"pt","Europe/Rome":"it","Europe/Stockholm":"se","Europe/Oslo":"no",
  "Europe/Copenhagen":"dk","Europe/Helsinki":"fi","Europe/Warsaw":"pl","Europe/Prague":"cz",
  "Europe/Budapest":"hu","Europe/Bucharest":"ro","Europe/Athens":"gr","Europe/Istanbul":"tr",
  "Europe/Moscow":"ru","Europe/Kiev":"ua","Europe/Kyiv":"ua","Europe/Minsk":"by",
  "Europe/Riga":"lv","Europe/Tallinn":"ee","Europe/Vilnius":"lt","Europe/Dublin":"ie",
  "Europe/Sofia":"bg","Europe/Bratislava":"sk","Europe/Ljubljana":"si","Europe/Zagreb":"hr",
  "Europe/Belgrade":"rs","Europe/Tirane":"al","Europe/Luxembourg":"lu","Europe/Malta":"mt",
  "Asia/Tokyo":"jp","Asia/Seoul":"kr","Asia/Shanghai":"cn","Asia/Chongqing":"cn",
  "Asia/Harbin":"cn","Asia/Urumqi":"cn","Asia/Hong_Kong":"hk","Asia/Taipei":"tw",
  "Asia/Singapore":"sg","Asia/Bangkok":"th","Asia/Jakarta":"id","Asia/Manila":"ph",
  "Asia/Kuala_Lumpur":"my","Asia/Ho_Chi_Minh":"vn","Asia/Yangon":"mm","Asia/Dhaka":"bd",
  "Asia/Karachi":"pk","Asia/Kolkata":"in","Asia/Colombo":"lk","Asia/Kathmandu":"np",
  "Asia/Kabul":"af","Asia/Tehran":"ir","Asia/Baghdad":"iq","Asia/Riyadh":"sa",
  "Asia/Dubai":"ae","Asia/Kuwait":"kw","Asia/Doha":"qa","Asia/Muscat":"om",
  "Asia/Beirut":"lb","Asia/Jerusalem":"il","Asia/Amman":"jo","Asia/Damascus":"sy",
  "Asia/Tashkent":"uz","Asia/Almaty":"kz","Asia/Baku":"az","Asia/Tbilisi":"ge",
  "Asia/Yerevan":"am","Asia/Ulaanbaatar":"mn",
  "Africa/Cairo":"eg","Africa/Casablanca":"ma","Africa/Algiers":"dz","Africa/Tunis":"tn",
  "Africa/Tripoli":"ly","Africa/Lagos":"ng","Africa/Nairobi":"ke","Africa/Johannesburg":"za",
  "Africa/Harare":"zw","Africa/Accra":"gh","Africa/Abidjan":"ci","Africa/Addis_Ababa":"et",
  "Africa/Kampala":"ug","Africa/Dar_es_Salaam":"tz","Africa/Khartoum":"sd",
  "Pacific/Auckland":"nz","Pacific/Fiji":"fj","Pacific/Guam":"gu","Pacific/Port_Moresby":"pg",
  "Australia/Sydney":"au","Australia/Melbourne":"au","Australia/Brisbane":"au",
  "Australia/Perth":"au","Australia/Adelaide":"au","Australia/Darwin":"au",
  "Atlantic/Reykjavik":"is","Indian/Mauritius":"mu","Indian/Maldives":"mv"
};
function guessCountryFromTimezone(tz) {
  return _TZ_COUNTRY[tz] || null;
}

// Two network captures count as the "same location" when they share a country
// and (if both report it) the same city/region. VPN exit IPs rotate within a
// city, so we deliberately compare location, not the raw IP — the goal is to
// keep one account anchored to one place, not one fixed address.
function locationsMatch(a, b) {
  if (!a || !b) return false;
  const cc = (x) => String(x.countryCode || "").trim().toLowerCase();
  const norm = (x) => String(x || "").trim().toLowerCase();
  if (cc(a) !== cc(b)) return false;
  if (norm(a.city) && norm(b.city)) return norm(a.city) === norm(b.city);
  if (norm(a.state) && norm(b.state)) return norm(a.state) === norm(b.state);
  return true; // same country, no finer signal available → treat as same place
}

// The location a profile is EXPECTED to run on. The location the user captured
// for the profile (proxy.detected* — set by "Capture current VPN/IP" or country
// setup) is authoritative because the user explicitly chose it. Only when no
// capture exists do we fall back to the last launched location.
function profileAnchor(profile) {
  const px = (profile && profile.proxy) || {};
  if (px.detectedCountryCode) {
    return {
      ip: px.detectedIp || "",
      country: px.detectedCountry || "",
      countryCode: px.detectedCountryCode || "",
      city: px.detectedCity || "",
      state: px.detectedState || "",
      capturedAt: px.detectedAt || null,
      isVpn: px.proxyType === "vpn" || px.proxyType === "datacenter",
      source: "captured"
    };
  }
  if (profile && profile.lastVpnNetwork && profile.lastVpnNetwork.countryCode) {
    return { ...profile.lastVpnNetwork, source: "lastLaunch" };
  }
  return null;
}

// Classify a captured connection. Prefer the geo provider's own hosting/proxy/
// mobile flags (ip-api supplies these on the free tier) and fall back to the
// ISP-name regex. This is what tells us whether a VPN is actually on.
function classifyConnection(n) {
  if (!n) return "unknown";
  if (n.isHosting || n.isProxy) return "datacenter";
  if (n.isMobile) return "mobile";
  return detectProxyType(n.ispName, n.ispAsn, n.organization);
}

// ── VPN kill-switch watcher ───────────────────────────────────────────────────
// While any vpn/direct profile window is open we watch the system network. If
// the VPN drops — the tunnel adapter vanishes, the exit flips to the real ISP,
// or the internet goes dark — we force-close the affected profile windows within
// seconds so no request escapes on the naked connection. The user reopens the
// profile once the VPN is back (the launch-time location lock re-verifies).
let vpnWatchTimer = null;
let vpnWatchBaselineSig = null;
let vpnWatchFailStreak = 0;
let vpnWatchBusy = false;
let vpnWatchTickCount = 0;

const VPN_WATCH_TICK_MS = 2500;      // interface poll cadence — the fast trigger
const VPN_WATCH_CAPTURE_EVERY = 2;   // full IP capture every N ticks (~5s heartbeat)
const VPN_WATCH_FAIL_LIMIT = 2;      // consecutive lookup failures = connection down

function ifaceSignature() {
  // Stable string of the machine's non-internal IP addresses. A VPN tunnel
  // adapter appearing/disappearing changes this within ~1s of the event.
  try {
    const ifs = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (!a.internal && a.address) addrs.push(name + "|" + a.address);
      }
    }
    return addrs.sort().join(",");
  } catch (_) { return ""; }
}

function watchedProfileIds() {
  // A profile is live if it has a Chromium window OR a running Stealth (Camoufox)
  // instance — both must be guarded by the kill-switch.
  return [...profileNetworkMeta.keys()].filter((id) => profileWindows.has(id) || camoufox.isProfileRunning(id));
}

function startVpnWatch() {
  if (vpnWatchTimer) return;
  vpnWatchBaselineSig = ifaceSignature();
  vpnWatchFailStreak = 0;
  vpnWatchTickCount = 0;
  vpnWatchTimer = setInterval(runVpnWatchTick, VPN_WATCH_TICK_MS);
  if (vpnWatchTimer.unref) vpnWatchTimer.unref();
}

function stopVpnWatchIfIdle() {
  if (watchedProfileIds().length === 0 && vpnWatchTimer) {
    clearInterval(vpnWatchTimer);
    vpnWatchTimer = null;
    vpnWatchBaselineSig = null;
  }
}

async function runVpnWatchTick() {
  if (vpnWatchBusy) return;
  const ids = watchedProfileIds();
  if (ids.length === 0) { stopVpnWatchIfIdle(); return; }
  vpnWatchBusy = true;
  try {
    vpnWatchTickCount++;
    const sig = ifaceSignature();
    const ifaceChanged = sig !== vpnWatchBaselineSig;
    const periodic = vpnWatchTickCount % VPN_WATCH_CAPTURE_EVERY === 0;
    // Only spend an IP lookup when the interfaces changed or on the heartbeat.
    if (!ifaceChanged && !periodic) return;
    if (ifaceChanged) logError(`vpn kill-switch: network interfaces changed — verifying exit IP`);

    let current = null;
    try {
      current = await captureCurrentNetwork();
      vpnWatchFailStreak = 0;
    } catch (err) {
      vpnWatchFailStreak++;
      logError(`vpn kill-switch: exit-IP probe FAILED ${vpnWatchFailStreak}/${VPN_WATCH_FAIL_LIMIT} — ${err && (err.message || err)}`);
      // No network reachable = VPN killswitch cut everything, or link is down.
      // Close so nothing resumes on a naked connection when it comes back.
      if (vpnWatchFailStreak >= VPN_WATCH_FAIL_LIMIT) {
        killWatchedProfiles(ids, "Your internet/VPN connection dropped — no network is reachable. Profile closed to prevent a leak. Reconnect your VPN and start it again.");
        vpnWatchFailStreak = 0;
      }
      return;
    }

    // Network reachable again → adopt the new interface signature as baseline so
    // we don't re-trigger on the same change every tick.
    vpnWatchBaselineSig = sig;

    const cc = String(current.countryCode || "").toLowerCase();
    const type = classifyConnection(current);
    logError(`vpn kill-switch: exit OK country=${cc || "?"} type=${type} ip=${current.ip || "?"} watching=${ids.length}`);
    if (!cc) return; // couldn't determine country this round — wait for a clean probe

    for (const id of ids) {
      const meta = profileNetworkMeta.get(id);
      if (!meta) continue;
      // Self-baseline: if we never had an anchor country, adopt the first good
      // probe as the profile's expected exit country.
      if (!meta.anchorCountry) {
        meta.anchorCountry = cc;
        meta.anchorLabel = current.country || cc.toUpperCase();
        logError(`vpn kill-switch: baselined profile=${id} to country=${cc}`);
        continue;
      }
      // Exit country changed = the VPN dropped to your real ISP or switched
      // region. This is the reliable trigger (providers agree on country even
      // when they disagree on city), and it fires regardless of whether the VPN
      // classifies as datacenter/vpn/unknown.
      if (cc !== meta.anchorCountry) {
        killWatchedProfiles([id], `VPN changed or dropped — your connection is now exiting in ${current.country || cc.toUpperCase()} (this profile expects ${meta.anchorLabel || meta.anchorCountry.toUpperCase()}). Profile closed to stop an IP leak. Reconnect the VPN and start it again.`);
      }
    }
  } finally {
    vpnWatchBusy = false;
  }
}

function killWatchedProfiles(ids, reason) {
  for (const id of ids) {
    if (!profileNetworkMeta.has(id)) continue;
    const meta = profileNetworkMeta.get(id);
    const name = (meta && meta.profileName) || "Profile";
    const win = profileWindows.get(id);
    logError(`vpn kill-switch: closing profile=${id} (${name}) reason=${reason}`);
    profileNetworkMeta.delete(id);
    if (win && !win.isDestroyed()) {
      try { win.close(); } catch (_) {}
    }
    // Also close the Stealth (Camoufox) window for this profile — otherwise a
    // VPN-bound Firefox keeps browsing on the naked real IP after the VPN drops.
    if ((meta && meta.camoufox) || camoufox.isProfileRunning(id)) {
      try { camoufox.closeProfile(id); } catch (_) {}
    }
    notifyManagerWindows("VPN_DROPPED", { profileId: id, profileName: name, reason });
  }
  stopVpnWatchIfIdle();
}

async function captureCurrentNetwork() {
  // ip-api FIRST: its free tier returns proxy/hosting/mobile flags, which is the
  // most reliable "is a VPN on" signal. ipwho.is / ipapi.co are geo-only fallbacks.
  const urls = [
    "http://ip-api.com/json/?fields=status,message,continent,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query",
    "https://ipwho.is/",
    "https://ipapi.co/json/"
  ];
  let lastError = "";
  for (const url of urls) {
    const result = await fetchJsonDirect(url);
    if (!result.ok) {
      lastError = result.error || lastError;
      continue;
    }
    const normalized = normalizeNetworkCapture(result.data || {});
    if (normalized.ip) return normalized;
    lastError = "IP lookup returned no IP";
  }
  throw new Error(lastError || "Could not capture current VPN/IP location");
}

function fetchJsonDirect(url) {
  return new Promise((resolve) => {
    const req = net.request({ url, useSessionCookies: false });
    let body = "";
    req.on("response", (res) => {
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `IP lookup HTTP ${res.statusCode}` });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (_) {
          resolve({ ok: false, error: "IP lookup returned invalid JSON" });
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err) });
    });
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      resolve({ ok: false, error: "IP lookup timed out" });
    }, 9000);
    req.end();
  });
}

function normalizeNetworkCapture(data) {
  const connection = data.connection || {};
  const timezone = typeof data.timezone === "object" ? data.timezone : { id: data.timezone };
  const asText = String(data.as || "");
  const asnFromText = (asText.match(/AS?(\d+)/i) || [])[1] || "";
  return {
    ip: String(data.ip || data.query || ""),
    country: String(data.country || data.country_name || ""),
    countryCode: String(data.country_code || data.countryCode || "").toLowerCase(),
    continent: String(data.continent || data.continent_code || ""),
    city: String(data.city || ""),
    state: String(data.region || data.regionName || ""),
    latitude: Number(data.latitude ?? data.lat ?? 0),
    longitude: Number(data.longitude ?? data.lon ?? 0),
    timezone: String(timezone.id || timezone || ""),
    ispName: String(connection.isp || data.isp || data.org || ""),
    ispAsn: String(connection.asn || data.asn || asnFromText || ""),
    ispOrg: String(connection.org || data.org || data.isp || ""),
    organization: String(connection.org || data.org || data.isp || ""),
    // ip-api free tier supplies these booleans; other providers omit them.
    isHosting: Boolean(data.hosting),
    isProxy: Boolean(data.proxy),
    isMobile: Boolean(data.mobile)
  };
}

function tryTestUrl(url, session, username, password) {
  return new Promise((resolve) => {
    const req = net.request({ url, session, useSessionCookies: false });

    // For net.request (main process), proxy auth fires on the request — NOT on session.
    // Always install the handler — if the proxy demands auth but no credentials were
    // given, surface a clear "auth required" message instead of a generic timeout.
    let authChallenged = false;
    req.on("login", (authInfo, callback) => {
      if (authInfo.isProxy) {
        authChallenged = true;
        if (username || password) callback(username || "", password || "");
        else callback();   // no credentials → abort with auth-required error
      } else {
        callback("", "");
      }
    });

    let body = "";
    req.on("response", (res) => {
      clearTimeout(timer);
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        try {
          const text = body.trim();
          if ((res.statusCode || 0) >= 400) {
            let error = `HTTP ${res.statusCode}: ${text.slice(0, 160)}`;
            if (res.statusCode === 422 || /Unprocessable Entity/i.test(text)) {
              error = "Proxy rejected the tunnel (422 Unprocessable Entity). Check the SOAX package, username/session/location filters, and password.";
            } else if (/Bridge upstream failed/i.test(text)) {
              error = text.slice(0, 220);
            }
            resolve({ ok: false, error, fatal: res.statusCode === 401 || res.statusCode === 407 || res.statusCode === 422 });
            return;
          }
          // ip-only response (checkip.amazonaws.com returns plain text)
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
            resolve({ ok: true, ip: text });
            return;
          }
          const json = JSON.parse(text);
          const ip = json.ip || json.origin || json.query;
          if (ip) resolve({ ok: true, ip });
          else resolve({ ok: false, error: "No IP in response" });
        } catch (_) {
          resolve({ ok: false, error: "Bad response" });
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      let msg = String(err.message || err);
      // Replace cryptic Chromium codes with plain-English messages
      if (authChallenged && !username && !password) {
        msg = "Proxy requires username and password — fill them in";
      } else if (msg.includes("ERR_PROXY_AUTH") || msg.includes("ERR_TUNNEL_CONNECTION_FAILED")) {
        msg = "Proxy auth failed — wrong username or password";
      } else if (msg.includes("ERR_NO_SUPPORTED_PROXIES")) {
        msg = "Proxy type not supported — try HTTP or SOCKS5";
      } else if (msg.includes("ERR_PROXY_CONNECTION_FAILED") || msg.includes("ERR_CONNECTION_REFUSED")) {
        msg = "Cannot reach proxy — host or port is wrong";
      } else if (msg.includes("ERR_TIMED_OUT")) {
        msg = "Proxy timed out — server is down or blocked";
      }
      const fatal = msg.includes("not supported") || msg.includes("Cannot reach");
      resolve({ ok: false, error: msg, fatal });
    });
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      const msg = authChallenged && !username && !password
        ? "Proxy requires username and password — fill them in"
        : "Timed out — proxy is slow or unreachable";
      resolve({ ok: false, error: msg });
    }, 10000);
    req.end();
  });
}

module.exports = { registerIpcHandlers, openProfileWindow, detectProxyGeo, captureCurrentNetwork, classifyConnection };
