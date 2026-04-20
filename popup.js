// popup.js - Reads current config, renders form, saves updates.

const FIELDS = [
  "enabled",
  "blockCookies",
  "blockStorage",
  "blockAds",
  "blockMining",
  "spoofGeo",
  "spoofTimezone",
  "timezone",
  "localeOffsetMinutes",
  "language",
  "spoofUA",
  "rotateFingerprint",
  "perTabFingerprint",
  "userAgent",
  "platform",
  "hardwareConcurrency",
  "blockHardware",
  "blockScreen",
  "blockPlugins",
  "blockFonts",
  "blockCanvas",
  "blockWebGL",
  "blockAudio",
  "blockBattery",
  "selectedCountry"
];

function $(id) {
  return document.getElementById(id);
}

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
      resolve(res?.config || {});
    });
  });
}

function populate(config) {
  for (const id of FIELDS) {
    const el = $(id);
    if (!el) continue;
    const val = config[id];
    if (el.type === "checkbox") {
      el.checked = Boolean(val);
    } else {
      el.value = val ?? "";
    }
  }
  // Nested: geo + screen
  if (config.geo) {
    $("latitude").value = config.geo.latitude ?? "";
    $("longitude").value = config.geo.longitude ?? "";
    $("accuracy").value = config.geo.accuracy ?? 50;
  }
  if (config.screen) {
    $("screenWidth").value = config.screen.width ?? "";
    $("screenHeight").value = config.screen.height ?? "";
  }
  if (config.proxy) {
    $("proxyScheme").value = config.proxy.scheme || "socks5";
    $("proxyHost").value = config.proxy.host || "";
    $("proxyPort").value = config.proxy.port || 1080;
  }
  $("useProxy").checked = Boolean(config.useProxy);
  if (config.selectedCountry) {
    $("countryPicker").value = config.selectedCountry;
  }
  updateStatus(config.enabled);
  updateProxyState(config);
}

function updateProxyState(config) {
  const chip = $("proxyState");
  const detail = $("proxyStateDetail");
  const connectBtn = $("connectProxy");
  const disconnectBtn = $("disconnectProxy");
  chip.classList.remove("green", "blue", "gray", "red", "amber");
  if (!config.enabled) {
    chip.textContent = "Shield off";
    chip.classList.add("gray");
    detail.textContent = "";
    disconnectBtn.disabled = true;
    connectBtn.disabled = true;
  } else if (config.useProxy && config.proxy?.host) {
    chip.textContent = "Connected";
    chip.classList.add("blue");
    detail.textContent =
      (config.proxy.scheme || "socks5") +
      "://" +
      config.proxy.host +
      ":" +
      config.proxy.port;
    disconnectBtn.disabled = false;
    connectBtn.disabled = false;
  } else {
    chip.textContent = "Direct connection";
    chip.classList.add("gray");
    detail.textContent = "";
    disconnectBtn.disabled = true;
    connectBtn.disabled = false;
  }
}

function updateStatus(enabled) {
  const dot = $("status-dot");
  const text = $("status-text");
  if (enabled) {
    dot.classList.add("on");
    text.textContent = "Protection active";
  } else {
    dot.classList.remove("on");
    text.textContent = "Protection disabled";
  }
}

function collect() {
  const config = {};
  for (const id of FIELDS) {
    const el = $(id);
    if (!el) continue;
    if (el.type === "checkbox") {
      config[id] = el.checked;
    } else if (el.type === "number") {
      const n = Number(el.value);
      config[id] = Number.isFinite(n) ? n : 0;
    } else {
      config[id] = el.value;
    }
  }
  config.geo = {
    latitude: Number($("latitude").value) || 0,
    longitude: Number($("longitude").value) || 0,
    accuracy: Number($("accuracy").value) || 50,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null
  };
  config.screen = {
    width: Number($("screenWidth").value) || 1920,
    height: Number($("screenHeight").value) || 1080,
    availWidth: Number($("screenWidth").value) || 1920,
    availHeight: (Number($("screenHeight").value) || 1080) - 40,
    colorDepth: 24,
    pixelDepth: 24
  };
  config.languages = [config.language || "en-US", "en"];
  // Proxy edits go through CONNECT_PROXY, not SET_CONFIG, but send the
  // latest host/port/scheme so the background keeps the draft in storage.
  config.proxy = {
    scheme: $("proxyScheme").value,
    host: $("proxyHost").value.trim(),
    port: Number($("proxyPort").value) || 1080,
    bypassList: ["localhost", "127.0.0.1", "<local>"]
  };
  return config;
}

