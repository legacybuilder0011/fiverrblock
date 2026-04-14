// background.js - Privacy Shield Service Worker
// Handles cookie purging, network privacy toggles, and config distribution.

const DEFAULT_CONFIG = {
  enabled: true,
  blockCookies: true,
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
  }
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

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("config");
  if (!stored.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  await applyNetworkPrivacySettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await applyNetworkPrivacySettings();
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
        await chrome.storage.local.set({ config: next });
        await applyNetworkPrivacySettings();
        await purgeCookiesIfEnabled();
        broadcastConfig(next);
        sendResponse({ ok: true, config: next });
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
