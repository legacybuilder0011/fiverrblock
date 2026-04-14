// content-bridge.js - Runs in the ISOLATED world. Bridges chrome.storage config
// to the MAIN world via window events, so the in-page overrides know which
// geolocation / timezone / UA to spoof.

(function () {
  "use strict";

  const SYNC_KEY = "__privacy_shield_config__";

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
})();
