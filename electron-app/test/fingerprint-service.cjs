"use strict";
// The C++ fingerprint service is Patched Chromium's seed and Stealthfox.
// The audit has to build the real launch options and accept only a coherent result.
const assert = require("assert/strict");
const os = require("os");
const Module = require("module");
const original = Module._load;
Module._load = function (req, parent, main) {
  if (req === "electron") {
    return { app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return original(req, parent, main);
};
const store = require("../src/profile-store");
const cam = require("../src/camoufox-manager");

function patchedProfile(country, extra) {
  const data = store.buildCountryProfileData(country, 1, Object.assign({
    os: "windows", deviceClass: "desktop", browserApp: "edge", engine: "patched-chromium"
  }, extra || {}));
  data.engine = "patched-chromium";
  data.id = "patched-" + country + "-" + (extra && extra.os || "windows");
  return data;
}

const caps = store.getEngineCapabilities();
assert.equal(caps.chromiumCppPatches, true);
assert.equal(caps.firefoxGeckoRuntime, true);
assert.equal(caps.localIdentityGenerator, true);
assert.equal(caps.aiDailyFingerprints, false);
assert.equal(caps.fingerprintService.included, true);
assert.match(caps.fingerprintService.label, /Patched Chromium and Stealthfox/);

const edge = patchedProfile("de");
const edgeAudit = store.validateProfileConsistency(edge);
assert.equal(edgeAudit.summary.fingerprintServiceOk, true, JSON.stringify(edgeAudit.issues));
assert.equal(edgeAudit.summary.fingerprintService, "On for this profile: Patched Chromium");
assert.ok(edgeAudit.passes.some((item) => /C\+\+ fingerprint service applies seed \d+ inside Patched Chromium as Edge on windows/.test(item.message)));
assert.equal(edgeAudit.issues.some((item) => /user-agent|graphics-card|disable-spoofing/.test(item.message)), false);

const braveMac = patchedProfile("us", { os: "macos", browserApp: "brave" });
braveMac.fingerprint.browser = "brave";
const macAudit = store.validateProfileConsistency(braveMac);
assert.equal(macAudit.summary.fingerprintServiceOk, true, JSON.stringify(macAudit.issues));
assert.ok(macAudit.passes.some((item) => /as Chrome on macos/.test(item.message)));

const stealth = patchedProfile("us");
stealth.fingerprint.spoofingLevel = "stealth";
const stealthAudit = store.validateProfileConsistency(stealth);
assert.equal(stealthAudit.summary.fingerprintServiceOk, true, JSON.stringify(stealthAudit.issues));

const android = store.buildCountryProfileData("us", 3, { os: "android", deviceClass: "mobile", browserApp: "chrome", engine: "patched-chromium" });
android.engine = "patched-chromium";
android.id = "android-check";
const androidAudit = store.validateProfileConsistency(android);
assert.equal(androidAudit.issues.some((item) => /Real Chrome\/Brave/.test(item.message)), false);
assert.equal(androidAudit.summary.fingerprintServiceOk, true, JSON.stringify(androidAudit.issues));

const fox = store.buildCountryProfileData("ch", 1, { os: "windows", deviceClass: "desktop", browserApp: "chrome" });
fox.engine = "stealthfox";
fox.id = "fox-check";
fox.fingerprint.language = "auto";
fox.fingerprint.timezone = "auto";
fox.proxy = { detectedCountryCode: "ch", detectedTimezone: "Europe/Zurich" };
const foxAudit = store.validateProfileConsistency(fox);
assert.equal(foxAudit.summary.fingerprintServiceOk, true, JSON.stringify(foxAudit.issues));
assert.equal(foxAudit.summary.fingerprintService, "On for this profile: Stealthfox");
const swiss = cam.profileToOptions(fox).locale;
assert.ok(["de-CH", "fr-CH", "it-CH"].includes(swiss), swiss);
assert.equal(swiss, store.pickLanguageForCountry(fox.fingerprint.fingerprintSeed, "ch"));

fox.proxy = { detectedCountryCode: "in", detectedTimezone: "Asia/Kolkata" };
const india = cam.profileToOptions(fox).locale;
assert.ok(["en-IN", "hi-IN"].includes(india), india);
assert.equal(india, store.pickLanguageForCountry(fox.fingerprint.fingerprintSeed, "in"));
assert.notEqual(india, "de-DE");

const electronProfile = patchedProfile("us");
electronProfile.engine = "chromium";
const electronAudit = store.validateProfileConsistency(electronProfile);
assert.equal(electronAudit.summary.fingerprintService, "Available on Patched Chromium and Stealthfox");
assert.equal(electronAudit.summary.fingerprintServiceOk, true);

Module._load = original;
console.log("PASS fingerprint service audit matches Patched Chromium and Stealthfox");
