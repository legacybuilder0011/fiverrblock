"use strict";

const { ipcMain, BrowserWindow, WebContentsView, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const store = require("./profile-store");
const sessionMgr = require("./session-manager");
const authStore = require("./auth-store");

function logError(err) {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), "Desktop", "privacy-shield-error.txt"),
      new Date().toISOString() + " " + String(err?.stack || err) + "\n", "utf8"
    );
  } catch (_) {}
}

const FINGERPRINT_PRELOAD = path.join(__dirname, "preload-fingerprint.js");
const RENDERER_PRELOAD = path.join(__dirname, "renderer-preload.js");
const BROWSER_START_HTML = path.join(__dirname, "..", "renderer", "browser-start.html");
const TAB_STRIP_HTML     = path.join(__dirname, "..", "renderer", "tab-strip.html");

const TAB_STRIP_HEIGHT = 78; // tabs row (38) + url row (40)

function startPageUrl(errorMsg, failedUrl) {
  const fileUrl = "file:///" + BROWSER_START_HTML.replace(/\\/g, "/");
  if (!errorMsg) return fileUrl;
  return fileUrl + "?error=" + encodeURIComponent(errorMsg) + (failedUrl ? "&url=" + encodeURIComponent(failedUrl) : "");
}

// profileId → BrowserWindow reference for profile browser windows
const profileWindows = new Map();
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

  ipcMain.handle("PROFILE_OPEN_WINDOW", async (_ev, { profileId, url } = {}) => {
    return openProfileWindow(profileId, url);
  });

  // Bulk profile generation
  ipcMain.handle("PROFILE_BULK_CREATE", async (_ev, { count, country, assignProxies } = {}) => {
    try {
      return await bulkCreateProfiles(count, country, assignProxies);
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
    const result = await authStore.register(email, password);
    if (result.ok) await postLoginSync();
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
    if (active && active.view.webContents.navigationHistory.canGoBack()) active.view.webContents.navigationHistory.goBack();
    return { ok: true };
  });

  ipcMain.handle("TAB_FORWARD", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active && active.view.webContents.navigationHistory.canGoForward()) active.view.webContents.navigationHistory.goForward();
    return { ok: true };
  });

  ipcMain.handle("TAB_RELOAD", async (ev) => {
    const active = getActiveTab(getCallerWindowId(ev));
    if (active) active.view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle("TAB_GET_STATE", async (ev) => {
    const winId = getCallerWindowId(ev);
    const state = winId != null ? windowTabState.get(winId) : null;
    if (!state) return { tabs: [], activeTabId: null };
    return {
      activeTabId: state.activeTabId,
      tabs: state.tabs.map((t) => {
        const wc = t.view.webContents;
        return {
          id: t.id,
          title: !wc.isDestroyed() ? (wc.getTitle() || t.url || "New tab") : t.title,
          url: !wc.isDestroyed() ? wc.getURL() : t.url,
          canBack: !wc.isDestroyed() ? wc.navigationHistory.canGoBack() : false,
          canForward: !wc.isDestroyed() ? wc.navigationHistory.canGoForward() : false
        };
      })
    };
  });
}

// On login/register, pull any cloud data into the per-user local dir, then
// push anything that exists locally only (first-time login on this PC).
async function postLoginSync() {
  try {
    const cloud = require("./cloud-sync");
    const localProfiles = store.getProfiles();
    const localProxies  = store.getProxyLibrary();

    // Push local-only data first (covers "first sync on a fresh PC won't lose data")
    if (localProfiles.length) await cloud.pushAllProfiles(localProfiles);
    if (localProxies.length)  await cloud.pushAllProxies(localProxies);

    // Pull merged set from cloud (server is authoritative after merge)
    const remoteProfiles = await cloud.pullProfiles();
    const remoteProxies  = await cloud.pullProxies();
    if (remoteProfiles.ok) store.saveProfiles(remoteProfiles.profiles || []);
    if (remoteProxies.ok)  store.saveProxyLibrary(remoteProxies.proxies || []);

    return { ok: true, profileCount: (remoteProfiles.profiles || []).length, proxyCount: (remoteProxies.proxies || []).length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Profile window management ──────────────────────────────────────────────────

async function openProfileWindow(profileId, customUrl) {
  // If already open, focus or open a new tab for the requested URL
  const existing = profileWindows.get(profileId);
  if (existing && !existing.isDestroyed()) {
    if (customUrl) addTab(existing.id, customUrl);
    existing.focus();
    return { ok: true, windowId: existing.id, existing: true };
  }

  const profiles = store.getProfiles();
  const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return { ok: false, error: "Profile not found" };

  const sess = sessionMgr.getSessionForProfile(profileId);
  try {
    await sessionMgr.setupProfileSession(profile);
  } catch (err) {
    return { ok: false, error: "Proxy setup failed: " + (err.message || err) };
  }

  // The BrowserWindow itself hosts the tab strip UI (with the safe preload).
  // Each tab is a separate WebContentsView with the fingerprint preload + profile session.
  const offset = profileWindows.size * 30;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    x: 80 + offset,
    y: 60 + offset,
    title: profile.name,
    backgroundColor: "#0c0f14",
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(TAB_STRIP_HTML);

  // Init the tab state for this window
  windowTabState.set(win.id, { profileId, tabs: [], activeTabId: null });

  profileWindows.set(profileId, win);
  sessionMgr.registerWindow(win.id, profileId);
  store.saveOpenProfiles([...profileWindows.keys()]);

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
  });

  // Resize active tab view when window resizes
  win.on("resize", () => layoutActiveTab(win.id));
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
    sessionMgr.unregisterWindow(win.id);
    store.saveOpenProfiles([...profileWindows.keys()]);
    notifyManagerWindows("WINDOWS_CHANGED");
  });

  notifyManagerWindows("WINDOWS_CHANGED");

  return { ok: true, windowId: win.id, tabCount: 1 };
}

