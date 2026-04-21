// content-bridge.js - Runs in the ISOLATED world. Bridges chrome.storage config
// to the MAIN world via window events, so the in-page overrides know which
// geolocation / timezone / UA to spoof.

(function () {
  "use strict";

  const SYNC_KEY = "__privacy_shield_config__";
  const EVENT_KEY = "__privacy_shield_event__";

  const CACHE_KEY = "__ps_cfg_cache";

  function deliver(config) {
    const json = JSON.stringify(config);
    try {
      document.documentElement.setAttribute("data-privacy-shield", json);
    } catch (_) {}
    try {
      sessionStorage.setItem(CACHE_KEY, json);
    } catch (_) {}
    window.dispatchEvent(
      new CustomEvent(SYNC_KEY, { detail: JSON.parse(json) })
    );
  }

  // Deliver cached config synchronously so MAIN world gets it before any
  // page script runs. This is critical for per-tab fingerprint stability —
  // without it, MAIN falls back to defaults and re-rotates on every reload.
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      document.documentElement.setAttribute("data-privacy-shield", cached);
    }
  } catch (_) {}

  chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.ok) deliver(res.config);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "CONFIG_UPDATE" && msg.config) deliver(msg.config);
  });

  // ----- Activity forwarding -----
  // The MAIN-world script dispatches CustomEvents for every override hit.
  // We buffer them and flush in batches so we don't spam sendMessage.
  let buffer = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    const events = buffer;
    buffer = [];
    try {
      chrome.runtime.sendMessage({ type: "RECORD_ACTIVITY", events }, () => {
        if (chrome.runtime.lastError) {
          /* SW may be asleep; drop silently */
        }
      });
    } catch (_) {}
  }

  window.addEventListener(EVENT_KEY, (ev) => {
    try {
      const d = ev.detail || {};
      if (!d.type) return;
      buffer.push({ type: String(d.type), detail: String(d.detail || "") });
      if (buffer.length > 100) buffer.length = 100;
      if (!flushTimer) flushTimer = setTimeout(flush, 400);
    } catch (_) {}
  });
})();
