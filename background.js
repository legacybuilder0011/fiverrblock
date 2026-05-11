// background.js - Privacy Shield Service Worker
// Handles cookie purging, privacy toggles, live activity log, and config.

// ---------- Live activity log ----------
// Per-host counters + a rolling ring buffer of recent events. Kept in
// service-worker memory; the popup polls via GET_ACTIVITY. We also mirror
// into chrome.storage.session so the popup can render immediately even
// after the service worker has been idled out.
const ACTIVITY_RECENT_MAX = 60;
const ACTIVITY_EMPTY = () => ({
  counters: {
    cookiesBlocked: 0,
    canvasAccess: 0,
    webglAccess: 0,
    audioAccess: 0,
    geoAccess: 0,
    batteryAccess: 0,
    pluginsAccess: 0,
    fontsAccess: 0,
    screenAccess: 0,
    uaAccess: 0,
    hardwareAccess: 0,
    timezoneAccess: 0,
    storageAccess: 0,
    adsBlocked: 0,
    minersBlocked: 0,
    trackersBlocked: 0
  },
  recent: []
});

let activity = { byHost: {}, global: ACTIVITY_EMPTY() };

// Restore from session storage on SW wakeup (best effort).
chrome.storage.session.get("activity").then((r) => {
  if (r && r.activity) {
    activity = r.activity;
  }
});

let persistPending = false;
function persistActivitySoon() {
  if (persistPending) return;
  persistPending = true;
  setTimeout(() => {
    persistPending = false;
    try {
      chrome.storage.session.set({ activity });
    } catch (_) {}
  }, 500);
}

function recordActivity(host, type, detail) {
  host = (host || "").toLowerCase().replace(/^www\./, "") || "_global";
  const bucket =
    activity.byHost[host] || (activity.byHost[host] = ACTIVITY_EMPTY());
  if (bucket.counters[type] !== undefined) bucket.counters[type]++;
  if (activity.global.counters[type] !== undefined)
    activity.global.counters[type]++;
  const evt = { t: Date.now(), host, type, detail: detail || "" };
  bucket.recent.unshift(evt);
  if (bucket.recent.length > ACTIVITY_RECENT_MAX)
    bucket.recent.length = ACTIVITY_RECENT_MAX;
  activity.global.recent.unshift(evt);
  if (activity.global.recent.length > ACTIVITY_RECENT_MAX)
    activity.global.recent.length = ACTIVITY_RECENT_MAX;
  persistActivitySoon();
}

function getActivityFor(host) {
  host = (host || "").toLowerCase().replace(/^www\./, "");
  const site = host ? activity.byHost[host] : null;
  return {
    host,
    site: site || ACTIVITY_EMPTY(),
    global: activity.global
  };
}

function clearActivity(host) {
  if (host) {
    host = host.toLowerCase().replace(/^www\./, "");
    delete activity.byHost[host];
  } else {
    activity = { byHost: {}, global: ACTIVITY_EMPTY() };
  }
  persistActivitySoon();
}

const DEFAULT_CONFIG = {
  enabled: true,
  blockCookies: true,
  // Ads + crypto-miners are blocked via their own DNR rulesets.
  blockAds: true,
  blockMining: true,
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
  // Rotate OS / UA / screen / language / timezone / cores / GPU on every page
  // load so trackers can't use the "stable fake" as its own cross-session ID.
  selectedCountry: "",
  rotateFingerprint: true,
  // When true, each tab gets its own stable fingerprint (different tabs see
  // different identities). Overrides rotateFingerprint within a single tab —
  // the fingerprint stays stable across reloads within that tab.
  perTabFingerprint: false,
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

// ---------- Per-tab fingerprint isolation ----------
// Each tab gets its own stable fingerprint so sites opened in different tabs
// can't correlate you. Fingerprint is created lazily on first GET_CONFIG from
// a tab and persists in chrome.storage.session until the tab is closed.
const TAB_POOLS = {
  ua: [
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "MacIntel" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", platform: "MacIntel" },
    { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "Linux x86_64" }
  ],
  screens: [
    { w: 1920, h: 1080 }, { w: 1536, h: 864 }, { w: 1440, h: 900 },
    { w: 1366, h: 768 }, { w: 2560, h: 1440 }, { w: 1680, h: 1050 }
  ],
  languages: ["en-US", "en-GB", "en-CA", "de-DE", "fr-FR", "nl-NL", "it-IT", "es-ES", "pt-BR"],
  cores: [4, 6, 8, 12, 16],
  memory: [4, 8, 16, 32],
  gpus: [
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 2048SP Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" }
  ]
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function makeTabFingerprint() {
  const ua = pick(TAB_POOLS.ua);
  const screen = pick(TAB_POOLS.screens);
  const gpu = pick(TAB_POOLS.gpus);
  return {
    userAgent: ua.ua,
    platform: ua.platform,
    language: pick(TAB_POOLS.languages),
    hardwareConcurrency: pick(TAB_POOLS.cores),
    deviceMemory: pick(TAB_POOLS.memory),
    screen: {
      width: screen.w,
      height: screen.h,
      availWidth: screen.w,
      availHeight: screen.h - 40,
      colorDepth: 24,
      pixelDepth: 24
    },
    _gpuVendor: gpu.vendor,
    _gpuRenderer: gpu.renderer
  };
}

let tabFingerprints = {};
const tabFpReady = chrome.storage.session.get("tabFingerprints").then((r) => {
  if (r && r.tabFingerprints) tabFingerprints = r.tabFingerprints;
});

function persistTabFingerprints() {
  chrome.storage.session.set({ tabFingerprints }).catch(() => {});
}

async function getOrCreateTabFingerprint(tabId) {
  await tabFpReady;
  if (!tabId) return null;
  if (!tabFingerprints[tabId]) {
    tabFingerprints[tabId] = makeTabFingerprint();
    persistTabFingerprints();
  }
  return tabFingerprints[tabId];
}

async function regenerateTabFingerprint(tabId) {
  await tabFpReady;
  if (!tabId) return null;
  tabFingerprints[tabId] = makeTabFingerprint();
  persistTabFingerprints();
  return tabFingerprints[tabId];
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabFingerprints[tabId]) {
    delete tabFingerprints[tabId];
    persistTabFingerprints();
  }
});