// ── Tab management ───────────────────────────────────────────────────────────

function addTab(windowId, url) {
  const state = windowTabState.get(windowId);
  if (!state) return null;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return null;
  const profileId = state.profileId;
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

  const tabId = "t_" + (nextTabId++);
  webContentsProfileMap.set(view.webContents.id, profileId);

  const tabEntry = { id: tabId, view, title: "New tab", url };
  state.tabs.push(tabEntry);

  // Reload tab strip on tab/page events
  const wc = view.webContents;
  wc.on("page-title-updated", (_e, title) => { tabEntry.title = title; emitTabState(windowId); });
  wc.on("did-navigate", (_e, navUrl) => { tabEntry.url = navUrl; emitTabState(windowId); });
  wc.on("did-navigate-in-page", (_e, navUrl) => { tabEntry.url = navUrl; emitTabState(windowId); });
  wc.setWindowOpenHandler(({ url: u }) => { addTab(windowId, u); return { action: "deny" }; });

  wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return;
    if (validatedURL && validatedURL.startsWith("file://")) return;
    wc.loadURL(startPageUrl(desc || "Page failed to load", validatedURL || ""));
  });

  win.contentView.addChildView(view);
  activateTab(windowId, tabId);
  wc.loadURL(url || startPageUrl());

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
  for (const t of state.tabs) {
    if (t.id === state.activeTabId) {
      t.view.setBounds({ x: 0, y: TAB_STRIP_HEIGHT, width: w, height: Math.max(0, h - TAB_STRIP_HEIGHT) });
    }
  }
}

