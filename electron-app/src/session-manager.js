"use strict";

const { app, BrowserWindow, session: electronSession } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const store = require("./profile-store");
const bridge = require("./local-proxy-bridge");
const mitmBridge = require("./tls-mitm-bridge");
const { ensureAppProtocol } = require("./app-protocol");

function sessLog(msg) {
  try {
    const dir = app && typeof app.getPath === "function" ? app.getPath("userData") : os.tmpdir();
    const file = path.join(dir, "privacy-shield-error.txt");
    fs.appendFileSync(file, new Date().toISOString() + " " + String(msg) + "\n", "utf8");
  } catch (_) {}
}

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
  return (ua.match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || "150";
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
      if (config._browserApp !== "firefox" && config._browserApp !== "safari" && config._uaOS !== "iOS") {
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

function getPartitionForProfile(profileId) {
  const rawId = String(profileId || "").trim();
  if (!rawId) throw new Error("A saved profile ID is required for browser storage");
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeId) throw new Error("Profile ID cannot produce a storage partition");
  return `persist:privacy-shield-profile-${safeId}`;
}

function getSessionForProfile(profileId) {
  return electronSession.fromPartition(getPartitionForProfile(profileId), { cache: true });
}

function assertProfileSession(actualSession, profileId) {
  const expectedSession = getSessionForProfile(profileId);
  if (!actualSession || actualSession !== expectedSession) {
    throw new Error(`Browser storage session mismatch for profile ${profileId}`);
  }
  if (!expectedSession.storagePath) {
    throw new Error(`Persistent browser storage path is unavailable for profile ${profileId}`);
  }
  return {
    partition: getPartitionForProfile(profileId),
    storagePath: expectedSession.storagePath
  };
}

async function configureSessionProxy(sess, proxy, profileId, options = {}) {
  if (proxy?.networkMode === "vpn" || proxy?.networkMode === "direct") {
    await sess.setProxy({ mode: "direct" });
    bridge.stopBridge(profileId);
    mitmBridge.stopMitmBridge(profileId);
    return { mode: "direct" };
  }
  if (!proxy || !proxy.enabled || !proxy.host) {
    await sess.setProxy({ mode: "direct" });
    bridge.stopBridge(profileId);
    mitmBridge.stopMitmBridge(profileId);
    return { mode: "direct" };
  }
  const port = parseInt(proxy.port, 10);
  if (!port || port < 1 || port > 65535) {
    await sess.setProxy({ mode: "direct" });
    bridge.stopBridge(profileId);
    mitmBridge.stopMitmBridge(profileId);
    return { mode: "direct", reason: "bad-port" };
  }
  const scheme = String(proxy.scheme || "socks5").toLowerCase();
  const hasAuth = Boolean(proxy.username || proxy.password);

  // TLS MITM bridge is opt-in per profile via fingerprint.tlsSpoof. It re-
  // originates HTTPS via cycletls with a per-profile JA3 (verified: two
  // profiles yield two distinct JA3 hashes at tls.peet.ws). The old "empty
  // body through authenticated proxies" symptom was a cycletls v2 API mismatch
  // (the bridge read resp.body, which v2 renamed to resp.data/arrayBuffer()) —
  // fixed in tls-mitm-bridge.js. Stays default OFF pending live-proxy soak;
  // a dead/expired upstream proxy now surfaces as a real 502 diagnostic page
  // instead of a blank tab.
  const tlsSpoof = Boolean(options.tlsSpoof);
  if (tlsSpoof && (scheme === "http" || scheme === "https") && hasAuth) {
    const local = await mitmBridge.getMitmBridge(profileId, {
      scheme, host: proxy.host, port, username: proxy.username, password: proxy.password
    }, options.fingerprintSeed, options.identity);
    if (local) {
      const proxyRules = `http://127.0.0.1:${local.port}`;
      await sess.setProxy({
        proxyRules,
        proxyBypassRules: (proxy.bypassList || ["localhost", "127.0.0.1"]).join(",")
      });
      bridge.stopBridge(profileId);
      return { mode: "mitm", scheme, host: proxy.host, port };
    }
    sessLog(`mitm bridge FAILED to start profile=${profileId}, falling back to plain bridge`);
  } else {
    mitmBridge.stopMitmBridge(profileId);
  }

  if ((scheme === "http" || scheme === "https") && hasAuth) {
    const local = await bridge.getBridge(profileId, {
      scheme,
      host: proxy.host,
      port,
      username: proxy.username,
      password: proxy.password
    });
    if (local) {
      sessLog(`proxy bridge profile=${profileId} local=127.0.0.1:${local.port} -> ${scheme}://${proxy.host}:${port}`);
      const proxyRules = `http://127.0.0.1:${local.port}`;
      await sess.setProxy({
        proxyRules,
        proxyBypassRules: (proxy.bypassList || ["localhost", "127.0.0.1"]).join(",")
      });
      return { mode: "bridge", scheme, host: proxy.host, port };
    }
    sessLog(`proxy bridge FAILED to start profile=${profileId}, falling back to direct setProxy`);
  } else {
    bridge.stopBridge(profileId);
  }

  const proxyRules = `${scheme}://${proxy.host}:${port}`;
  await sess.setProxy({
    proxyRules,
    proxyBypassRules: (proxy.bypassList || ["localhost", "127.0.0.1"]).join(",")
  });
  return { mode: "native", scheme, host: proxy.host, port };
}

function installMitmCertTrust(sess, profileId) {
  // When TLS MITM is active for this profile, Chromium connects to the local
  // bridge using a leaf cert signed by a per-profile root CA. That CA isn't
  // in the OS trust store, so without this hook every page would show
  // ERR_CERT_AUTHORITY_INVALID. We accept cert chains signed by THIS
  // profile's CA only — other profiles or system certs go through default
  // validation (return 0 = use Chromium default).
  const caPem = mitmBridge.getCAForProfile(profileId);
  if (!caPem) {
    sess.setCertificateVerifyProc(null);
    return;
  }
  sess.setCertificateVerifyProc((req, callback) => {
    try {
      const chain = [req.certificate, ...(req.certificate.issuerCert ? collectIssuerChain(req.certificate) : [])];
      for (const cert of chain) {
        if (cert && cert.data && caPem.includes(cert.data.trim().slice(0, 200))) {
          callback(0); return;
        }
      }
      const issuerName = req.certificate && req.certificate.issuerName ? String(req.certificate.issuerName) : "";
      if (issuerName.includes("PrivacyShield MITM CA")) {
        callback(0); return;
      }
    } catch (_) {}
    callback(-3); // -3 = use Chromium default validation
  });
}

function collectIssuerChain(cert) {
  const out = [];
  let cur = cert.issuerCert;
  let depth = 0;
  while (cur && depth < 8) {
    out.push(cur);
    cur = cur.issuerCert;
    depth++;
  }
  return out;
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
        const dir = getDownloadDirectory(profile);
        const fileName = safeDownloadFileName(item.getFilename());
        const savePath = getAvailableDownloadPath(dir, fileName);
        item.setSavePath(savePath);
        sessLog(`download start profile=${profile?.id || ""} file=${fileName} path=${savePath}`);
        sendDownloadState(profile?.id, {
          state: "starting",
          fileName,
          savePath,
          receivedBytes: 0,
          totalBytes: item.getTotalBytes()
        });

        let lastProgressAt = 0;
        item.on("updated", (_downloadEvent, state) => {
          const now = Date.now();
          if (state === "progressing" && now - lastProgressAt < 250) return;
          lastProgressAt = now;
          sendDownloadState(profile?.id, {
            state,
            fileName,
            savePath,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes()
          });
        });
        item.once("done", (_downloadEvent, state) => {
          sessLog(`download done profile=${profile?.id || ""} state=${state} file=${fileName} path=${savePath}`);
          sendDownloadState(profile?.id, {
            state,
            fileName,
            savePath,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes()
          });
        });
      } catch (err) {
        sessLog(`download setup failed profile=${profile?.id || ""}: ${err?.stack || err}`);
        sendDownloadState(profile?.id, {
          state: "interrupted",
          fileName: item.getFilename() || "download",
          error: err?.message || String(err)
        });
      }
    });
    downloadProfileMap.set(sess, profile?.id || true);
  }
}

function safeDownloadSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function safeDownloadFileName(fileName) {
  return safeDownloadSegment(path.basename(String(fileName || "download")), "download");
}

function getDownloadDirectory(profileOrId) {
  const profile = typeof profileOrId === "object" && profileOrId ? profileOrId : null;
  const id = safeDownloadSegment(profile?.id || profileOrId, "profile");
  const name = safeDownloadSegment(profile?.name, "Profile");
  const dir = path.join(app.getPath("downloads"), "Privacy Shield", `${name}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAvailableDownloadPath(directory, fileName) {
  const initial = path.join(directory, fileName);
  if (!fs.existsSync(initial)) return initial;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let index = 1; index < 10000; index++) {
    const candidate = path.join(directory, `${base} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(directory, `${base}-${Date.now()}${ext}`);
}

function sendDownloadState(profileId, detail) {
  const windowId = profileWindowMap.get(profileId);
  const win = windowId != null ? BrowserWindow.fromId(windowId) : null;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send("MAIN_EVENT", { type: "DOWNLOAD_STATE", ...detail });
  } catch (_) {}
}

async function flushSessionNetworkState(sess) {
  try { await sess.closeAllConnections(); } catch (_) {}
  try { await sess.clearHostResolverCache(); } catch (_) {}
  try { await sess.clearAuthCache(); } catch (_) {}
}