async function getConfigForTab(tabId) {
  await tabProfileMapReady;
  const baseConfig = await getConfig();
  const profileId = tabId ? tabProfileMap[tabId] : null;
  if (profileId) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
    if (profile) return buildConfigFromProfile(profile, baseConfig);
    delete tabProfileMap[tabId];
    persistTabProfileMap();
  }
  if (!baseConfig.perTabFingerprint || !tabId) return baseConfig;
  const fp = await getOrCreateTabFingerprint(tabId);
  return { ...baseConfig, ...fp, rotateFingerprint: false };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get("config");
  if (!stored.config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  }
  await applyNetworkPrivacySettings();
  await applyProxySettings();
  await applySiteAllowRules();
  await syncHeadersWithConfig();
  await applyBadgeDefaults();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await applyNetworkPrivacySettings();
  await applyProxySettings();
  await applySiteAllowRules();
  await syncHeadersWithConfig();
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
        // Content scripts get tab-specific config (with per-tab fingerprint
        // if the toggle is on). Popup/welcome page gets the base config.
        const config = sender?.tab?.id
          ? await getConfigForTab(sender.tab.id)
          : await getConfig();
        sendResponse({ ok: true, config });
      } else if (msg?.type === "GET_TAB_FP") {
        await tabFpReady;
        const tabId = msg.tabId;
        const config = await getConfig();
        if (!config.perTabFingerprint || !tabId || !tabFingerprints[tabId]) {
          sendResponse({ ok: true, fp: null });
        } else {
          sendResponse({ ok: true, fp: tabFingerprints[tabId] });
        }
      } else if (msg?.type === "REGENERATE_TAB_FP") {
        const tabId = msg.tabId || sender?.tab?.id;
        if (tabId) {
          await regenerateTabFingerprint(tabId);
          const fresh = await getConfigForTab(tabId);
          chrome.tabs.sendMessage(tabId, { type: "CONFIG_UPDATE", config: fresh }).catch(() => {});
          chrome.tabs.reload(tabId).catch(() => {});
        }
        sendResponse({ ok: true });
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
        await syncHeadersWithConfig(next);
        await applyBadgeDefaults();
        await purgeCookiesIfEnabled();
        broadcastConfig(next);
        sendResponse({ ok: true, config: next });
      } else if (msg?.type === "RECORD_ACTIVITY") {
        // Called from the ISOLATED content script. Use the sender's tab
        // origin as the authoritative host to prevent any page forging.
        let host = "";
        try {
          const u = new URL(sender?.url || sender?.tab?.url || "");
          host = u.hostname;
        } catch (_) {}
        if (Array.isArray(msg.events)) {
          for (const e of msg.events) recordActivity(host, e.type, e.detail);
        } else if (msg.eventType) {
          recordActivity(host, msg.eventType, msg.detail);
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "GET_ACTIVITY") {
        sendResponse({ ok: true, activity: getActivityFor(msg.host) });
      } else if (msg?.type === "CLEAR_ACTIVITY") {
        clearActivity(msg.host);
        sendResponse({ ok: true });
      } else if (msg?.type === "PAUSE_SITE") {
        const result = await pauseSite(msg.hostname);
        sendResponse(result);
      } else if (msg?.type === "RESUME_SITE") {
        const result = await resumeSite(msg.hostname);
        sendResponse(result);
      } else if (msg?.type === "BYPASS_PROXY_SITE") {
        const result = await bypassProxyForSite(msg.hostname);
        sendResponse(result);
      } else if (msg?.type === "UNBYPASS_PROXY_SITE") {
        const result = await unbypassProxyForSite(msg.hostname);
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
      } else if (msg?.type === "LEAK_TEST") {
        const result = await runLeakTest();
        sendResponse({ ok: true, result });
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
  chrome.tabs.query({}, async (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      // If per-tab fingerprint is on, merge the tab's fingerprint in so
      // each tab still gets its own stable identity on config change.
      let toSend = config;
      if (config.perTabFingerprint) {
        const fp = await getOrCreateTabFingerprint(tab.id);
        toSend = { ...config, ...fp, rotateFingerprint: false };
      }
      chrome.tabs
        .sendMessage(tab.id, { type: "CONFIG_UPDATE", config: toSend })
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
  const host = (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain)
    .toLowerCase();
  // Respect per-site pause: do NOT delete cookies belonging to paused hosts
  // (matches the exact host OR any parent on the allow list).
  if (hostMatchesAllowList(host, config.siteAllowList)) return;
  const protocol = c.secure ? "https://" : "http://";
  const url = protocol + host + c.path;
  try {
    await chrome.cookies.remove({
      url,
      name: c.name,
      storeId: c.storeId
    });
    recordActivity(host, "cookiesBlocked", c.name);
  } catch (_) {
    /* ignore */
  }
});

function hostMatchesAllowList(host, list) {
  if (!host || !Array.isArray(list) || !list.length) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const raw of list) {
    const allowed = String(raw || "").toLowerCase().replace(/^www\./, "");
    if (!allowed) continue;
    if (h === allowed || h.endsWith("." + allowed)) return true;
  }
  return false;
}

async function purgeAllCookies({ respectAllowList = true } = {}) {
  const cookies = await chrome.cookies.getAll({});
  const config = respectAllowList ? await getConfig() : null;
  const list = config ? config.siteAllowList || [] : [];
  for (const c of cookies) {
    const host = (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain)
      .toLowerCase();
    if (respectAllowList && hostMatchesAllowList(host, list)) continue;
    const protocol = c.secure ? "https://" : "http://";
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
    // Don't disable referrers globally — stripping all Referer headers breaks
    // CSRF protection and login flows on many sites (including Fiverr).
    // Chrome's default Referrer-Policy (strict-origin-when-cross-origin) already
    // limits cross-origin leakage to the origin only.
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

  // Toggle the DNR rulesets based on master switch + per-feature toggles.
  try {
    const enable = [];
    const disable = [];
    (enabled ? enable : disable).push("privacy_rules");
    (enabled && config.blockAds !== false ? enable : disable).push("ads_rules");
    (enabled && config.blockMining !== false ? enable : disable).push(
      "mining_rules"
    );
    (enabled && config.blockCookies === true ? enable : disable).push(
      "cookie_rules"
    );
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enable,
      disableRulesetIds: disable
    });
  } catch (err) {
    console.warn("DNR toggle failed:", err);
  }
}

