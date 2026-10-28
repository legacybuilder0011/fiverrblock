"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cloudDesktopScreen } = require("../cloud-runner/runner/cloud-desktop-screen");
const { rejectedFonts, fontConfig } = require("../cloud-runner/image/cloud-fonts");
const { applyCloudPrivacy } = require("../cloud-runner/image/cloud-privacy");
const { acceptLanguagesFromLang } = require("../src/accept-languages");

assert.equal(cloudDesktopScreen(1920, 1080).screen, "1920x1080");
assert.equal(cloudDesktopScreen(1536, 864).screen, "1536x864");
assert.equal(cloudDesktopScreen(1512, 982).screen, "1512x982");
assert.equal(cloudDesktopScreen(1366, 768).screen, "1366x768");
assert.equal(cloudDesktopScreen(2560, 1440).screen, "2560x1440");
assert.equal(cloudDesktopScreen(1728, 1117).screen, "1728x1116");
assert.equal(cloudDesktopScreen(1440, 900).screen, "1440x900");

const a = rejectedFonts(48120311);
const b = rejectedFonts(90221763);
assert.deepEqual(rejectedFonts(48120311), a);
assert.notDeepEqual(a, b);
for (const name of ["Arial", "Segoe UI", "Comic Sans MS", "Georgia", "Verdana", "Calibri"]) {
  assert.equal(a.includes(name), false);
  assert.equal(b.includes(name), false);
}
assert.ok(a.length >= 3 && a.length <= 9);
const xml = fontConfig(48120311);
assert.ok(xml.includes("<string>Segoe UI</string>") === false);
assert.ok(xml.includes("/usr/share/fonts/windows"));
assert.ok(a.every((name) => xml.includes(`<string>${name}</string>`)));

assert.equal(acceptLanguagesFromLang("en-US"), "en-US,en");
assert.equal(acceptLanguagesFromLang("en-GB"), "en-GB,en");
assert.equal(acceptLanguagesFromLang("de-DE"), "de-DE,de,en");
assert.equal(acceptLanguagesFromLang("en"), "en");
assert.equal(acceptLanguagesFromLang(""), "en-US,en");

const prefDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-privacy-"));
fs.mkdirSync(path.join(prefDir, "Default"), { recursive: true });
fs.writeFileSync(path.join(prefDir, "Default", "Preferences"), JSON.stringify({ keep: true, profile: { name: "kept" } }));
assert.equal(applyCloudPrivacy(prefDir), true);
const prefs = JSON.parse(fs.readFileSync(path.join(prefDir, "Default", "Preferences"), "utf8"));
assert.equal(prefs.keep, true);
assert.equal(prefs.profile.name, "kept");
assert.equal(prefs.profile.default_content_setting_values.geolocation, 2);
assert.equal(prefs.webrtc.ip_handling_policy, "disable_non_proxied_udp");
fs.writeFileSync(path.join(prefDir, "Default", "Preferences"), "{");
assert.equal(applyCloudPrivacy(prefDir), false);
assert.equal(fs.readFileSync(path.join(prefDir, "Default", "Preferences"), "utf8"), "{");
fs.rmSync(prefDir, { recursive: true, force: true });

console.log("PASS cloud screen, per-profile fonts, accept-language, and location lock");
