"use strict";

const { session: electronSession } = require("electron");
const store = require("./profile-store");

// windowId → profileId  (for profile browser windows)
const windowProfileMap = new Map();

// profileId → windowId
const profileWindowMap = new Map();
const cookieBlockListeners = new WeakMap();
const downloadProfileMap = new WeakMap();

const HEADER_RULE_FILTER = { urls: ["http://*/*", "https://*/*"] };
const FINGERPRINT_HEADER_NAMES = [
  "x-client-data",
  "device-memory",
  "dpr",
  "viewport-width",
  "downlink",
  "ect",
  "rtt",
  "save-data"
];
const CLIENT_HINT_HEADER_NAMES = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-model"
];

function normalizeHeaderMap(headers) {
  const map = {};
  for (const [name, value] of Object.entries(headers || {})) {
    map[name.toLowerCase()] = { name, value };
  }
  return map;
}

function deleteHeader(headers, lowerName) {
  const map = normalizeHeaderMap(headers);
  const entry = map[lowerName.toLowerCase()];
  if (entry) delete headers[entry.name];
}

function setHeader(headers, name, value) {
  deleteHeader(headers, name);
  headers[name] = value;
}

function getChromeMajor(config) {
  const ua = config?.userAgent || "";
  return (ua.match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || "148";
}

function getHeaderPlatform(config) {
  const platform = config?._uaOS
    || (config?._mobile ? "Android" : /Mac/i.test(config?.platform || "") ? "macOS" : /Linux/i.test(config?.platform || "") ? "Linux" : "Windows");
  return platform === "macos" ? "macOS" : platform;
}

function buildClientHints(config) {
  const major = getChromeMajor(config);
  const browser = config?._browserApp || "chrome";
  const platform = getHeaderPlatform(config);
  const brand = browser === "edge" ? "Microsoft Edge" : browser === "brave" ? "Brave" : browser === "privacy" ? "Privacy Shield Browser" : "Google Chrome";
  const full = `${major}.0.0.0`;
  const isMobile = Boolean(config?._mobile);
  const platformVersion = config?._platformVersion
    || (platform === "Windows" ? "15.0.0" : platform === "macOS" ? "14.2.1" : platform === "Android" ? "14" : "6.5.0");

  return {
    "Sec-CH-UA": `"Not_A Brand";v="8", "Chromium";v="${major}", "${brand}";v="${major}"`,
    "Sec-CH-UA-Mobile": isMobile ? "?1" : "?0",
    "Sec-CH-UA-Platform": `"${platform}"`,
    "Sec-CH-UA-Full-Version-List": `"Not_A Brand";v="8.0.0.0", "Chromium";v="${full}", "${brand}";v="${full}"`,
    "Sec-CH-UA-Arch": `"${config?._architecture || (isMobile ? "arm" : "x86")}"`,
    "Sec-CH-UA-Bitness": `"${config?._bitness || "64"}"`,
    "Sec-CH-UA-Platform-Version": `"${platformVersion}"`,
    "Sec-CH-UA-Model": `"${isMobile ? (config?._mobileModel || "") : ""}"`
  };
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  if (!domain) return null;
  const protocol = cookie.secure ? "https://" : "http://";
  return protocol + domain + (cookie.path || "/");
}

function resetCookieBlocker(sess) {
  const listener = cookieBlockListeners.get(sess);
  if (listener) {
    try { sess.cookies.off("changed", listener); } catch (_) {}
    cookieBlockListeners.delete(sess);
  }
}

function installCookieBlocker(sess) {
  resetCookieBlocker(sess);
  const listener = (_event, cookie, cause, removed) => {
    if (removed || cause === "explicit") return;
    const url = cookieUrl(cookie);
    if (!url) return;
    sess.cookies.remove(url, cookie.name).catch(() => {});
  };
  sess.cookies.on("changed", listener);
  cookieBlockListeners.set(sess, listener);
}

function installWebRequestHooks(sess, config) {
  try { sess.webRequest.onBeforeSendHeaders(null); } catch (_) {}
  try { sess.webRequest.onHeadersReceived(null); } catch (_) {}

  sess.webRequest.onBeforeSendHeaders(HEADER_RULE_FILTER, (details, callback) => {
    const headers = { ...details.requestHeaders };

    for (const name of FINGERPRINT_HEADER_NAMES) deleteHeader(headers, name);
    for (const name of CLIENT_HINT_HEADER_NAMES) deleteHeader(headers, name);

    if (config?.spoofUA && config.userAgent) {
      const lang = config.language || "en-US";
      const langRoot = lang.split("-")[0] || "en";
      setHeader(headers, "User-Agent", config.userAgent);
      setHeader(headers, "Accept-Language", `${lang},${langRoot};q=0.9,en;q=0.8`);
      if (config._browserApp !== "firefox" && config._browserApp !== "safari") {
        for (const [name, value] of Object.entries(buildClientHints(config))) {
          setHeader(headers, name, value);
        }
      }
    }

    if (config?.blockCookies) deleteHeader(headers, "cookie");

    callback({ requestHeaders: headers });
  });

  sess.webRequest.onHeadersReceived(HEADER_RULE_FILTER, (details, callback) => {
    if (!config?.blockCookies) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = { ...(details.responseHeaders || {}) };
    deleteHeader(headers, "set-cookie");
    callback({ responseHeaders: headers });
  });
}

function getSessionForProfile(profileId) {
  const safeId = String(profileId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return electronSession.fromPartition(`persist:privacy-shield-profile-${safeId}`, { cache: true });
}

async function configureSessionProxy(sess, proxy) {
  if (proxy?.networkMode === "vpn" || proxy?.networkMode === "direct") {
    await sess.setProxy({ mode: "direct" });
    return;
  }
  if (!proxy || !proxy.enabled || !proxy.host) {
    await sess.setProxy({ mode: "direct" });
    return;
  }
  const port = parseInt(proxy.port, 10);
  if (!port || port < 1 || port > 65535) {
    // Bad port — fall back to direct rather than throwing
    await sess.setProxy({ mode: "direct" });
    return;
  }
  const scheme = proxy.scheme || "socks5";
  // Credentials must NOT go in the proxy URL — Chromium's proxy rules parser rejects them
  // and returns ERR_NO_SUPPORTED_PROXIES. Auth is handled via the session's 'login' event.
  const proxyRules = `${scheme}://${proxy.host}:${port}`;
  await sess.setProxy({
    proxyRules,
    proxyBypassRules: (proxy.bypassList || ["localhost", "127.0.0.1"]).join(",")
  });
}

function installPermissionPolicy(sess, profile, config) {
  const denied = new Set([
    "media",
    "camera",
    "microphone",
    "notifications",
    "midiSysex",
    "pointerLock",
    "fullscreen",
    "openExternal",
    "display-capture",
    "serial",
    "hid",
    "bluetooth",
    "usb"
  ]);

  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "geolocation") {
      callback(Boolean(config?.spoofGeo));
      return;
    }
    callback(!denied.has(permission) && false);
  });

  sess.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "geolocation") return Boolean(config?.spoofGeo);
    if (denied.has(permission)) return false;
    return false;
  });

  if (!downloadProfileMap.has(sess)) {
    sess.on("will-download", (_event, item) => {
      try {
        const { app } = require("electron");
        const path = require("path");
        const fs = require("fs");
        const safeName = String(profile?.name || profile?.id || "profile").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
        const dir = path.join(app.getPath("downloads"), "Privacy Shield", safeName);
        fs.mkdirSync(dir, { recursive: true });
        item.setSavePath(path.join(dir, item.getFilename()));
      } catch (_) {}
    });
    downloadProfileMap.set(sess, profile?.id || true);
  }
}

