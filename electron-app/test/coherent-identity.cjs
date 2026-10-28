"use strict";
// Generate coherent identity: device fields match the OS, and Auto timezone,
// language, and geolocation follow the proxy/VPN exit rather than the country
// the form was last showing.
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

function generated(country, engine) {
  const data = store.buildCountryProfileData(country, 1, {
    os: "windows", deviceClass: "desktop", browserApp: "edge", engine
  });
  data.engine = engine || "chromium";
  data.id = "identity-check";
  data.fingerprint.timezone = "auto";
  data.fingerprint.language = "auto";
  data.fingerprint.geolocation = "auto";
  return data;
}

function withExit(data, exit) {
  data.proxy = {
    detectedCountryCode: exit.country,
    detectedTimezone: exit.timezone,
    detectedLatitude: exit.lat,
    detectedLongitude: exit.lng
  };
  return store.buildConfigFromProfile(data);
}

const patched = generated("de", "patched-chromium");
assert.equal(patched.browserApp, "edge");
assert.equal(patched.fingerprint.browser, "edge");
assert.equal(patched.fingerprint.browserVersion, "148.0.7778.215");
assert.equal(patched.os, "windows");
assert.ok(patched.fingerprint.screenWidth >= 1024);
assert.ok([2, 4, 6, 8, 12, 16].includes(patched.fingerprint.cpuCoresValue));
assert.equal(patched.fingerprint.ramValue, 8);
assert.ok(!/apple|metal|adreno|mali|powervr/i.test(patched.fingerprint.webglRenderer));

const swiss = withExit(patched, { country: "ch", timezone: "Europe/Zurich", lat: 47.3769, lng: 8.5417 });
assert.equal(swiss.timezone, "Europe/Zurich");
assert.ok(["de-CH", "fr-CH", "it-CH"].includes(swiss.language), swiss.language);
assert.ok(Math.abs(swiss.geo.latitude - 47.3769) < 0.001);
assert.equal(swiss._uaFullVersion, "148.0.7778.215");

const usExit = withExit(generated("de", "patched-chromium"), {
  country: "us", timezone: "America/Chicago", lat: 41.8781, lng: -87.6298
});
assert.equal(usExit.timezone, "America/Chicago");
assert.equal(usExit.language, "en-US");
assert.ok(Math.abs(usExit.geo.longitude - -87.6298) < 0.001);

const audit = store.validateProfileConsistency(patched);
assert.ok(audit.passes.some((item) => item.message.includes("follows the proxy or VPN exit")));
assert.equal(audit.warnings.some((item) => /not manually pinned/.test(item.message)), false);
const seeds = new Set();
for (let i = 0; i < 40; i++) {
  const made = store.buildCountryProfileData("us", i, { os: "windows", deviceClass: "desktop", engine: "patched-chromium" });
  assert.equal(made.fingerprint.fingerprintSeed.length, 16);
  assert.equal(store.fingerprintSeedInteger(made.fingerprint.fingerprintSeed) % 3, 0);
  seeds.add(made.fingerprint.fingerprintSeed);
}
assert.equal(seeds.size, 40);

const mac = store.buildConfigFromProfile({
  id: "mac-check",
  os: "macos",
  engine: "patched-chromium",
  fingerprint: {
    browser: "edge",
    platformVersion: "10.0.0",
    browserVersion: "150.0.0.0",
    language: "manual",
    languageValue: "en-US",
    timezone: "manual",
    timezoneValue: "America/Los_Angeles"
  }
});
assert.ok(["15.2.0", "15.1.1", "14.6.1", "14.5.0", "13.6.9"].includes(mac._platformVersion), mac._platformVersion);
assert.ok(mac.userAgent.includes("Macintosh"), mac.userAgent);
assert.ok(mac.userAgent.includes("Edg/148.0.7778.215"), mac.userAgent);
Module._load = original;
console.log("PASS coherent identity follows the exit and matches the OS");