// ---------- Dynamic header sync ----------
// Keeps HTTP User-Agent, Accept-Language, and sec-ch-ua headers in sync with
// the JS-side spoofed values. Without this, PerimeterX sees the HTTP header
// saying one browser and navigator.userAgent saying another = instant flag.
async function syncHeadersWithConfig(cfg) {
  if (!cfg) cfg = await getConfig();
  const ua = cfg.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const lang = cfg.language || "en-US";
  const chromeVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || "120";
  const platform = /Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Windows";
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.filter((r) => r.id >= 9000 && r.id < 9010).map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: [{
        id: 9000,
        priority: 10,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "user-agent", operation: "set", value: ua },
            { header: "accept-language", operation: "set", value: lang + "," + lang.split("-")[0] + ";q=0.9,en;q=0.8" },
            { header: "sec-ch-ua", operation: "set", value: '"Not_A Brand";v="8", "Chromium";v="' + chromeVer + '", "Google Chrome";v="' + chromeVer + '"' },
            { header: "sec-ch-ua-platform", operation: "set", value: '"' + platform + '"' },
            { header: "sec-ch-ua-mobile", operation: "set", value: "?0" }
          ]
        },
        condition: {
          urlFilter: "*",
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "image", "font", "stylesheet", "media", "ping", "other"]
        }
      }]
    });
  } catch (err) {
    console.warn("Dynamic header sync failed:", err);
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

// ---------- Leak test ----------
// Fetches IP/country/ISP and DNS servers so the user can verify their VPN is
// actually routing traffic and no DNS queries are leaking to their real ISP.
async function runLeakTest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const result = {
    ip: null,
    country: null,
    city: null,
    isp: null,
    asn: null,
    dns: [],
    warnings: []
  };
  try {
    const r = await fetch("https://ipapi.co/json/", {
      cache: "no-store",
      signal: ctrl.signal
    });
    if (r.ok) {
      const j = await r.json();
      result.ip = j.ip || null;
      result.country = j.country_name || j.country || null;
      result.city = j.city || null;
      result.isp = j.org || null;
      result.asn = j.asn || null;
    }
  } catch (_) {}
  try {
    // EDNS-client-subnet echo — reveals approximate DNS resolver location.
    // If Cloudflare sees a different country than the IP API, DNS is leaking.
    const r = await fetch("https://cloudflare-dns.com/dns-query?name=whoami.cloudflare&type=TXT", {
      cache: "no-store",
      headers: { accept: "application/dns-json" },
      signal: ctrl.signal
    });
    if (r.ok) {
      const j = await r.json();
      if (j.Answer) {
        for (const a of j.Answer) {
          if (a.data) result.dns.push(a.data.replace(/"/g, ""));
        }
      }
    }
  } catch (_) {}
  clearTimeout(timer);
  const config = await getConfig();
  // Warnings
  if (config.useProxy && config.proxy?.host) {
    if (!result.ip) {
      result.warnings.push("Could not reach leak-test server through proxy — check proxy connectivity.");
    }
  } else {
    result.warnings.push("No proxy configured. Sites see your real IP and ISP.");
  }
  if (config.selectedCountry && result.country) {
    const map = {
      us: "United States", gb: "United Kingdom", de: "Germany",
      nl: "Netherlands", fr: "France", ch: "Switzerland", se: "Sweden",
      ca: "Canada", au: "Australia", jp: "Japan", sg: "Singapore",
      br: "Brazil", in: "India", ae: "United Arab Emirates", ro: "Romania"
    };
    const expected = map[config.selectedCountry];
    if (expected && !result.country.toLowerCase().includes(expected.toLowerCase())) {
      result.warnings.push(
        "IP country (" + result.country + ") does not match picked country (" + expected + "). " +
        "Your VPN/Tor is exiting somewhere else."
      );
    }
  }
  return result;
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

// Add a hostname to the proxy bypass list so Chrome connects to that
// site directly even while the proxy is on. Useful for Google / Cloudflare
// sites that block Tor exit nodes with CAPTCHAs.
async function bypassProxyForSite(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, error: "No hostname" };
  const current = await getConfig();
  const base = current.proxy?.bypassList || [
    "localhost",
    "127.0.0.1",
    "<local>"
  ];
  // chrome.proxy accepts entries like "*.example.com" to cover subdomains.
  const entries = new Set(base);
  entries.add(host);
  entries.add("*." + host);
  const next = {
    ...current,
    proxy: { ...current.proxy, bypassList: Array.from(entries) }
  };
  await chrome.storage.local.set({ config: next });
  if (next.useProxy) await applyProxySettings();
  broadcastConfig(next);
  return { ok: true, bypassList: next.proxy.bypassList };
}

async function unbypassProxyForSite(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, error: "No hostname" };
  const current = await getConfig();
  const base = current.proxy?.bypassList || [];
  const filtered = base.filter(
    (e) => e !== host && e !== "*." + host
  );
  const next = {
    ...current,
    proxy: { ...current.proxy, bypassList: filtered }
  };
  await chrome.storage.local.set({ config: next });
  if (next.useProxy) await applyProxySettings();
  broadcastConfig(next);
  return { ok: true, bypassList: next.proxy.bypassList };
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

// ---------- DNR match counting (unpacked installs only) ----------
// onRuleMatchedDebug only fires when the extension is loaded unpacked. In a
// packaged Chrome Web Store install the counters for ads/miners/trackers will
// stay at 0; the blocking itself still works via the static rulesets.
try {
  if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      const rs = info?.rule?.rulesetId || "";
      const req = info?.request || {};
      let host = "";
      try {
        host = new URL(req.documentUrl || req.initiator || req.url || "")
          .hostname;
      } catch (_) {}
      const target = (() => {
        try {
          return new URL(req.url || "").hostname;
        } catch (_) {
          return req.url || "";
        }
      })();
      if (rs === "ads_rules") recordActivity(host, "adsBlocked", target);
      else if (rs === "mining_rules")
        recordActivity(host, "minersBlocked", target);
      else if (rs === "privacy_rules")
        recordActivity(host, "trackersBlocked", target);
    });
  }
} catch (_) {}

