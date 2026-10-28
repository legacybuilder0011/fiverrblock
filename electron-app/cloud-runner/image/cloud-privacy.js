"use strict";

// Same location and WebRTC lock the local patched browser writes before launch.
// Without this, a cloud profile can answer geolocation and report one place.
const fs = require("fs");
const path = require("path");

function applyCloudPrivacy(dataDir) {
  const dir = path.join(dataDir || "/data", "Default");
  fs.mkdirSync(dir, { recursive: true });
  const prefPath = path.join(dir, "Preferences");
  let prefs = {};
  if (fs.existsSync(prefPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefPath, "utf8"));
    } catch (_) {
      return false;
    }
  }
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return false;
  prefs.profile = prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {};
  const defaults = prefs.profile.default_content_setting_values;
  prefs.profile.default_content_setting_values = defaults && typeof defaults === "object" ? defaults : {};
  prefs.profile.default_content_setting_values.geolocation = 2;
  const webrtc = prefs.webrtc && typeof prefs.webrtc === "object" ? prefs.webrtc : {};
  prefs.webrtc = Object.assign(webrtc, {
    ip_handling_policy: "disable_non_proxied_udp",
    multiple_routes_enabled: false,
    nonproxied_udp_enabled: false
  });
  fs.writeFileSync(prefPath, JSON.stringify(prefs));
  return true;
}

module.exports = { applyCloudPrivacy };

if (require.main === module) {
  const ok = applyCloudPrivacy(process.argv[2] || "/data");
  if (!ok) process.exit(1);
}