function currentProxyFromUI() {
  return {
    scheme: $("proxyScheme").value,
    host: $("proxyHost").value.trim(),
    port: Number($("proxyPort").value) || 1080,
    bypassList: ["localhost", "127.0.0.1", "<local>"]
  };
}

function save(reload) {
  const config = collect();
  chrome.runtime.sendMessage({ type: "SET_CONFIG", config }, (res) => {
    if (!res?.ok) return;
    updateStatus(res.config.enabled);
    if (reload) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
      });
    }
  });
}

async function getActiveTabHost() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url) return resolve({ host: "", url: "", tabId: null });
      try {
        const u = new URL(tab.url);
        resolve({
          host: u.hostname.toLowerCase().replace(/^www\./, ""),
          url: tab.url,
          tabId: tab.id
        });
      } catch (_) {
        resolve({ host: "", url: tab.url, tabId: tab.id });
      }
    });
  });
}

function hostMatchesBypassList(host, list) {
  if (!host || !Array.isArray(list)) return false;
  for (const entry of list) {
    const e = String(entry || "").toLowerCase();
    if (!e) continue;
    if (e === host) return true;
    if (e.startsWith("*.") && (host === e.slice(2) || host.endsWith(e.slice(1)))) {
      return true;
    }
  }
  return false;
}

function renderSiteStrip(config, active) {
  const strip = document.querySelector(".site-strip");
  const hostEl = $("siteHost");
  const stateEl = $("siteState");
  const btn = $("toggleSite");
  const bypassBtn = $("toggleProxyBypass");
  if (!active.host) {
    hostEl.textContent = "(special page)";
    stateEl.textContent =
      "Shield is not active on chrome:// and extension pages";
    btn.disabled = true;
    btn.textContent = "—";
    bypassBtn.hidden = true;
    strip.classList.remove("paused");
    return;
  }
  const paused = (config.siteAllowList || []).includes(active.host);
  hostEl.textContent = active.host;
  if (paused) {
    stateEl.textContent =
      "Paused — cookies & storage allowed, fingerprint still spoofed";
    btn.textContent = "Resume here";
    btn.classList.add("primary");
    strip.classList.add("paused");
  } else {
    stateEl.textContent = "Full shield active on this site";
    btn.textContent = "Pause here";
    btn.classList.remove("primary");
    strip.classList.remove("paused");
  }
  btn.disabled = false;

  // Only show the proxy-bypass button when a proxy is actually connected,
  // since otherwise it has no effect.
  if (config.useProxy && config.proxy?.host) {
    bypassBtn.hidden = false;
    const bypassed = hostMatchesBypassList(
      active.host,
      config.proxy?.bypassList
    );
    bypassBtn.textContent = bypassed ? "Route through proxy" : "Skip proxy here";
    bypassBtn.dataset.bypassed = bypassed ? "1" : "0";
  } else {
    bypassBtn.hidden = true;
  }
}

// ----- Live activity -----
const CATEGORY_LABELS = {
  adsBlocked: "Ads",
  minersBlocked: "Miners",
  trackersBlocked: "Trackers",
  cookiesBlocked: "Cookies",
  canvasAccess: "Canvas",
  webglAccess: "WebGL",
  audioAccess: "Audio",
  geoAccess: "Geo",
  batteryAccess: "Battery",
  pluginsAccess: "Plugins",
  fontsAccess: "Fonts",
  screenAccess: "Screen",
  uaAccess: "User-Agent",
  hardwareAccess: "Hardware",
  timezoneAccess: "Timezone",
  storageAccess: "Storage"
};

