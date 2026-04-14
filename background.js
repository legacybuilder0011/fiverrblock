// background.js - Privacy Shield Service Worker
// Handles cookie purging, network privacy toggles, and config distribution.

const DEFAULT_CONFIG = {
  enabled: true,
  blockCookies: true,
  // Proxy - the ONLY way to change IP / ISP / ASN / country reported by sites.
  useProxy: false,
  proxy: {
    scheme: "socks5",    // "http" | "https" | "socks4" | "socks5"
    host: "",
    port: 1080,
    bypassList: ["localhost", "127.0.0.1", "<local>"]
  },
  spoofGeo: true,
  geo: {
    latitude: 40.7128,
    longitude: -74.006,
    accuracy: 50,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null
  },
  spoofTimezone: true,
  timezone: "UTC",
  localeOffsetMinutes: 0,
  blockWebGL: true,
  blockCanvas: true,
  blockAudio: true,
  blockBattery: true,
  blockPlugins: true,
  blockFonts: true,
  blockScreen: true,
  blockHardware: true,
  blockStorage: false,
  spoofUA: true,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  platform: "Win32",
  language: "en-US",
  languages: ["en-US", "en"],
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24
  },
  // Per-site pause list. Any origin here is skipped by the content scripts
  // AND by the DNR header / tracker rules (via dynamic allow rules).
  siteAllowList: []
};

// ---------- Config bootstrap ----------
async function getConfig() {
  const stored = await chrome.storage.local.get("config");
  if (!stored.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
    return DEFAULT_CONFIG;
  }
  // Merge with defaults (handles extension upgrades)
  return { ...DEFAULT_CONFIG, ...stored.config };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get("config");
  if (!stored.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  await applyNetworkPrivacySettings();
  await applyProxySettings();
  await applySiteAllowRules();
  await applyBadgeDefaults();
  // Open a welcome tour on first install so users know what the shield does
  // and how to pause it per site.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await applyNetworkPrivacySettings();
  await applyProxySettings();
  await applySiteAllowRules();
  await applyBadgeDefaults();
});

// Refresh badge whenever a tab navigates so each tab shows shield status.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "loading" || info.url) {
    await updateBadge(tabId);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await updateBadge(tabId);
});

// ---------- Messaging with content scripts & popup ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_CONFIG") {
        const config = await getConfig();
        sendResponse({ ok: true, config });
      } else if (msg?.type === "SET_CONFIG") {
        const current = await getConfig();
        const next = { ...current, ...msg.config };
        // Never let SET_CONFIG silently bring the proxy up. The proxy flow is
        // managed explicitly by CONNECT_PROXY / DISCONNECT_PROXY so we can
        // preflight it and avoid locking the user out of the internet.
        next.useProxy = current.useProxy;
        next.proxy = current.proxy && msg.config?.proxy
          ? { ...current.proxy, ...msg.config.proxy }
          : current.proxy;
        await chrome.storage.local.set({ config: next });
        await applyNetworkPrivacySettings();
        await applyProxySettings();
        await applyBadgeDefaults();
        await purgeCookiesIfEnabled();
        broadcastConfig(next);
        sendResponse({ ok: true, config: next });
      } else if (msg?.type === "PAUSE_SITE") {
        const result = await pauseSite(msg.hostname);
        sendResponse(result);
      } else if (msg?.type === "RESUME_SITE") {
        const result = await resumeSite(msg.hostname);
        sendResponse(result);
      } else if (msg?.type === "CONNECT_PROXY") {
        const result = await connectProxy(msg.proxy || {});
        sendResponse(result);
      } else if (msg?.type === "DISCONNECT_PROXY") {
        const result = await disconnectProxy();
        sendResponse(result);
      } else if (msg?.type === "TEST_PROXY") {
        const result = await testProxy();
        sendResponse({ ok: true, result });
      } else if (msg?.type === "PURGE_COOKIES") {
        await purgeAllCookies();
        sendResponse({ ok: true });
      } else if (msg?.type === "RELOAD_TAB") {
        if (sender.tab?.id) chrome.tabs.reload(sender.tab.id);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // async
});

