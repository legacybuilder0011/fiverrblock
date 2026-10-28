"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gemini-"));
const original = Module._load;
Module._load = function (req, parent, main) {
  if (req === "electron") {
    return {
      app: { getPath: () => dir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from("enc:" + text),
        decryptString: (buf) => Buffer.from(buf).toString("utf8").replace(/^enc:/, "")
      }
    };
  }
  return original(req, parent, main);
};
const store = require("../src/profile-store");
const gemini = require("../src/gemini-fingerprint");

const base = store.buildCountryProfileData("us", 1, { os: "macos", deviceClass: "desktop", browserApp: "chrome", engine: "patched-chromium" });
const applied = gemini.applyAiDevice(base, {
  screenWidth: 1512,
  screenHeight: 982,
  devicePixelRatio: 2,
  cpuCores: 8,
  ram: 16,
  webglVendor: "Google Inc. (NVIDIA)",
  webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  platformVersion: "15.2.0",
  timezone: "America/Los_Angeles",
  language: "en-US",
  city: "San Francisco",
  deviceName: "MacBook Pro",
  userAgent: "Mozilla/5.0 spoof"
});
assert.equal(applied.os, "macos");
assert.equal(applied.fingerprint.screenWidth, 1512);
assert.equal(applied.fingerprint.screenHeight, 982);
assert.equal(applied.fingerprint.cpuCoresValue, 8);
assert.equal(applied.fingerprint.platformVersion, "15.2.0");
assert.equal(applied.fingerprint.timezoneValue, "America/Los_Angeles");
assert.equal(applied.fingerprint.languageValue, "en-US");
assert.equal(applied.fingerprint.city, "San Francisco");
assert.ok(!/Direct3D/i.test(applied.fingerprint.webglRenderer), applied.fingerprint.webglRenderer);
assert.ok(/Apple|Metal/i.test(applied.fingerprint.webglRenderer));
assert.notEqual(applied.fingerprint.userAgentValue, "Mozilla/5.0 spoof");

const rejectedTz = gemini.applyAiDevice(base, { timezone: "Europe/Berlin", language: "de-DE", cpuCores: 7 });
assert.notEqual(rejectedTz.fingerprint.timezoneValue, "Europe/Berlin");
assert.notEqual(rejectedTz.fingerprint.cpuCoresValue, 7);

assert.equal(gemini.hasKey(), false);
assert.equal(gemini.saveKey("test-gemini-key").hasKey, true);
assert.equal(gemini.hasKey(), true);
assert.match(fs.readFileSync(path.join(dir, "gemini-fingerprint.json"), "utf8"), /keyEnc/);
assert.doesNotMatch(fs.readFileSync(path.join(dir, "gemini-fingerprint.json"), "utf8"), /test-gemini-key/);

(async () => {
  let seenKey = "";
  const result = await gemini.generateFingerprint({
    os: "linux",
    browserApp: "chrome",
    engine: "patched-chromium",
    fingerprint: { browser: "chrome", countryCode: "de" }
  }, async (url, options) => {
    seenKey = options.headers["x-goog-api-key"];
    assert.match(url, /gemini-3\.5-flash:generateContent/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          screenWidth: 1920, screenHeight: 1080, cpuCores: 8, ram: 16,
          webglVendor: "Intel", webglRenderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
          platformVersion: "15.2.0", timezone: "Europe/Berlin", language: "de-DE", city: "Berlin"
        }) }] } }]
      })
    };
  });
  assert.equal(seenKey, "test-gemini-key");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.os, "linux");
  assert.equal(result.data.fingerprint.timezone, "auto");
  assert.equal(result.data.fingerprint.language, "auto");
  assert.equal(result.data.fingerprint.screenWidth, 1920);
  assert.match(result.data.fingerprint.webglRenderer, /Mesa/);
  assert.equal(result.data.fingerprint.platformVersion === "15.2.0", false);
  assert.equal(JSON.stringify(result).includes("test-gemini-key"), false);
  assert.equal(gemini.publicError("bad AIzaSyABCDEFGHIJKLMNOP").includes("AIza"), false);

  gemini.saveKey("");
  assert.equal(gemini.hasKey(), false);
  const missing = await gemini.generateFingerprint({ os: "windows" }, async () => { throw new Error("should not call"); });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Add your Gemini API key/);

  Module._load = original;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("PASS Gemini fingerprint keeps the picked OS and stores the key encrypted");
})().catch((err) => {
  Module._load = original;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.error(err);
  process.exit(1);
});
