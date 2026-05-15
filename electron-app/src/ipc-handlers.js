"use strict";

const { ipcMain, BrowserWindow, WebContentsView, net, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const store = require("./profile-store");
const sessionMgr = require("./session-manager");
const authStore = require("./auth-store");
const vpsProxy = require("./vps-proxy-manager");

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

function createProfileIcon(profile) {
  try {
    const initials = profileInitials(profile?.name);
    const color = profileAccentColor(profile);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="56" fill="#0c0f14"/>
      <rect x="18" y="18" width="220" height="220" rx="44" fill="${color}"/>
      <path d="M64 81c0-13 11-24 24-24h80c13 0 24 11 24 24v94c0 13-11 24-24 24H88c-13 0-24-11-24-24V81z" fill="rgba(255,255,255,.16)"/>
      <text x="128" y="148" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="76" font-weight="700" fill="#ffffff">${initials}</text>
    </svg>`;
    return nativeImage.createFromDataURL("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
  } catch (_) {
    return undefined;
  }
}

function startPageUrl(errorMsg, failedUrl) {
  const fileUrl = "file:///" + BROWSER_START_HTML.replace(/\\/g, "/");
  if (!errorMsg) return fileUrl;
  return fileUrl + "?error=" + encodeURIComponent(errorMsg) + (failedUrl ? "&url=" + encodeURIComponent(failedUrl) : "");
}

// profileId → BrowserWindow reference for profile browser windows
const profileWindows = new Map();
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

  ipcMain.handle("PROFILE_COUNTRY_IDENTITY", async (_ev, { country = "us", index = 1, deviceClass = "desktop", browserApp = "random" } = {}) => {
    return { ok: true, data: store.buildCountryProfileData(country, index, { deviceClass, browserApp }) };
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

  ipcMain.handle("PROFILE_OPEN_WINDOW", async (_ev, { profileId, url } = {}) => {
    return openProfileWindow(profileId, url);
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
    return testProxy(host, port, scheme, username, password);
  });

  ipcMain.handle("PROXY_DETECT_LOCATION", async (_ev, { host, port, scheme, username, password } = {}) => {
    if (!host || !port) return { ok: false, error: "missing host or port" };
    const { session: electronSession } = require("electron");
    const partitionId = "proxy-geo-" + Date.now();
    const tempSess = electronSession.fromPartition(partitionId, { cache: false });
    await tempSess.setProxy({ proxyRules: `${scheme || "socks5"}://${host}:${port}` });
    const GEO_URLS = [
      "http://ip-api.com/json/?fields=status,message,continent,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,query",
      "https://ipwho.is/",
      "https://ipapi.co/json/"
    ];
    let lastError = "";
    for (const geoUrl of GEO_URLS) {
      const result = await fetchJsonViaProxy(geoUrl, tempSess, username, password);
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
    return { ok: false, error: lastError || "Could not detect proxy location" };
  });

  ipcMain.handle("NETWORK_CAPTURE_CURRENT", async () => {
    try {
      const network = await captureCurrentNetwork();
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
      meta: getProfileBrowserMeta(state.profileId),
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

    const extensionPath = picked.filePaths[0];
    const sess = sessionMgr.getSessionForProfile(state.profileId);
    try {
      const loaded = await sess.loadExtension(extensionPath, { allowFileAccess: true });
      const profile = store.getProfiles().find((p) => p.id === state.profileId && !p.deletedAt);
      if (profile) {
        const existing = Array.isArray(profile.extensions) ? profile.extensions : [];
        const next = existing.filter((item) => item.path !== extensionPath && item.id !== loaded.id);
        next.push({
          id: loaded.id,
          name: loaded.name || path.basename(extensionPath),
          path: extensionPath,
          loadedAt: Date.now()
        });
        store.updateProfile(state.profileId, { extensions: next });
      }
      emitTabState(winId);
      return { ok: true, extension: loaded };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
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

function getProfileBrowserMeta(profileId) {
  const profile = store.getProfiles().find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return null;
  const fp = profile.fingerprint || {};
  const proxy = profile.proxy || {};
  const mode = proxy.networkMode || (proxy.enabled ? "proxy" : "direct");
  const browser = fp.browser || profile.browserApp || "chrome";
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
    deviceClass: fp.deviceClass || ((profile.os === "android" || profile.os === "ios") ? "mobile" : "desktop"),
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
  const major = String(config._uaVersion || ((config.userAgent || "").match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || "148");
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

async function applyTabEmulation(webContents, profile) {
  const config = store.buildConfigFromProfile(profile);
  if (config.userAgent) {
    try { webContents.setUserAgent(config.userAgent); } catch (_) {}
  }

  const screen = config.screen || {};
  const isMobile = Boolean(config._mobile || config._viewportMobile || config._touchEmulation);
  const width = isMobile
    ? Math.max(320, Math.min(1200, Number(screen.width) || 412))
    : Math.max(1024, Math.min(3840, Number(screen.width) || 1366));
  const height = isMobile
    ? Math.max(480, Math.min(1600, Number(screen.height) || 915))
    : Math.max(640, Math.min(2160, Number(screen.height) || 768));
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
    screenWidth: width,
    screenHeight: height,
    positionX: 0,
    positionY: 0,
    scale: 1,
    screenOrientation: isMobile
      ? { type: "portraitPrimary", angle: 0 }
      : { type: "landscapePrimary", angle: 90 }
  });
  if (isMobile || config._touchEmulation) {
    await send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: Math.max(1, Number(config._maxTouchPoints) || 5)
    });
    await send("Emulation.setEmitTouchEventsForMouse", {
      enabled: true,
      configuration: isMobile ? "mobile" : "desktop"
    });
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

  // ── Required fields & consistency checks ─────────────────────────────────────
  const px = profile.proxy || {};
  const networkMode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (networkMode === "proxy") {
    if (!px.host || !px.port) {
      return { ok: false, error: "Proxy is enabled but host/port are missing. Fill them in the Proxy tab and click Test, then save." };
    }
    // Geo consistency: if we have a detected country, verify timezone matches
    if (px.detectedCountryCode && profile.fingerprint) {
      const fp = profile.fingerprint;
      const tzMode = fp.timezone || "auto";
      if (tzMode === "manual" && fp.timezoneValue) {
        const tzCountry = guessCountryFromTimezone(fp.timezoneValue);
        const proxyCountry = String(px.detectedCountryCode).toLowerCase();
        if (tzCountry && tzCountry !== proxyCountry) {
          const proxyLabel = px.detectedCountry || proxyCountry.toUpperCase();
          return { ok: false, error: `Geo mismatch: proxy is in ${proxyLabel} but timezone "${fp.timezoneValue}" belongs to ${tzCountry.toUpperCase()}. Fix timezone in the Fingerprint tab (or set it to Auto) and save.` };
        }
      }
    }
  }

  const sess = sessionMgr.getSessionForProfile(profileId);
  try {
    await sessionMgr.setupProfileSession(profile);
  } catch (err) {
    return { ok: false, error: "Proxy setup failed: " + (err.message || err) };
  }

  // The BrowserWindow itself hosts the tab strip UI (with the safe preload).
  // Each tab is a separate WebContentsView with the fingerprint preload + profile session.
  const offset = profileWindows.size * 30;
  const fp = profile.fingerprint || {};
  const isMobileProfile = fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios";
  const winWidth = isMobileProfile ? Math.max(390, Math.min(520, Number(fp.screenWidth) || 412) + 24) : 1280;
  const winHeight = isMobileProfile ? Math.max(720, Math.min(980, Number(fp.screenHeight) || 915) + TAB_STRIP_HEIGHT + 16) : 800;
  const meta = getProfileBrowserMeta(profileId) || {};
  const windowTitle = `${meta.browserLabel || "Browser"} - ${profile.name}`;
  const profileIcon = createProfileIcon(profile);
  const win = new BrowserWindow({
    show: false,
    width: winWidth,
    height: winHeight,
    x: 80 + offset,
    y: 60 + offset,
    title: windowTitle,
    icon: profileIcon,
    backgroundColor: "#0c0f14",
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    try { win.setTitle(windowTitle); } catch (_) {}
  });
  win.setMenuBarVisibility(false);
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
  win.webContents.on("render-process-gone", (_ev, details) => {
    logError(`Tab strip renderer gone (${details.reason}) for profile ${profileId}`);
    const state = windowTabState.get(win.id);
    if (state) {
      const tabs = state.tabs
        .map((t) => ({ url: !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : t.url, title: t.title }))
        .filter((t) => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")));
      if (tabs.length) {
        try { store.updateProfile(profileId, { session: { tabs, lastSaved: Date.now() } }); } catch (_) {}
      }
    }
    try { win.destroy(); } catch (_) {}
  });

  // Init the tab state for this window
  windowTabState.set(win.id, { profileId, tabs: [], activeTabId: null });

  profileWindows.set(profileId, win);
  sessionMgr.registerWindow(win.id, profileId);
  store.saveOpenProfiles([...profileWindows.keys()]);

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

  try {
    await win.loadFile(TAB_STRIP_HTML);
    showProfileWindow();
  } catch (err) {
    logError(err);
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

  const tabId = "t_" + (nextTabId++);
  webContentsProfileMap.set(view.webContents.id, profileId);

  const tabEntry = { id: tabId, view, title: "New tab", url };
  state.tabs.push(tabEntry);

  // Reload tab strip on tab/page events
  const wc = view.webContents;
  const emulationReady = profile ? applyTabEmulation(wc, profile).catch(logError) : Promise.resolve();
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

  // If this tab's renderer crashes, close just the tab (which closes the window
  // if it was the last one). This keeps profileWindows clean so Start works again.
  wc.on("render-process-gone", (_ev, details) => {
    logError(`Tab renderer gone (${details.reason}) for profile ${profileId}, tab ${tabId}`);
    closeTab(windowId, tabId);
  });

  win.contentView.addChildView(view);
  activateTab(windowId, tabId);
  emulationReady.finally(() => {
    if (!wc.isDestroyed()) wc.loadURL(url || startPageUrl());
  });

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
  win.webContents.send("MAIN_EVENT", {
    type: "TAB_STATE",
    tabs,
    activeTabId: state.activeTabId,
    meta: getProfileBrowserMeta(state.profileId)
  });
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
    const profile = store.createProfile(item.data);
    created.push(profile);
  }
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

function notifyManagerWindows(type) {
  // Broadcast to manager windows, not profile browser or provider console windows.
  const profileWinIds = new Set([
    ...[...profileWindows.values()].map((w) => w.id),
    ...[...cloudPhoneWindows.values()].map((w) => w.id)
  ]);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!profileWinIds.has(win.id) && !win.isDestroyed()) {
      win.webContents.send("MAIN_EVENT", { type }).catch?.(() => {});
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

async function captureCurrentNetwork() {
  const urls = [
    "https://ipwho.is/",
    "http://ip-api.com/json/?fields=status,message,continent,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,query",
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
    organization: String(connection.org || data.org || data.isp || "")
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