function broadcastConfig(config) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs
        .sendMessage(tab.id, { type: "CONFIG_UPDATE", config })
        .catch(() => {});
    }
  });
}

// ---------- Cookie blocking ----------
// Chrome cookies API: delete any cookie set while blocking is enabled.
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const config = await getConfig();
  if (!config.enabled || !config.blockCookies) return;
  if (changeInfo.removed) return;
  const c = changeInfo.cookie;
  const protocol = c.secure ? "https://" : "http://";
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const url = protocol + host + c.path;
  try {
    await chrome.cookies.remove({
      url,
      name: c.name,
      storeId: c.storeId
    });
  } catch (_) {
    /* ignore */
  }
});

async function purgeAllCookies() {
  const cookies = await chrome.cookies.getAll({});
  for (const c of cookies) {
    const protocol = c.secure ? "https://" : "http://";
    const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    const url = protocol + host + c.path;
    try {
      await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
    } catch (_) {
      /* ignore */
    }
  }
}

async function purgeCookiesIfEnabled() {
  const config = await getConfig();
  if (config.enabled && config.blockCookies) await purgeAllCookies();
}

// ---------- Browser-level privacy toggles ----------
async function applyNetworkPrivacySettings() {
  const config = await getConfig();
  const enabled = config.enabled;

  // Toggle Referer, Hyperlink-auditing, Network Prediction, WebRTC IP leak.
  try {
    if (chrome.privacy?.websites?.referrersEnabled) {
      await chrome.privacy.websites.referrersEnabled.set({ value: !enabled });
    }
    if (chrome.privacy?.websites?.hyperlinkAuditingEnabled) {
      await chrome.privacy.websites.hyperlinkAuditingEnabled.set({
        value: !enabled
      });
    }
    if (chrome.privacy?.network?.networkPredictionEnabled) {
      await chrome.privacy.network.networkPredictionEnabled.set({
        value: !enabled
      });
    }
    if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: enabled ? "disable_non_proxied_udp" : "default"
      });
    }
    if (chrome.privacy?.services?.autofillAddressEnabled) {
      await chrome.privacy.services.autofillAddressEnabled.set({
        value: !enabled
      });
    }
    if (chrome.privacy?.services?.autofillCreditCardEnabled) {
      await chrome.privacy.services.autofillCreditCardEnabled.set({
        value: !enabled
      });
    }
  } catch (err) {
    console.warn("Privacy toggles failed:", err);
  }

  // Toggle the DNR ruleset based on enabled.
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enabled ? ["privacy_rules"] : [],
      disableRulesetIds: enabled ? [] : ["privacy_rules"]
    });
  } catch (err) {
    console.warn("DNR toggle failed:", err);
  }
}

// ---------- Proxy (chrome.proxy) - changes real IP / ISP / ASN ----------
async function applyProxySettings() {
  const config = await getConfig();
  try {
    if (!config.enabled || !config.useProxy || !config.proxy?.host) {
      await chrome.proxy.settings.clear({ scope: "regular" });
      return;
    }
    const { scheme, host, port, bypassList } = config.proxy;
    const cfg = {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: scheme || "socks5",
          host,
          port: Number(port) || (scheme === "socks5" ? 1080 : 8080)
        },
        bypassList: Array.isArray(bypassList)
          ? bypassList
          : ["localhost", "127.0.0.1", "<local>"]
      }
    };
    await chrome.proxy.settings.set({ value: cfg, scope: "regular" });
  } catch (err) {
    console.warn("Proxy config failed:", err);
  }
}

async function testProxy() {
  // Fetch a lightweight echo endpoint to confirm traffic goes through the proxy.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch("https://api.ipify.org?format=json", {
      cache: "no-store",
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    const j = await r.json();
    return { ok: true, ip: j.ip };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: humanizeProxyError(e) };
  }
}

function humanizeProxyError(err) {
  const s = String(err || "");
  if (s.includes("Failed to fetch") || s.includes("abort")) {
    return "Proxy unreachable. Nothing is listening at that host:port, or the proxy timed out. Is Tor / your VPN actually running?";
  }
  return s;
}