// ==================== PROFILE SYSTEM ====================

const PROFILE_STORAGE_KEY = "profiles_v1";
const TAB_PROFILE_MAP_KEY = "tabProfileMap";

const PROFILE_UA_POOLS = {
  windows: [
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36", platform: "Win32" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", platform: "Win32" }
  ],
  macos: [
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", platform: "MacIntel" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "MacIntel" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", platform: "MacIntel" }
  ],
  linux: [
    { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", platform: "Linux x86_64" },
    { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", platform: "Linux x86_64" },
    { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", platform: "Linux x86_64" }
  ]
};

const PROFILE_WEBGL_PRESETS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" }
];

function generateProfileId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getProfiles() {
  const r = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
  return Array.isArray(r[PROFILE_STORAGE_KEY]) ? r[PROFILE_STORAGE_KEY] : [];
}

async function saveProfiles(profiles) {
  await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profiles });
}

let tabProfileMap = {};
const tabProfileMapReady = chrome.storage.session.get(TAB_PROFILE_MAP_KEY).then((r) => {
  if (r && r[TAB_PROFILE_MAP_KEY]) tabProfileMap = r[TAB_PROFILE_MAP_KEY];
});

function persistTabProfileMap() {
  chrome.storage.session.set({ [TAB_PROFILE_MAP_KEY]: tabProfileMap }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabProfileMap[tabId]) {
    delete tabProfileMap[tabId];
    persistTabProfileMap();
  }
});

