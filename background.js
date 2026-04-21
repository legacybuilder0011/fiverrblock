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
  const config = await getConfig();
  if (!config.perTabFingerprint || !tabId) return config;
  const fp = await getOrCreateTabFingerprint(tabId);
  return { ...config, ...fp, rotateFingerprint: false };
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