function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderActivity(host, act) {
  const hostEl = $("activityHost");
  hostEl.textContent = host || "all sites";

  const bucket = host ? act.site : act.global;
  const counters = bucket?.counters || {};
  const total = Object.values(counters).reduce((a, b) => a + (b || 0), 0);

  const empty = $("activityEmpty");
  const grid = $("counterGrid");
  const feed = $("eventFeed");

  if (!total) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  // Counter tiles
  grid.innerHTML = "";
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const n = counters[key] || 0;
    const tile = document.createElement("div");
    tile.className = "counter" + (n > 0 ? " active" : "");
    tile.innerHTML =
      '<span class="label">' +
      escapeHtml(label) +
      '</span><span class="count">' +
      n +
      "</span>";
    grid.appendChild(tile);
  }

  // Recent events feed
  feed.innerHTML = "";
  const events = (bucket?.recent || []).slice(0, 15);
  if (!events.length) {
    const li = document.createElement("li");
    li.className = "event-empty";
    li.textContent = "Waiting for activity…";
    feed.appendChild(li);
    return;
  }
  for (const e of events) {
    const li = document.createElement("li");
    const label = CATEGORY_LABELS[e.type] || e.type;
    li.innerHTML =
      '<span class="ev-kind">' +
      escapeHtml(label) +
      '</span><span class="ev-detail">' +
      escapeHtml(e.detail || "") +
      '</span><span class="ev-time">' +
      escapeHtml(relTime(e.t)) +
      "</span>";
    feed.appendChild(li);
  }
}