function buildConfigFromProfile(profile, baseConfig) {
  if (!profile) return baseConfig;
  const fp = profile.fingerprint || {};
  const cfg = { ...baseConfig };

  cfg.rotateFingerprint = false;
  cfg.perTabFingerprint = false;
  cfg.enabled = true;

  // Platform / OS
  const platformMap = { windows: "Win32", macos: "MacIntel", linux: "Linux x86_64" };
  cfg.platform = platformMap[profile.os || "windows"] || "Win32";

  // User Agent — stable per profile using id as seed
  if (fp.userAgent === "manual" && fp.userAgentValue) {
    cfg.userAgent = fp.userAgentValue;
  } else {
    const pool = PROFILE_UA_POOLS[profile.os || "windows"] || PROFILE_UA_POOLS.windows;
    const seed = parseInt(profile.id.replace(/\D/g, "").slice(-6) || "0") % pool.length;
    cfg.userAgent = pool[seed].ua;
    cfg.platform = pool[seed].platform;
  }
  cfg.spoofUA = true;

  // Canvas
  cfg.blockCanvas = fp.canvas !== "real";
  cfg._canvasMode = fp.canvas || "noise";

  // WebGL
  cfg.blockWebGL = fp.webgl !== "real";
  cfg._webglMode = fp.webgl || "noise";
  if (fp.webglInfo === "manual" && fp.webglVendor) {
    cfg._gpuVendor = fp.webglVendor;
    cfg._gpuRenderer = fp.webglRenderer || "";
  } else {
    // Stable GPU based on profile id
    const gi = parseInt(profile.id.slice(-4), 36) % PROFILE_WEBGL_PRESETS.length;
    cfg._gpuVendor = PROFILE_WEBGL_PRESETS[gi].vendor;
    cfg._gpuRenderer = PROFILE_WEBGL_PRESETS[gi].renderer;
  }

  // WebGPU, ClientRects, DoNotTrack
  cfg._webgpu = Boolean(fp.webgpu);
  cfg._clientRects = fp.clientRects || "real";
  cfg._doNotTrack = Boolean(fp.doNotTrack);

  // Timezone
  cfg.spoofTimezone = true;
  if (fp.timezone === "manual") {
    cfg.timezone = fp.timezoneValue || "UTC";
    cfg.localeOffsetMinutes = typeof fp.timezoneOffset === "number" ? fp.timezoneOffset : 0;
  }

  // Language
  if (fp.language === "manual" && fp.languageValue) {
    cfg.language = fp.languageValue;
    cfg.languages = [fp.languageValue, fp.languageValue.split("-")[0]].filter(Boolean);
  }

  // Geolocation
  cfg.spoofGeo = true;
  if (fp.geolocation === "manual") {
    cfg.geo = {
      latitude: Number(fp.geoLat) || 0,
      longitude: Number(fp.geoLng) || 0,
      accuracy: Number(fp.geoAccuracy) || 50,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null
    };
  }

  // Hardware
  cfg.blockHardware = true;
  if (fp.cpuCores === "manual") cfg.hardwareConcurrency = Number(fp.cpuCoresValue) || 4;
  if (fp.ram === "manual") cfg.deviceMemory = Number(fp.ramValue) || 8;

  // Screen
  if (fp.screen === "manual") {
    cfg.blockScreen = true;
    cfg.screen = {
      width: Number(fp.screenWidth) || 1920,
      height: Number(fp.screenHeight) || 1080,
      availWidth: Number(fp.screenWidth) || 1920,
      availHeight: (Number(fp.screenHeight) || 1080) - 40,
      colorDepth: 24, pixelDepth: 24
    };
  }

  // Audio
  cfg.blockAudio = fp.audio !== "real";
  cfg._audioMode = fp.audio || "noise";

  // Fonts
  cfg.blockFonts = true;

  // Media Devices
  cfg._mediaDevices = fp.mediaDevices || "real";
  cfg._cameras = typeof fp.cameras === "number" ? fp.cameras : 1;
  cfg._microphones = typeof fp.microphones === "number" ? fp.microphones : 1;
  cfg._speakers = typeof fp.speakers === "number" ? fp.speakers : 1;

  // Device Name
  cfg._deviceName = fp.deviceName || "off";
  cfg._deviceNameValue = fp.deviceNameValue || "";

  // Ports
  cfg._ports = fp.ports || "real";
  cfg._blockedPorts = Array.isArray(fp.blockedPorts) ? fp.blockedPorts : [3389, 5938];

  // WebRTC mode
  cfg._webrtcMode = fp.webrtc || "altered";
  cfg._webrtcIP = fp.webrtcIP || "";

  // Storage / Cookies
  cfg.blockStorage = Boolean(fp.blockStorage);
  cfg.blockCookies = Boolean(fp.blockCookies);

  // Profile metadata
  cfg._profileId = profile.id;
  cfg._profileName = profile.name;

  return cfg;
}

// Profile CRUD helpers
async function createProfile(data) {
  const profiles = await getProfiles();
  const now = Date.now();
  const profile = {
    id: generateProfileId(),
    name: data.name || "Profile " + (profiles.length + 1),
    status: data.status || "new",
    tags: Array.isArray(data.tags) ? data.tags : [],
    notes: data.notes || "",
    os: data.os || "windows",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    fingerprint: data.fingerprint || getDefaultFingerprint(),
    proxy: data.proxy || getDefaultProxy(),
    cookies: data.cookies || [],
    localStorageData: data.localStorageData || {}
  };
  profiles.push(profile);
  await saveProfiles(profiles);
  return profile;
}

