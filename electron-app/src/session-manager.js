"use strict";

const { session: electronSession } = require("electron");
const store = require("./profile-store");

// windowId → profileId  (for profile browser windows)
const windowProfileMap = new Map();

// profileId → windowId
const profileWindowMap = new Map();

function getSessionForProfile(profileId) {
  return electronSession.fromPartition(`persist:profile-${profileId}`, { cache: true });
}

async function configureSessionProxy(sess, proxy) {
  if (!proxy || !proxy.enabled || !proxy.host) {
    await sess.setProxy({ mode: "direct" });
    return;
  }
  const scheme = proxy.scheme || "socks5";
  // Credentials must NOT go in the proxy URL — Chromium's proxy rules parser rejects them
  // and returns ERR_NO_SUPPORTED_PROXIES. Auth is handled via the session's 'login' event.
  const proxyRules = `${scheme}://${proxy.host}:${proxy.port}`;
  await sess.setProxy({
    proxyRules,
    proxyBypassRules: (proxy.bypassList || ["localhost", "127.0.0.1"]).join(",")
  });
}

async function setupProfileSession(profile) {
  if (!profile) return;
  const sess = getSessionForProfile(profile.id);
  const config = store.buildConfigFromProfile(profile);
  const proxy = profile.proxy || {};

  await configureSessionProxy(sess, proxy);

  // Proxy authentication — handled here, NOT in the URL
  sess.removeAllListeners("login");
  if (proxy.enabled && proxy.username && proxy.password) {
    sess.on("login", (_request, authInfo, callback) => {
      if (authInfo.isProxy) callback(proxy.username, proxy.password);
      else callback("", "");
    });
  }

  // Spoof User-Agent at the HTTP header level
  if (config && config.spoofUA && config.userAgent) {
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      headers["User-Agent"] = config.userAgent;
      headers["Accept-Language"] = [config.language || "en-US", "en;q=0.9"].join(",");
      callback({ requestHeaders: headers });
    });
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
