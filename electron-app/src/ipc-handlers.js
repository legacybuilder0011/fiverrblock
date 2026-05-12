"use strict";

const { ipcMain, BrowserWindow, net } = require("electron");
const path = require("path");
const store = require("./profile-store");
const sessionMgr = require("./session-manager");
const authStore = require("./auth-store");

const FINGERPRINT_PRELOAD = path.join(__dirname, "preload-fingerprint.js");
const RENDERER_PRELOAD = path.join(__dirname, "renderer-preload.js");

// profileId → BrowserWindow reference for profile browser windows
const profileWindows = new Map();

// Sync handler so the fingerprint preload can get the profile config for its window
ipcMain.on("GET_PROFILE_CONFIG", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) { event.returnValue = null; return; }
  const profileId = sessionMgr.getProfileForWindow(win.id);
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

  ipcMain.handle("PROFILE_UPDATE", async (_ev, { id, data = {} } = {}) => {
    const profile = store.updateProfile(id, data);
    if (profile && profileWindows.has(id)) {
      // If the profile's browser window is open, update its session config
      const sess = sessionMgr.getSessionForProfile(id);
      await sessionMgr.setupProfileSession(profile);
    }
    return { ok: Boolean(profile), profile };
  });

  ipcMain.handle("PROFILE_DELETE", async (_ev, { id, hard = false } = {}) => {
    store.deleteProfile(id, hard);
    return { ok: true };
  });

  ipcMain.handle("PROFILE_RESTORE", async (_ev, { id } = {}) => {
    const profile = store.restoreProfile(id);
    return { ok: Boolean(profile), profile };
  });

  ipcMain.handle("PROFILE_DUPLICATE", async (_ev, { id } = {}) => {
    const profile = store.duplicateProfile(id);
    return { ok: Boolean(profile), profile };
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

  // ── Window management ─────────────────────────────────────────────────────────

  ipcMain.handle("PROFILE_OPEN_WINDOW", async (_ev, { profileId } = {}) => {
    return openProfileWindow(profileId);
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

  ipcMain.handle("PROFILE_GET_WINDOWS", async () => {
    return { ok: true, windows: sessionMgr.getAllProfileWindows() };
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

  // ── Proxy test ────────────────────────────────────────────────────────────────

  ipcMain.handle("TEST_PROXY", async (_ev, { host, port, scheme, username, password } = {}) => {
    return testProxy(host, port, scheme, username, password);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────

  ipcMain.handle("AUTH_SESSION", async () => {
    const session = authStore.getSession();
    return { ok: true, session };
  });

  ipcMain.handle("AUTH_REGISTER", async (_ev, { email, password } = {}) => {
    const result = authStore.register(email, password);
    return result;
  });

  ipcMain.handle("AUTH_LOGIN", async (_ev, { email, password } = {}) => {
    const result = authStore.login(email, password);
    return result;
  });

  ipcMain.handle("AUTH_LOGOUT", async () => {
    authStore.logout();
    return { ok: true };
  });
}

// ── Profile window management ──────────────────────────────────────────────────

async function openProfileWindow(profileId) {
  // If already open, focus it
  const existing = profileWindows.get(profileId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true, windowId: existing.id, existing: true };
  }

  const profiles = store.getProfiles();
  const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return { ok: false, error: "Profile not found" };

  // Setup Electron session for this profile (proxy + fingerprint)
  const sess = sessionMgr.getSessionForProfile(profileId);
  await sessionMgr.setupProfileSession(profile);

  // Build initial URLs from saved session
  let urls = [];
  if (profile.session && Array.isArray(profile.session.tabs) && profile.session.tabs.length) {
    urls = profile.session.tabs
      .map((t) => t.url)
      .filter((u) => u && (u.startsWith("http://") || u.startsWith("https://")));
  }
  if (!urls.length) urls = ["https://www.google.com"];

  // Offset each profile window so they don't stack on top of each other / the manager
  const offset = profileWindows.size * 30;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    x: 80 + offset,
    y: 60 + offset,
    title: profile.name,
    webPreferences: {
      session: sess,
      preload: FINGERPRINT_PRELOAD,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadURL(urls[0]);

  // Register window→profile mapping
  profileWindows.set(profileId, win);
  sessionMgr.registerWindow(win.id, profileId);
  store.saveOpenProfiles([...profileWindows.keys()]);

  // Auto-save session and update open-profiles list when window closes
  win.on("close", async () => {
    await saveWindowSession(profileId, win);
  });

  win.on("closed", () => {
    profileWindows.delete(profileId);
    sessionMgr.unregisterWindow(win.id);
    store.saveOpenProfiles([...profileWindows.keys()]);
    notifyManagerWindows("WINDOWS_CHANGED");
  });

  // ── Auto-reload on crash ────────────────────────────────────────────────────
  win.webContents.on("render-process-gone", (_ev, details) => {
    if (win.isDestroyed()) return;
    setTimeout(() => { if (!win.isDestroyed()) win.reload(); }, 2000);
  });

  // Auto-reload when page fails to load (e.g. network dropped then came back)
  win.webContents.on("did-fail-load", (_ev, errorCode) => {
    if (win.isDestroyed()) return;
    if (errorCode === -3) return; // ERR_ABORTED — user navigated away, ignore
    setTimeout(() => { if (!win.isDestroyed()) win.reload(); }, 4000);
  });

  notifyManagerWindows("WINDOWS_CHANGED");

  return { ok: true, windowId: win.id, tabCount: 1, restored: urls.length };
}

async function saveWindowSession(profileId, win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const url = win.webContents.getURL();
    const title = win.webContents.getTitle();
    const session = {
      tabs: [{ url, title, active: true }],
      lastSaved: Date.now()
    };
    store.updateProfile(profileId, { session });
    return 1;
  } catch (_) {
    return 0;
  }
}

function notifyManagerWindows(type) {
  // Broadcast to all windows that are NOT profile browser windows
  const profileWinIds = new Set([...profileWindows.values()].map((w) => w.id));
  for (const win of BrowserWindow.getAllWindows()) {
    if (!profileWinIds.has(win.id) && !win.isDestroyed()) {
      win.webContents.send("MAIN_EVENT", { type }).catch?.(() => {});
    }
  }
}

async function testProxy(host, port, scheme, username, password) {
  if (!host || !port) return { ok: false, error: "missing host or port" };

  const { session: electronSession } = require("electron");
  const partitionId = "proxy-test-" + Date.now();
  const tempSess = electronSession.fromPartition(partitionId, { cache: false });

  const proxyRules = `${scheme || "socks5"}://${host}:${port}`;
  await tempSess.setProxy({ proxyRules });

  // Try HTTP first (faster, no TLS handshake), fall back to HTTPS
  const TEST_URLS = [
    "http://api.ipify.org/?format=json",
    "http://checkip.amazonaws.com/",
    "https://api.ipify.org/?format=json"
  ];

  for (const testUrl of TEST_URLS) {
    const result = await tryTestUrl(testUrl, tempSess, username, password);
    if (result.ok) return result;
    if (result.fatal) break; // no point retrying other URLs
  }
  return { ok: false, error: "Proxy unreachable — check host, port, and credentials" };
}

function tryTestUrl(url, session, username, password) {
  return new Promise((resolve) => {
    const req = net.request({ url, session, useSessionCookies: false });

    // For net.request (main process), proxy auth fires on the request — NOT on session
    if (username && password) {
      req.on("login", (authInfo, callback) => {
        if (authInfo.isProxy) callback(username, password);
        else callback("", "");
      });
    }

    let body = "";
    req.on("response", (res) => {
      clearTimeout(timer);
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        try {
          const text = body.trim();
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
      const msg = String(err.message || err);
      // ERR_NO_SUPPORTED_PROXIES = bad proxy format, no point trying more URLs
      const fatal = msg.includes("ERR_NO_SUPPORTED_PROXIES") || msg.includes("ERR_PROXY_CONNECTION_FAILED");
      resolve({ ok: false, error: msg, fatal });
    });
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      resolve({ ok: false, error: "timeout" });
    }, 10000);
    req.end();
  });
}

module.exports = { registerIpcHandlers, openProfileWindow };