async function updateProfile(id, data) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  profiles[idx] = { ...profiles[idx], ...data, id, updatedAt: Date.now() };
  if (data.fingerprint) profiles[idx].fingerprint = { ...profiles[idx].fingerprint, ...data.fingerprint };
  if (data.proxy) profiles[idx].proxy = { ...profiles[idx].proxy, ...data.proxy };
  await saveProfiles(profiles);
  return profiles[idx];
}

async function deleteProfile(id, hard = false) {
  const profiles = await getProfiles();
  if (hard) {
    const next = profiles.filter((p) => p.id !== id);
    await saveProfiles(next);
  } else {
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx !== -1) {
      profiles[idx].deletedAt = Date.now();
      await saveProfiles(profiles);
    }
  }
  // Unassign from all tabs
  for (const [tabId, pid] of Object.entries(tabProfileMap)) {
    if (pid === id) delete tabProfileMap[tabId];
  }
  persistTabProfileMap();
}

async function duplicateProfile(id) {
  const profiles = await getProfiles();
  const src = profiles.find((p) => p.id === id);
  if (!src) return null;
  const now = Date.now();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = generateProfileId();
  copy.name = src.name + " (copy)";
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.deletedAt = null;
  profiles.push(copy);
  await saveProfiles(profiles);
  return copy;
}

async function restoreProfile(id) {
  return updateProfile(id, { deletedAt: null });
}

function getDefaultFingerprint() {
  return {
    userAgent: "auto", userAgentValue: "",
    canvas: "noise",
    webgl: "noise", webglInfo: "manual",
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webgpu: false,
    clientRects: "real",
    timezone: "auto", timezoneValue: "America/New_York", timezoneOffset: 300,
    language: "auto", languageValue: "en-US",
    geolocation: "auto", geoLat: 40.7128, geoLng: -74.006, geoAccuracy: 50,
    cpuCores: "manual", cpuCoresValue: 4,
    ram: "manual", ramValue: 8,
    screen: "manual", screenWidth: 1920, screenHeight: 1080,
    audio: "noise",
    fonts: "real",
    mediaDevices: "real", cameras: 1, microphones: 1, speakers: 1,
    deviceName: "off", deviceNameValue: "",
    ports: "block", blockedPorts: [3389, 5938],
    doNotTrack: false,
    webrtc: "altered", webrtcIP: "",
    blockStorage: false, blockCookies: false
  };
}

function getDefaultProxy() {
  return { enabled: false, scheme: "socks5", host: "", port: 1080, username: "", password: "", rotationUrl: "", bypassList: [] };
}

// Cookie export/import per profile
async function exportProfileCookies(profileId) {
  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  return profile ? profile.cookies || [] : [];
}

async function importProfileCookies(profileId, cookies) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex((p) => p.id === profileId);
  if (idx === -1) return false;
  profiles[idx].cookies = Array.isArray(cookies) ? cookies : [];
  profiles[idx].updatedAt = Date.now();
  await saveProfiles(profiles);
  return true;
}

async function captureTabCookies(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (!url.startsWith("http")) return [];
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      sameSite: c.sameSite, expirationDate: c.expirationDate,
      storeId: c.storeId
    }));
  } catch (_) {
    return [];
  }
}