// Try to bring the proxy up. Applies it, runs a preflight fetch, and if the
// preflight fails, clears the proxy so the user does not lose internet.
async function connectProxy(newProxy) {
  const current = await getConfig();
  const proxy = { ...current.proxy, ...newProxy };
  if (!proxy.host || !proxy.port) {
    return { ok: false, error: "Missing proxy host or port." };
  }

  const trial = {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: proxy.scheme || "socks5",
        host: proxy.host,
        port: Number(proxy.port) || 1080
      },
      bypassList: proxy.bypassList || ["localhost", "127.0.0.1", "<local>"]
    }
  };

  try {
    await chrome.proxy.settings.set({ value: trial, scope: "regular" });
  } catch (err) {
    return { ok: false, error: "chrome.proxy rejected config: " + err };
  }

  const result = await testProxy();
  if (!result.ok) {
    // Roll back so the user is not stuck with a dead proxy.
    try {
      await chrome.proxy.settings.clear({ scope: "regular" });
    } catch (_) {}
    const next = { ...current, useProxy: false, proxy };
    await chrome.storage.local.set({ config: next });
    await applyBadgeDefaults();
    return {
      ok: false,
      error: result.error,
      hint:
        "Chrome is back to direct connection. Start your proxy (e.g. launch Tor Browser, open your VPN's SOCKS port, or run ssh -D 1080) then try again."
    };
  }

  // Preflight passed - persist and commit.
  const next = { ...current, useProxy: true, proxy };
  await chrome.storage.local.set({ config: next });
  await applyBadgeDefaults();
  broadcastConfig(next);
  return { ok: true, ip: result.ip };
}

// ---------- Per-site pause / resume ----------
function normalizeHost(h) {
  if (!h) return "";
  return String(h).trim().toLowerCase().replace(/^www\./, "");
}

async function pauseSite(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, error: "No hostname" };
  const current = await getConfig();
  const set = new Set(current.siteAllowList || []);
  set.add(host);
  const next = { ...current, siteAllowList: Array.from(set) };
  await chrome.storage.local.set({ config: next });
  await applySiteAllowRules();
  broadcastConfig(next);
  return { ok: true, allowList: next.siteAllowList };
}

async function resumeSite(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, error: "No hostname" };
  const current = await getConfig();
  const next = {
    ...current,
    siteAllowList: (current.siteAllowList || []).filter((h) => h !== host)
  };
  await chrome.storage.local.set({ config: next });
  await applySiteAllowRules();
  broadcastConfig(next);
  return { ok: true, allowList: next.siteAllowList };
}

// Installs "allow" DNR rules for every paused site so the static header /
// tracker-blocking rules are bypassed there.
async function applySiteAllowRules() {
  const config = await getConfig();
  const hosts = Array.from(new Set(config.siteAllowList || [])).filter(Boolean);

  // Clear previously installed dynamic rules in our range (1000+).
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter((r) => r.id >= 1000 && r.id < 2000)
      .map((r) => r.id);
    const addRules = hosts.map((host, i) => ({
      id: 1000 + i,
      priority: 1000,
      action: { type: "allowAllRequests" },
      condition: {
        requestDomains: [host],
        resourceTypes: ["main_frame", "sub_frame"]
      }
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules
    });
  } catch (err) {
    console.warn("Dynamic allow-rule update failed:", err);
  }
}

async function disconnectProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (_) {}
  const current = await getConfig();
  const next = { ...current, useProxy: false };
  await chrome.storage.local.set({ config: next });
  await applyBadgeDefaults();
  broadcastConfig(next);
  return { ok: true };
}

// ---------- Per-tab badge ----------
async function applyBadgeDefaults() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
  } catch (_) {}
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) if (t.id) updateBadge(t.id);
  });
}

async function updateBadge(tabId) {
  try {
    const config = await getConfig();
    let text = "";
    let color = "#6b7280";
    if (!config.enabled) {
      text = "OFF";
      color = "#6b7280";
    } else if (config.useProxy && config.proxy?.host) {
      text = "VPN";
      color = "#2563eb";
    } else {
      text = "ON";
      color = "#16a34a";
    }
    await chrome.action.setBadgeText({ text, tabId });
    await chrome.action.setBadgeBackgroundColor({ color, tabId });
  } catch (_) {}
}
