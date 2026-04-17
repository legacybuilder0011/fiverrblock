// popup.js - Reads current config, renders form, saves updates.

const FIELDS = [
  "enabled",
  "blockCookies",
  "blockStorage",
  "spoofGeo",
  "spoofTimezone",
  "timezone",
  "localeOffsetMinutes",
  "language",
  "spoofUA",
  "rotateFingerprint",
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
  "blockBattery"
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

  // Purge cookies button
  $("purgeNow").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "PURGE_COOKIES" }, () => {
      const btn = $("purgeNow");
      const old = btn.textContent;
      btn.textContent = "Cookies purged";
      setTimeout(() => (btn.textContent = old), 1500);
    });
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
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