function refreshActivity(host) {
  chrome.runtime.sendMessage({ type: "GET_ACTIVITY", host }, (res) => {
    if (chrome.runtime.lastError) return;
    if (!res?.ok) return;
    renderActivity(host, res.activity);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const config = await loadConfig();
  populate(config);

  const active = await getActiveTabHost();
  renderSiteStrip(config, active);

  // Initial render + 1s poll while the popup is open.
  refreshActivity(active.host);
  const activityTimer = setInterval(() => refreshActivity(active.host), 1000);
  window.addEventListener("unload", () => clearInterval(activityTimer));

  $("clearActivity").addEventListener("click", () => {
    chrome.runtime.sendMessage(
      { type: "CLEAR_ACTIVITY", host: active.host },
      () => refreshActivity(active.host)
    );
  });

  $("toggleSite").addEventListener("click", async () => {
    const cur = await loadConfig();
    const paused = (cur.siteAllowList || []).includes(active.host);
    const type = paused ? "RESUME_SITE" : "PAUSE_SITE";
    chrome.runtime.sendMessage({ type, hostname: active.host }, async () => {
      const fresh = await loadConfig();
      renderSiteStrip(fresh, active);
      // Reload the tab so the change takes effect immediately.
      if (active.tabId) chrome.tabs.reload(active.tabId);
    });
  });

  // Per-site proxy bypass (e.g. skip Tor for Google to avoid captcha hell).
  $("toggleProxyBypass").addEventListener("click", async () => {
    const bypassed = $("toggleProxyBypass").dataset.bypassed === "1";
    const type = bypassed ? "UNBYPASS_PROXY_SITE" : "BYPASS_PROXY_SITE";
    chrome.runtime.sendMessage({ type, hostname: active.host }, async () => {
      const fresh = await loadConfig();
      renderSiteStrip(fresh, active);
      if (active.tabId) chrome.tabs.reload(active.tabId);
    });
  });

  // Enable master toggle applies instantly.
  $("enabled").addEventListener("change", () => save(false));

  // Presets
  $("geoPreset").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    const [lat, lon, tz, off] = v.split(",");
    $("latitude").value = lat;
    $("longitude").value = lon;
    $("timezone").value = tz;
    $("localeOffsetMinutes").value = off;
  });

  // Save button
  $("save").addEventListener("click", () => save(true));

  // ---------- Per-tab fingerprint display ----------
  function renderTabFp(fp) {
    const card = $("tabFpCard");
    const box = $("tabFpDetails");
    if (!fp) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const rows = [
      ["Platform", fp.platform || "—"],
      ["Cores", fp.hardwareConcurrency || "—"],
      ["Memory", (fp.deviceMemory || "—") + " GB"],
      ["Screen", fp.screen ? fp.screen.width + " x " + fp.screen.height : "—"],
      ["Language", fp.language || "—"],
      ["GPU", fp._gpuRenderer ? fp._gpuRenderer.split(",")[0] : "—"]
    ];
    let html = "";
    for (const [label, val] of rows) {
      html +=
        '<span class="fp-label">' + escapeHtml(label) + '</span>' +
        '<span class="fp-val">' + escapeHtml(String(val)) + '</span>';
    }
    box.innerHTML = html;
  }

  function refreshTabFp() {
    if (!active.tabId || !$("perTabFingerprint").checked) {
      renderTabFp(null);
      return;
    }
    chrome.runtime.sendMessage({ type: "GET_TAB_FP", tabId: active.tabId }, (res) => {
      renderTabFp(res?.fp || null);
    });
  }

  refreshTabFp();

  $("perTabFingerprint").addEventListener("change", () => {
    save(false);
    setTimeout(refreshTabFp, 300);
  });

  $("newTabIdentity").addEventListener("click", async () => {
    if (!active.tabId) return;
    chrome.runtime.sendMessage(
      { type: "REGENERATE_TAB_FP", tabId: active.tabId },
      () => {
        const btn = $("newTabIdentity");
        const old = btn.textContent;
        btn.textContent = "Done!";
        setTimeout(() => (btn.textContent = old), 1200);
        refreshTabFp();
      }
    );
  });

  // Purge cookies button
  $("purgeNow").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PURGE_COOKIES" }, () => {
      const btn = $("purgeNow");
      const old = btn.textContent;
      btn.textContent = "Cookies purged";
      setTimeout(() => (btn.textContent = old), 1500);
    });
  });

  // Country picker
  // Each country profile: name, tor code, language, geo (lat,lon,tz,utcOffset),
  // and a realistic identity for that region (UA/platform/cores/screen).
  const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const COUNTRY_INFO = {
    us: { name: "United States", tor: "us", lang: "en-US", geo: "40.7128,-74.0060,America/New_York,300",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    gb: { name: "United Kingdom", tor: "gb", lang: "en-GB", geo: "51.5074,-0.1278,Europe/London,0",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    de: { name: "Germany", tor: "de", lang: "de-DE", geo: "52.5200,13.4050,Europe/Berlin,-60",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    nl: { name: "Netherlands", tor: "nl", lang: "nl-NL", geo: "52.3676,4.9041,Europe/Amsterdam,-60",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    fr: { name: "France", tor: "fr", lang: "fr-FR", geo: "48.8566,2.3522,Europe/Paris,-60",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    ch: { name: "Switzerland", tor: "ch", lang: "de-CH", geo: "47.3769,8.5417,Europe/Zurich,-60",
          ua: MAC_UA, platform: "MacIntel", cores: 8, w: 2560, h: 1440 },
    se: { name: "Sweden", tor: "se", lang: "sv-SE", geo: "59.3293,18.0686,Europe/Stockholm,-60",
          ua: MAC_UA, platform: "MacIntel", cores: 8, w: 1920, h: 1080 },
    ca: { name: "Canada", tor: "ca", lang: "en-CA", geo: "43.6532,-79.3832,America/Toronto,300",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    au: { name: "Australia", tor: "au", lang: "en-AU", geo: "-33.8688,151.2093,Australia/Sydney,-600",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    jp: { name: "Japan", tor: "jp", lang: "ja-JP", geo: "35.6762,139.6503,Asia/Tokyo,-540",
          ua: WIN_UA, platform: "Win32", cores: 4, w: 1366, h: 768 },
    sg: { name: "Singapore", tor: "sg", lang: "en-SG", geo: "1.3521,103.8198,Asia/Singapore,-480",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    br: { name: "Brazil", tor: "br", lang: "pt-BR", geo: "-23.5505,-46.6333,America/Sao_Paulo,180",
          ua: WIN_UA, platform: "Win32", cores: 4, w: 1366, h: 768 },
    in: { name: "India", tor: "in", lang: "en-IN", geo: "19.0760,72.8777,Asia/Kolkata,-330",
          ua: WIN_UA, platform: "Win32", cores: 4, w: 1366, h: 768 },
    ae: { name: "UAE", tor: "ae", lang: "ar-AE", geo: "25.2048,55.2708,Asia/Dubai,-240",
          ua: WIN_UA, platform: "Win32", cores: 8, w: 1920, h: 1080 },
    ro: { name: "Romania", tor: "ro", lang: "ro-RO", geo: "44.4268,26.1025,Europe/Bucharest,-120",
          ua: WIN_UA, platform: "Win32", cores: 4, w: 1920, h: 1080 },
    random: { name: "Random", tor: "", lang: "", geo: "" }
  };

  function applyCountryHint(code) {
    const info = COUNTRY_INFO[code];
    const old = document.querySelector(".country-hint");
    if (old) old.remove();
    if (!info) return;
    const hint = document.createElement("div");
    hint.className = "country-hint";
    if (code === "random") {
      hint.innerHTML =
        "<b>Random country:</b> Tor will auto-select the exit node. " +
        "Just launch Tor Browser and click <b>Connect &amp; test</b> below.";
    } else {
      hint.innerHTML =
        "<b>" + escapeHtml(info.name) + ":</b> " +
        "Using <b>Tor</b>? Add <code>ExitNodes {" + info.tor + "}</code> to your " +
        "<code>torrc</code> file to exit from this country. " +
        "Using a <b>VPN</b>? Connect to a " + escapeHtml(info.name) +
        " server in your VPN app, then enter the SOCKS5 address here. " +
        "Geolocation + timezone are set to match.";
    }
    $("countryPicker").parentElement.after(hint);
  }

  if (config.selectedCountry) {
    applyCountryHint(config.selectedCountry);
  }

  $("countryPicker").addEventListener("change", (e) => {
    const code = e.target.value;
    const info = COUNTRY_INFO[code];
    $("selectedCountry").value = code;
    applyCountryHint(code);
    if (!info) return;
    if (info.geo) {
      const [lat, lon, tz, off] = info.geo.split(",");
      $("latitude").value = lat;
      $("longitude").value = lon;
      $("timezone").value = tz;
      $("localeOffsetMinutes").value = off;
    }
    if (info.lang) {
      $("language").value = info.lang;
    }
    // Fill spoofed identity to a realistic device profile for the region.
    if (info.ua) {
      $("userAgent").value = info.ua;
      $("platform").value = info.platform;
      $("hardwareConcurrency").value = info.cores;
      $("screenWidth").value = info.w;
      $("screenHeight").value = info.h;
    }
    if (!$("proxyHost").value) {
      $("proxyPreset").value = "socks5,127.0.0.1,9150";
      $("proxyScheme").value = "socks5";
      $("proxyHost").value = "127.0.0.1";
      $("proxyPort").value = "9150";
    }
    save(false);
  });

  // Proxy preset filler
  $("proxyPreset").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    const [scheme, host, port] = v.split(",");
    $("proxyScheme").value = scheme;
    $("proxyHost").value = host;
    $("proxyPort").value = port;
  });

  // Connect & test — preflights before applying so the user never
  // loses internet because of a dead proxy.
  $("connectProxy").addEventListener("click", () => {
    const out = $("proxyResult");
    const chip = $("proxyState");
    chip.classList.remove("green", "blue", "gray", "red", "amber");
    chip.classList.add("amber");
    chip.textContent = "Connecting…";
    out.textContent = "Testing proxy before routing traffic…";
    $("connectProxy").disabled = true;
    chrome.runtime.sendMessage(
      { type: "CONNECT_PROXY", proxy: currentProxyFromUI() },
      async (res) => {
        const config = await loadConfig();
        updateProxyState(config);
        if (!res?.ok) {
          out.innerHTML =
            "<b>" +
            escapeHtml(res?.error || "Unknown error") +
            "</b><br>" +
            escapeHtml(res?.hint || "");
        } else {
          out.textContent =
            "Proxy connected. Sites will see IP: " + res.ip;
        }
      }
    );
  });

  // Disconnect button — always works even if current pages are broken.
  $("disconnectProxy").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "DISCONNECT_PROXY" }, async () => {
      const config = await loadConfig();
      updateProxyState(config);
      $("proxyResult").textContent =
        "Proxy disconnected. Chrome is back to direct connection.";
    });
  });

  // ---------- Leak test ----------
  $("runLeakTest").addEventListener("click", () => {
    const box = $("leakResult");
    const btn = $("runLeakTest");
    btn.disabled = true;
    btn.textContent = "Testing…";
    box.hidden = false;
    box.innerHTML = '<div class="hint" style="margin:0;">Running IP + DNS leak test…</div>';
    chrome.runtime.sendMessage({ type: "LEAK_TEST" }, (res) => {
      btn.disabled = false;
      btn.textContent = "Test for IP / DNS leaks";
      if (!res?.ok) {
        box.innerHTML = '<div class="leak-warn">Test failed: ' + escapeHtml(res?.error || "unknown") + '</div>';
        return;
      }
      const r = res.result;
      const rows = [
        ["IP address", r.ip || "unknown"],
        ["Country", r.country || "unknown"],
        ["City", r.city || "unknown"],
        ["ISP / Org", r.isp || "unknown"],
        ["ASN", r.asn || "unknown"]
      ];
      if (r.dns && r.dns.length) {
        rows.push(["DNS resolver", r.dns.join(", ")]);
      }
      let html = "";
      for (const [label, val] of rows) {
        html +=
          '<div class="leak-row"><span class="leak-label">' +
          escapeHtml(label) +
          '</span><span class="leak-val">' +
          escapeHtml(val) +
          '</span></div>';
      }
      if (r.warnings && r.warnings.length) {
        for (const w of r.warnings) {
          html += '<div class="leak-warn">⚠ ' + escapeHtml(w) + '</div>';
        }
      } else {
        html += '<div class="leak-ok">✓ No leaks detected. IP matches picked country.</div>';
      }
      box.innerHTML = html;
    });
  });

  // ---------- Identity Presets ----------
  const PRESET_FIELDS = [
    "selectedCountry", "userAgent", "platform", "hardwareConcurrency",
    "language", "timezone", "localeOffsetMinutes",
    "spoofGeo", "spoofTimezone", "spoofUA"
  ];

  async function loadPresets() {
    return new Promise((resolve) => {
      chrome.storage.local.get("presets", (r) => resolve(r.presets || []));
    });
  }

  async function savePresets(presets) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ presets }, resolve);
    });
  }

  function presetSnapshot(config) {
    const snap = {};
    for (const k of PRESET_FIELDS) snap[k] = config[k];
    snap.geo = config.geo ? { ...config.geo } : null;
    snap.screen = config.screen ? { ...config.screen } : null;
    return snap;
  }

  function presetSummary(snap) {
    const parts = [];
    if (snap.selectedCountry) parts.push(snap.selectedCountry.toUpperCase());
    if (snap.platform) parts.push(snap.platform);
    if (snap.screen) parts.push(snap.screen.width + "x" + snap.screen.height);
    return parts.join(" · ") || "Custom";
  }

  async function renderPresets() {
    const presets = await loadPresets();
    const config = await loadConfig();
    const list = $("presetList");
    list.innerHTML = "";
    if (!presets.length) {
      list.innerHTML = '<div class="hint" style="margin:0;text-align:center;">No saved presets yet</div>';
      return;
    }
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i];
      const isActive = config.activePreset === p.name;
      const card = document.createElement("div");
      card.className = "preset-card" + (isActive ? " active" : "");
      card.innerHTML =
        '<span class="preset-label">' + escapeHtml(p.name) + '</span>' +
        '<span class="preset-meta">' + escapeHtml(presetSummary(p.data)) + '</span>' +
        '<button class="preset-del" title="Delete">&times;</button>';
      card.querySelector(".preset-label").addEventListener("click", async () => {
        const cur = await loadConfig();
        const merged = { ...cur, ...p.data, activePreset: p.name };
        chrome.runtime.sendMessage({ type: "SET_CONFIG", config: merged }, async () => {
          const fresh = await loadConfig();
          populate(fresh);
          renderPresets();
        });
      });
      card.querySelector(".preset-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        const all = await loadPresets();
        all.splice(i, 1);
        await savePresets(all);
        renderPresets();
      });
      list.appendChild(card);
    }
  }

  $("savePreset").addEventListener("click", async () => {
    const name = $("presetName").value.trim();
    if (!name) { $("presetName").focus(); return; }
    const config = collect();
    const snap = presetSnapshot(config);
    const presets = await loadPresets();
    const existing = presets.findIndex((p) => p.name === name);
    if (existing >= 0) {
      presets[existing].data = snap;
    } else {
      presets.push({ name, data: snap });
    }
    await savePresets(presets);
    const cur = await loadConfig();
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { ...cur, activePreset: name }
    });
    $("presetName").value = "";
    renderPresets();
  });

  renderPresets();

  // ---------- Export / Import Config ----------
  $("exportConfig").addEventListener("click", async () => {
    const config = await loadConfig();
    const presets = await loadPresets();
    const blob = new Blob(
      [JSON.stringify({ config, presets }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "privacy-shield-config.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  $("importConfig").addEventListener("click", () => {
    $("importFile").click();
  });

  $("importFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.config) {
          chrome.runtime.sendMessage({ type: "SET_CONFIG", config: data.config }, async () => {
            if (Array.isArray(data.presets)) await savePresets(data.presets);
            const fresh = await loadConfig();
            populate(fresh);
            renderPresets();
            $("importConfig").textContent = "Imported!";
            setTimeout(() => ($("importConfig").textContent = "Import config"), 1500);
          });
        }
      } catch (err) {
        $("importConfig").textContent = "Invalid file";
        setTimeout(() => ($("importConfig").textContent = "Import config"), 1500);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
