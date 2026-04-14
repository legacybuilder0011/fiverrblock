// content-bridge.js - Runs in the ISOLATED world. Bridges chrome.storage config
// to the MAIN world via window events, so the in-page overrides know which
// geolocation / timezone / UA to spoof.

(function () {
  "use strict";

  const SYNC_KEY = "__privacy_shield_config__";
  const EVENT_KEY = "__privacy_shield_event__";

  function deliver(config) {
    // Stash on document attribute in case the MAIN world script starts later.
    try {
      document.documentElement.setAttribute(
        "data-privacy-shield",
        JSON.stringify(config)
      );
    } catch (_) {}
    // Also dispatch a live event for already-running MAIN world.
    window.dispatchEvent(
      new CustomEvent(SYNC_KEY, { detail: JSON.parse(JSON.stringify(config)) })
    );
  }

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