async function injectProfileCookies(profileId, tabId) {
  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile || !profile.cookies || !profile.cookies.length) return 0;
  let n = 0;
  for (const c of profile.cookies) {
    try {
      const protocol = c.secure ? "https://" : "http://";
      const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      await chrome.cookies.set({
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
  return n;
}

// Apply profile proxy
async function applyProfileProxy(profile) {
  const px = profile.proxy;
  if (!px || !px.enabled || !px.host) {
    await chrome.proxy.settings.clear({ scope: "regular" }).catch(() => {});
    return;
  }
  const cfg = {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: px.scheme || "socks5", host: px.host, port: Number(px.port) || 1080 },
      bypassList: Array.isArray(px.bypassList) && px.bypassList.length
        ? px.bypassList
        : ["localhost", "127.0.0.1", "<local>"]
    }
  };
  await chrome.proxy.settings.set({ value: cfg, scope: "regular" }).catch(() => {});
}

// Handle profile message types added to the central listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith("PROFILE_")) return false;
  (async () => {
    try {
      if (msg.type === "PROFILE_LIST") {
        const profiles = await getProfiles();
        const showDeleted = Boolean(msg.showDeleted);
        sendResponse({ ok: true, profiles: showDeleted ? profiles : profiles.filter((p) => !p.deletedAt) });

      } else if (msg.type === "PROFILE_GET") {
        const profiles = await getProfiles();
        const p = profiles.find((p) => p.id === msg.id);
        sendResponse({ ok: Boolean(p), profile: p || null });

      } else if (msg.type === "PROFILE_CREATE") {
        const profile = await createProfile(msg.data || {});
        sendResponse({ ok: true, profile });

      } else if (msg.type === "PROFILE_UPDATE") {
        const profile = await updateProfile(msg.id, msg.data || {});
        sendResponse({ ok: Boolean(profile), profile });

      } else if (msg.type === "PROFILE_DELETE") {
        await deleteProfile(msg.id, msg.hard === true);
        sendResponse({ ok: true });

      } else if (msg.type === "PROFILE_RESTORE") {
        const profile = await restoreProfile(msg.id);
        sendResponse({ ok: Boolean(profile), profile });

      } else if (msg.type === "PROFILE_DUPLICATE") {
        const profile = await duplicateProfile(msg.id);
        sendResponse({ ok: Boolean(profile), profile });

      } else if (msg.type === "PROFILE_ASSIGN_TAB") {
        await tabProfileMapReady;
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) { sendResponse({ ok: false, error: "no tabId" }); return; }
        if (msg.profileId) {
          tabProfileMap[tabId] = msg.profileId;
          const profiles = await getProfiles();
          const profile = profiles.find((p) => p.id === msg.profileId && !p.deletedAt);
          if (profile && profile.proxy && profile.proxy.enabled) {
            await applyProfileProxy(profile);
          }
        } else {
          delete tabProfileMap[tabId];
          await applyProxySettings();
        }
        persistTabProfileMap();
        // Push updated config to the tab
        const newCfg = await getConfigForTab(tabId);
        chrome.tabs.sendMessage(tabId, { type: "CONFIG_UPDATE", config: newCfg }).catch(() => {});
        await updateBadge(tabId);
        sendResponse({ ok: true, tabId, profileId: msg.profileId || null });

      } else if (msg.type === "PROFILE_GET_TAB") {
        await tabProfileMapReady;
        const tabId = msg.tabId || sender?.tab?.id;
        const profileId = tabId ? tabProfileMap[tabId] || null : null;
        let profile = null;
        if (profileId) {
          const profiles = await getProfiles();
          profile = profiles.find((p) => p.id === profileId) || null;
        }
        sendResponse({ ok: true, profileId, profile });

      } else if (msg.type === "PROFILE_EXPORT_COOKIES") {
        const cookies = await exportProfileCookies(msg.profileId);
        sendResponse({ ok: true, cookies });

      } else if (msg.type === "PROFILE_IMPORT_COOKIES") {
        const ok = await importProfileCookies(msg.profileId, msg.cookies);
        sendResponse({ ok });

      } else if (msg.type === "PROFILE_CAPTURE_COOKIES") {
        const tabId = msg.tabId || sender?.tab?.id;
        const cookies = await captureTabCookies(tabId);
        if (msg.profileId && cookies.length) await importProfileCookies(msg.profileId, cookies);
        sendResponse({ ok: true, cookies, count: cookies.length });

      } else if (msg.type === "PROFILE_INJECT_COOKIES") {
        const tabId = msg.tabId || sender?.tab?.id;
        const n = await injectProfileCookies(msg.profileId, tabId);
        sendResponse({ ok: true, count: n });

      } else if (msg.type === "PROFILE_WEBGL_PRESETS") {
        sendResponse({ ok: true, presets: PROFILE_WEBGL_PRESETS });

      } else if (msg.type === "PROFILE_OPEN_WINDOW") {
        const result = await openProfileWindow(msg.profileId);
        sendResponse(result);

      } else if (msg.type === "PROFILE_SAVE_SESSION") {
        const result = await saveProfileSession(msg.profileId, msg.windowId || null);
        sendResponse(result);

      } else if (msg.type === "PROFILE_CLOSE_WINDOW") {
        const result = await closeProfileWindow(msg.profileId);
        sendResponse(result);

      } else if (msg.type === "PROFILE_GET_WINDOWS") {
        sendResponse({ ok: true, windows: await getOpenProfileWindows() });

      } else {
        sendResponse({ ok: false, error: "unknown profile message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});

// ==================== WINDOW & SESSION MANAGEMENT ====================

const WIN_PROFILE_KEY = "windowProfiles";
let windowProfiles = {};  // { windowId: profileId }

const winProfileReady = chrome.storage.session.get(WIN_PROFILE_KEY).then((r) => {
  if (r && r[WIN_PROFILE_KEY]) windowProfiles = r[WIN_PROFILE_KEY];
});

function persistWindowProfiles() {
  chrome.storage.session.set({ [WIN_PROFILE_KEY]: windowProfiles }).catch(() => {});
}

// When a new tab is created inside a profile window, auto-assign the profile to it.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.windowId || !tab.id) return;
  await winProfileReady;
  const profileId = windowProfiles[tab.windowId];
  if (profileId) {
    await tabProfileMapReady;
    tabProfileMap[tab.id] = profileId;
    persistTabProfileMap();
  }
});

// When a tab is removed inside a profile window, clean up the tab→profile map.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tabProfileMapReady;
  if (tabProfileMap[tabId]) {
    delete tabProfileMap[tabId];
    persistTabProfileMap();
  }
});

// When a window gains focus, switch the proxy to match that window's profile.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await winProfileReady;
  const profileId = windowProfiles[windowId];
  if (profileId) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
    if (profile) {
      await applyProfileProxy(profile);
      // Sync HTTP headers to match this profile's UA
      const cfg = buildConfigFromProfile(profile, await getConfig());
      await syncHeadersWithConfig(cfg);
    }
  } else {
    await applyProxySettings();
    await syncHeadersWithConfig();
  }
  // Refresh badge for all tabs in the focused window
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const t of tabs) if (t.id) updateBadge(t.id);
  } catch (_) {}
});

