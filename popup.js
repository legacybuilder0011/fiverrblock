// popup.js - Reads current config, renders form, saves updates.

const FIELDS = [
  "enabled",
  "useProxy",
  "blockCookies",
  "blockStorage",
  "spoofGeo",
  "spoofTimezone",
  "timezone",
  "localeOffsetMinutes",
  "language",
  "spoofUA",
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
  updateStatus(config.enabled);
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
  config.proxy = {
    scheme: $("proxyScheme").value,
    host: $("proxyHost").value.trim(),
    port: Number($("proxyPort").value) || 1080,
    bypassList: ["localhost", "127.0.0.1", "<local>"]
  };
  return config;
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

document.addEventListener("DOMContentLoaded", async () => {
  const config = await loadConfig();
  populate(config);

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

  // Proxy toggle applies instantly
  $("useProxy").addEventListener("change", () => save(false));

  // Test proxy egress IP
  $("testProxy").addEventListener("click", () => {
    // Save first so the proxy is applied, then test.
    chrome.runtime.sendMessage(
      { type: "SET_CONFIG", config: collect() },
      () => {
        const out = $("proxyResult");
        out.textContent = "Testing…";
        chrome.runtime.sendMessage({ type: "TEST_PROXY" }, (res) => {
          if (!res?.ok) {
            out.textContent = "Test failed.";
            return;
          }
          if (res.result.ok) {
            out.textContent = "Egress IP: " + res.result.ip;
          } else {
            out.textContent = "Error: " + res.result.error;
          }
        });
      }
    );
  });
});
