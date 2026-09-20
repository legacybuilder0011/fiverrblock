"use strict";
// Regression check: real-browser profiles (patched-chromium / real-chrome /
// real-brave) must launch with Chrome's password manager ENABLED. It used to be
// hard-disabled, so the "Save password?" bubble never appeared and every login
// typed into a profile was lost. Also proves the fix repairs profile dirs that
// already have the old `false` on disk.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-pw-"));
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") return { app: { getPath: () => tmp } };
  return realLoad.call(this, req, parent, isMain);
};

const rbm = require("../src/real-browser-manager");
const dir = path.join(tmp, "profile-dir");
const prefPath = path.join(dir, "Default", "Preferences");
const profile = { id: "t1", fingerprint: { language: "manual", languageValue: "en-US" } };

// 1. Fresh profile dir -> password manager on.
rbm.writePrivacyPreferences(profile, dir);
let prefs = JSON.parse(fs.readFileSync(prefPath, "utf8"));
assert.strictEqual(prefs.credentials_enable_service, true, "fresh: save-password must be enabled");
assert.strictEqual(prefs.profile.password_manager_enabled, true, "fresh: password manager must be enabled");

// 2. Existing dir carrying the old `false` -> repaired on next launch, and the
//    browser's other stored prefs survive the merge.
prefs.credentials_enable_service = false;
prefs.profile.password_manager_enabled = false;
prefs.profile.exit_type = "Normal";
fs.writeFileSync(prefPath, JSON.stringify(prefs), "utf8");
rbm.writePrivacyPreferences(profile, dir);
prefs = JSON.parse(fs.readFileSync(prefPath, "utf8"));
assert.strictEqual(prefs.credentials_enable_service, true, "existing: must be repaired to enabled");
assert.strictEqual(prefs.profile.password_manager_enabled, true, "existing: must be repaired to enabled");
assert.strictEqual(prefs.profile.exit_type, "Normal", "unrelated prefs must survive the merge");
assert.strictEqual(prefs.webrtc.ip_handling_policy, "disable_non_proxied_udp", "WebRTC leak guard must stay");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS — password manager enabled on fresh and already-broken profile dirs");