async function flushSessionNetworkState(sess) {
  try { await sess.closeAllConnections(); } catch (_) {}
  try { await sess.clearHostResolverCache(); } catch (_) {}
  try { await sess.clearAuthCache(); } catch (_) {}
}

async function setupProfileSession(profile) {
  if (!profile) return;
  const sess = getSessionForProfile(profile.id);
  const config = store.buildConfigFromProfile(profile);
  const proxy = profile.proxy || {};

  await configureSessionProxy(sess, proxy);
  await flushSessionNetworkState(sess);

  // Proxy authentication — handled here, NOT in the URL
  sess.removeAllListeners("login");
  if (proxy.enabled && proxy.username && proxy.password) {
    sess.on("login", (_request, authInfo, callback) => {
      if (authInfo.isProxy) callback(proxy.username, proxy.password);
      else callback("", "");
    });
  }

  installWebRequestHooks(sess, config || {});
  installPermissionPolicy(sess, profile, config || {});

  if (config?.blockCookies) {
    await sess.clearStorageData({ storages: ["cookies"] }).catch(() => {});
    installCookieBlocker(sess);
  } else {
    resetCookieBlocker(sess);
  }

  return sess;
}

function registerWindow(windowId, profileId) {
  windowProfileMap.set(windowId, profileId);
  profileWindowMap.set(profileId, windowId);
}

function unregisterWindow(windowId) {
  const profileId = windowProfileMap.get(windowId);
  if (profileId) profileWindowMap.delete(profileId);
  windowProfileMap.delete(windowId);
}

function getProfileForWindow(windowId) {
  return windowProfileMap.get(windowId) || null;
}

function getWindowForProfile(profileId) {
  return profileWindowMap.get(profileId) || null;
}

function getAllProfileWindows() {
  const result = {};
  for (const [profileId, windowId] of profileWindowMap.entries()) {
    result[profileId] = windowId;
  }
  return result;
}

module.exports = {
  getSessionForProfile,
  configureSessionProxy,
  setupProfileSession,
  registerWindow,
  unregisterWindow,
  getProfileForWindow,
  getWindowForProfile,
  getAllProfileWindows
};