function closeTab(windowId, tabId) {
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
    win.close();
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

function emitTabState(windowId) {
  const state = windowTabState.get(windowId);
  if (!state) return;
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  const tabs = state.tabs.map((t) => {
    const wc = t.view.webContents;
    return {
      id: t.id,
      title: !wc.isDestroyed() ? (wc.getTitle() || t.url || "New tab") : t.title,
      url: !wc.isDestroyed() ? wc.getURL() : t.url,
      canBack: !wc.isDestroyed() ? wc.navigationHistory.canGoBack() : false,
      canForward: !wc.isDestroyed() ? wc.navigationHistory.canGoForward() : false
    };
  });
  win.webContents.send("MAIN_EVENT", { type: "TAB_STATE", tabs, activeTabId: state.activeTabId });
}

// ── Bulk profile generator ───────────────────────────────────────────────────
async function bulkCreateProfiles(count, countryCode, assignProxies) {
  const n = Math.max(1, Math.min(100, parseInt(count, 10) || 10));
  const COUNTRIES = ["us","gb","de","nl","fr","ca","au","jp","sg","br","in","ae","tr","se","ch"];
  const proxyLib = assignProxies ? store.getProxyLibrary() : [];
  const created = [];

  for (let i = 0; i < n; i++) {
    const country = countryCode === "random" || !countryCode
      ? COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)]
      : countryCode;
    const data = randomProfileData(country, i + 1);

    if (assignProxies && proxyLib.length) {
      // Try to find a proxy matching the country, otherwise pick any
      const match = proxyLib.find((p) => p.country === country) || proxyLib[i % proxyLib.length];
      if (match) {
        data.proxy = {
          enabled: true,
          scheme: match.scheme || "socks5",
          host: match.host, port: match.port,
          username: match.username || "", password: match.password || "",
          bypassList: ["localhost", "127.0.0.1"]
        };
      }
    }
    const profile = store.createProfile(data);
    created.push(profile);
  }
  return { ok: true, created: created.length, profiles: created };
}

function randomProfileData(country, idx) {
  const COUNTRY_TZ = { us:"America/New_York", gb:"Europe/London", de:"Europe/Berlin", nl:"Europe/Amsterdam", fr:"Europe/Paris", ca:"America/Toronto", au:"Australia/Sydney", jp:"Asia/Tokyo", sg:"Asia/Singapore", br:"America/Sao_Paulo", in:"Asia/Kolkata", ae:"Asia/Dubai", tr:"Europe/Istanbul", se:"Europe/Stockholm", ch:"Europe/Zurich" };
  const COUNTRY_LANG = { us:"en-US", gb:"en-GB", de:"de-DE", nl:"nl-NL", fr:"fr-FR", ca:"en-CA", au:"en-AU", jp:"ja-JP", sg:"en-SG", br:"pt-BR", in:"hi-IN", ae:"ar-AE", tr:"tr-TR", se:"sv-SE", ch:"de-DE" };
  const SCREENS = [[1920,1080],[1366,768],[1536,864],[1440,900],[2560,1440],[1600,900]];
  const OS = country === "au" ? "macos" : "windows";
  const screen = SCREENS[Math.floor(Math.random() * SCREENS.length)];
  const cores = [2,4,6,8,12,16][Math.floor(Math.random() * 6)];
  const ram = [4,8,16,32][Math.floor(Math.random() * 4)];

  const fp = store.getDefaultFingerprint();
  fp.timezone = "manual"; fp.timezoneValue = COUNTRY_TZ[country] || "UTC";
  fp.language = "manual"; fp.languageValue = COUNTRY_LANG[country] || "en-US";
  fp.screen = "manual";   fp.screenWidth = screen[0]; fp.screenHeight = screen[1];
  fp.cpuCores = "manual"; fp.cpuCoresValue = cores;
  fp.ram = "manual";      fp.ramValue = ram;
  fp.browserVersion = String(140 + Math.floor(Math.random() * 9));

  return {
    name: `${country.toUpperCase()} Profile ${idx}`,
    os: OS,
    browserApp: "chrome",
    status: "new",
    fingerprint: fp
  };
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

  let lastError = "";
  for (const testUrl of TEST_URLS) {
    const result = await tryTestUrl(testUrl, tempSess, username, password);
    if (result.ok) return result;
    lastError = result.error || lastError;
    if (result.fatal) break;
  }
  // Return the specific error from the test attempts instead of a generic message
  return { ok: false, error: lastError || "Proxy unreachable — check host, port, and credentials" };
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

module.exports = { registerIpcHandlers, openProfileWindow };