// When a profile window is closed, auto-save its session and clean up.
chrome.windows.onRemoved.addListener(async (windowId) => {
  await winProfileReady;
  const profileId = windowProfiles[windowId];
  if (!profileId) return;

  // Auto-save session before cleanup — but we can't query tabs of a closed window,
  // so we do a best-effort save if the window is still accessible.
  try {
    const tabs = await chrome.tabs.query({ windowId });
    if (tabs.length) await saveProfileSession(profileId, windowId, tabs);
  } catch (_) {}

  delete windowProfiles[windowId];
  persistWindowProfiles();

  // Clean up tab→profile entries for this window
  await tabProfileMapReady;
  for (const [tabId, pid] of Object.entries(tabProfileMap)) {
    if (pid === profileId) delete tabProfileMap[Number(tabId)];
  }
  persistTabProfileMap();
});

// Open a profile in a dedicated new Chrome window.
// If the profile already has an open window, focus it instead of opening again.
async function openProfileWindow(profileId) {
  await winProfileReady;

  // Check if window already open → just focus it
  for (const [wid, pid] of Object.entries(windowProfiles)) {
    if (pid === profileId) {
      const windowId = Number(wid);
      try { await chrome.windows.update(windowId, { focused: true }); } catch (_) {}
      return { ok: true, windowId, existing: true };
    }
  }

  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId && !p.deletedAt);
  if (!profile) return { ok: false, error: "Profile not found" };

  // Build the initial URL list from saved session, or open new tab
  const session = profile.session || {};
  let urls = [];
  if (Array.isArray(session.tabs) && session.tabs.length) {
    urls = session.tabs
      .map((t) => t.url)
      .filter((u) => u && (u.startsWith("http://") || u.startsWith("https://")));
  }
  if (!urls.length) urls = ["about:newtab"];

  // Create the window
  let win;
  try {
    win = await chrome.windows.create({ url: urls, type: "normal", focused: true });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  // Register window → profile
  windowProfiles[win.id] = profileId;
  persistWindowProfiles();

  // Register all tabs → profile
  await tabProfileMapReady;
  const tabs = await chrome.tabs.query({ windowId: win.id });
  for (const t of tabs) {
    if (t.id) tabProfileMap[t.id] = profileId;
  }
  persistTabProfileMap();

  // Apply this profile's proxy
  if (profile.proxy && profile.proxy.enabled && profile.proxy.host) {
    await applyProfileProxy(profile);
  }

  // Sync UA / Accept-Language headers for this profile
  const cfg = buildConfigFromProfile(profile, await getConfig());
  await syncHeadersWithConfig(cfg);

  // Update badge for each tab
  for (const t of tabs) if (t.id) await updateBadge(t.id);

  return { ok: true, windowId: win.id, tabCount: tabs.length, restored: urls.length };
}

// Capture all open tabs from a profile's window and save them to the profile.
async function saveProfileSession(profileId, windowId, cachedTabs) {
  await winProfileReady;

  let wId = windowId;
  if (!wId) {
    for (const [wid, pid] of Object.entries(windowProfiles)) {
      if (pid === profileId) { wId = Number(wid); break; }
    }
  }
  if (!wId) return { ok: false, error: "No open window for this profile" };

  let tabs = cachedTabs;
  if (!tabs) {
    try { tabs = await chrome.tabs.query({ windowId: wId }); } catch (_) { tabs = []; }
  }

  const sessionTabs = tabs
    .map((t) => ({
      url: t.url || "",
      title: t.title || "",
      pinned: Boolean(t.pinned),
      active: Boolean(t.active)
    }))
    .filter((t) => t.url && t.url.startsWith("http"));

  const session = {
    tabs: sessionTabs,
    totalTabs: tabs.length,
    lastSaved: Date.now(),
    windowId: wId
  };

  await updateProfile(profileId, { session });
  return { ok: true, session, count: sessionTabs.length };
}

// Close a profile window and save its session.
async function closeProfileWindow(profileId) {
  await winProfileReady;
  for (const [wid, pid] of Object.entries(windowProfiles)) {
    if (pid === profileId) {
      const windowId = Number(wid);
      await saveProfileSession(profileId, windowId);
      try { await chrome.windows.remove(windowId); } catch (_) {}
      return { ok: true };
    }
  }
  return { ok: false, error: "No open window for this profile" };
}

// Return a map of { profileId: windowId } for all currently open profile windows.
async function getOpenProfileWindows() {
  await winProfileReady;
  const result = {};
  for (const [wid, pid] of Object.entries(windowProfiles)) {
    result[pid] = Number(wid);
  }
  return result;
}