async function loadProfileExtensions(sess, profile) {
  const extensions = Array.isArray(profile?.extensions) ? profile.extensions : [];
  if (!extensions.length || typeof sess.loadExtension !== "function") return;
  const loaded = new Set((typeof sess.getAllExtensions === "function" ? sess.getAllExtensions() : []).map((ext) => ext.path || ext.id));
  for (const entry of extensions) {
    const dir = typeof entry === "string" ? entry : entry?.path;
    if (!dir || loaded.has(dir) || !fs.existsSync(dir)) continue;
    try {
      const ext = await sess.loadExtension(dir, { allowFileAccess: true });
      loaded.add(dir);
      if (ext?.id) loaded.add(ext.id);
    } catch (err) {
      sessLog(`extension restore failed profile=${profile?.id || ""} path=${dir}: ${err?.message || err}`);
    }
  }
}

// Substitute {{profile}} / {{profile_id}} / {{profile_name}} placeholders in the
// proxy username string with values derived from the current profile. Lets one
// proxy-library template (e.g. "package-345436-…-sessionid-{{profile}}-…") fan
// out to a unique session ID per profile, so every profile gets its own sticky
// IP without manually editing each library entry.
function safeSessionSlug(value) {
  const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "profile";
}
function expandProxyPlaceholders(template, profile) {
  if (!template || !/\{\{\s*profile/.test(template)) return template;
  const id = String(profile.id || "");
  const name = safeSessionSlug(profile.name);
  const generic = safeSessionSlug(profile.name || profile.id);
  return template
    .replace(/\{\{\s*profile_id\s*\}\}/g, id)
    .replace(/\{\{\s*profile_name\s*\}\}/g, name)
    .replace(/\{\{\s*profile\s*\}\}/g, generic);
}

async function setupProfileSession(profile) {
  if (!profile || !profile.id) throw new Error("Cannot configure browser storage without a saved profile");
  const sess = getSessionForProfile(profile.id);
  const storage = assertProfileSession(sess, profile.id);
  await ensureAppProtocol(sess.protocol, sessLog, sessLog);
  const config = store.buildConfigFromProfile(profile);
  const proxy = profile.proxy || {};
  const proxyUsername = expandProxyPlaceholders(proxy.username, profile);

  sessLog(`profile storage profile=${profile.id} partition=${storage.partition} path=${storage.storagePath}`);
  sessLog(`proxy config profile=${profile.id} enabled=${Boolean(proxy.enabled)} mode=${proxy.networkMode || "proxy"} scheme=${proxy.scheme || ""} host=${proxy.host || ""} port=${proxy.port || ""} user=${proxyUsername ? "set(" + proxyUsername.length + ")" : "empty"} pass=${proxy.password ? "set(" + String(proxy.password).length + ")" : "empty"}`);

  const proxyWithExpandedUser = { ...proxy, username: proxyUsername };
  const tlsSpoof = Boolean(profile.fingerprint && profile.fingerprint.tlsSpoof);
  const fingerprintSeed = (profile.fingerprint && profile.fingerprint.fingerprintSeed) || profile.id;
  // Identity so the TLS bridge can pick a JA3 coherent with the spoofed browser/OS
  // and re-originate with the profile's real User-Agent.
  const identity = { userAgent: config.userAgent, browser: config._browserApp, os: config._uaOS };
  const proxyResult = await configureSessionProxy(sess, proxyWithExpandedUser, profile.id, { tlsSpoof, fingerprintSeed, identity });
  sessLog(`proxy setup profile=${profile.id} result=${proxyResult.mode}${proxyResult.reason ? " reason=" + proxyResult.reason : ""}${tlsSpoof ? " tlsSpoof=on" : ""}`);
  if (proxyResult.mode === "mitm") installMitmCertTrust(sess, profile.id);
  else sess.setCertificateVerifyProc(null);
  await flushSessionNetworkState(sess);

  // Proxy authentication — handled here, NOT in the URL
  sess.removeAllListeners("login");
  if (proxy.enabled && proxyUsername && proxy.password) {
    sess.on("login", (_request, authInfo, callback) => {
      if (authInfo.isProxy) {
        sessLog(`proxy login profile=${profile.id} host=${authInfo.host}:${authInfo.port}`);
        callback(proxyUsername, proxy.password);
      } else {
        callback("", "");
      }
    });
  } else if (proxy.enabled) {
    sessLog(`proxy enabled but missing creds profile=${profile.id} user=${proxyUsername ? "set" : "empty"} pass=${proxy.password ? "set" : "empty"}`);
  }

  try {
    if (sess.webRequest.onErrorOccurred) {
      sess.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (details) => {
        if (!details.fromCache && details.resourceType === "mainFrame") {
          if (details.error === "net::ERR_ABORTED") return;
          sessLog(`net err profile=${profile.id} ${details.error} ${details.url}`);
        }
      });
    }
  } catch (_) {}

  installWebRequestHooks(sess, config || {});
  installPermissionPolicy(sess, profile, config || {});
  await loadProfileExtensions(sess, profile);

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
  getPartitionForProfile,
  getSessionForProfile,
  assertProfileSession,
  configureSessionProxy,
  setupProfileSession,
  registerWindow,
  unregisterWindow,
  getProfileForWindow,
  getWindowForProfile,
  getAllProfileWindows,
  getDownloadDirectory,
  expandProxyPlaceholders
};
