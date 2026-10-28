"use strict";

// Gemini builds a device story for the profile the user already picked.
// The key stays in the OS keychain file. It is never written into a profile
// and never returned to the window.

const fs = require("fs");
const path = require("path");

const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";

function keyFile() {
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "gemini-fingerprint.json");
}

function safeStorage() {
  return require("electron").safeStorage;
}

function hasKey() {
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
    return Boolean(raw && raw.keyEnc);
  } catch (_) {
    return false;
  }
}

function readKey() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
  } catch (_) {
    return "";
  }
  const storage = safeStorage();
  if (!raw || !raw.keyEnc || !storage.isEncryptionAvailable()) return "";
  try {
    return storage.decryptString(Buffer.from(raw.keyEnc, "base64"));
  } catch (_) {
    return "";
  }
}

function saveKey(key) {
  const value = String(key || "").trim();
  if (!value) {
    try { fs.unlinkSync(keyFile()); } catch (_) {}
    return { ok: true, hasKey: false };
  }
  const storage = safeStorage();
  if (!storage.isEncryptionAvailable()) {
    return { ok: false, error: "This PC cannot store the Gemini key safely." };
  }
  const keyEnc = storage.encryptString(value).toString("base64");
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify({ keyEnc }), "utf8");
  return { ok: true, hasKey: true };
}

function publicError(message) {
  return String(message || "Gemini request failed").replace(/AIza[\w-]{10,}/g, "[key]").slice(0, 280);
}

function extractJson(text) {
  const body = String(text || "").trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : body;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini did not return a fingerprint.");
  return JSON.parse(source.slice(start, end + 1));
}

function numberIn(value, allowed) {
  const n = Number(value);
  return allowed.includes(n) ? n : null;
}

function applyAiDevice(base, raw) {
  const store = require("./profile-store");
  const data = JSON.parse(JSON.stringify(base || {}));
  const fp = data.fingerprint || {};
  data.fingerprint = fp;
  const os = String(data.os || "windows").toLowerCase();
  const country = String(fp.countryCode || "us").toLowerCase();
  const proposed = raw && typeof raw === "object" ? raw : {};

  const width = Number(proposed.screenWidth);
  const height = Number(proposed.screenHeight);
  const desktop = os !== "android" && os !== "ios";
  if (desktop && width >= 1024 && width <= 3840 && height >= 700 && height <= 2160 && width >= height) {
    fp.screen = "manual";
    fp.screenWidth = Math.round(width);
    fp.screenHeight = Math.round(height);
    const dpr = Number(proposed.devicePixelRatio);
    if (dpr >= 1 && dpr <= 3) fp.devicePixelRatio = dpr;
  }

  const cpu = numberIn(proposed.cpuCores, [2, 4, 6, 8, 12, 16]);
  if (cpu) {
    fp.cpuCores = "manual";
    fp.cpuCoresValue = cpu;
  }
  const ram = numberIn(proposed.ram, [8]);
  if (ram) {
    fp.ram = "manual";
    fp.ramValue = ram;
  }

  const vendor = String(proposed.webglVendor || "").trim();
  const renderer = String(proposed.webglRenderer || "").trim();
  if (vendor && renderer && store.gpuLooksCompatibleWithOs(os, vendor, renderer)) {
    fp.webglInfo = "manual";
    fp.webglVendor = vendor.slice(0, 120);
    fp.webglRenderer = renderer.slice(0, 180);
  }

  if (store.platformVersionFitsOs(proposed.platformVersion, os)) {
    fp.platformVersion = String(proposed.platformVersion);
  }

  const city = String(proposed.city || "").trim();
  if (city && city.length <= 40 && !/[\r\n]/.test(city)) fp.city = city;
  const deviceName = String(proposed.deviceName || "").trim();
  if (deviceName && deviceName.length >= 2 && deviceName.length <= 40 && !/[\r\n]/.test(deviceName)) {
    fp.deviceName = "manual";
    fp.deviceNameValue = deviceName;
  }

  if (store.timezoneFitsCountry(country, proposed.timezone)) {
    fp.timezone = "manual";
    fp.timezoneValue = proposed.timezone;
  }
  if (store.languageFitsCountry(country, proposed.language)) {
    fp.language = "manual";
    fp.languageValue = proposed.language;
  }
  return data;
}

function promptFor(profile) {
  const os = profile.os || "windows";
  const country = (profile.fingerprint && profile.fingerprint.countryCode) || "us";
  return [
    "Return one JSON object and nothing else.",
    "Build a realistic desktop device for this fixed operating system and country.",
    "Do not change the operating system. Do not include a user-agent string.",
    `operatingSystem: ${os}`,
    `countryCode: ${country}`,
    "Fields: screenWidth, screenHeight, devicePixelRatio, cpuCores, ram, webglVendor, webglRenderer, platformVersion, timezone, language, city, deviceName.",
    "cpuCores must be 4, 6, 8, 12, or 16. ram must be 8.",
    "macOS graphics must be Apple Metal. Linux graphics must be Mesa. Windows graphics must be Direct3D.",
    "platformVersion for macOS must be one of 13.6.9, 14.5.0, 14.6.1, 15.1.1, 15.2.0.",
    "platformVersion for Windows must be one of 10.0.0, 14.0.0, 15.0.0.",
    "timezone and language must match the country."
  ].join("\n");
}

async function generateFingerprint(profile, fetchImpl) {
  const key = readKey();
  if (!key) return { ok: false, error: "Add your Gemini API key first." };
  const store = require("./profile-store");
  const country = (profile.fingerprint && profile.fingerprint.countryCode) || "us";
  const base = store.buildCountryProfileData(country, 1, {
    os: profile.os || "windows",
    deviceClass: profile.os === "android" || profile.os === "ios" ? "mobile" : "desktop",
    browserApp: (profile.fingerprint && profile.fingerprint.browser) || profile.browserApp || "chrome",
    engine: profile.engine || "patched-chromium"
  });
  base.os = profile.os || base.os;
  base.engine = profile.engine || base.engine;
  const fetcher = fetchImpl || globalThis.fetch;
  let lastError = "Gemini request failed.";
  for (const model of MODELS) {
    let response;
    try {
      response = await fetcher(ENDPOINT + model + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptFor(base) }] }],
          generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
        }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (err) {
      lastError = publicError(err && err.message);
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = publicError(body && body.error && body.error.message || `Gemini error ${response.status}`);
      if (response.status === 404) continue;
      return { ok: false, error: lastError };
    }
    const text = ((body.candidates || [])[0] && body.candidates[0].content && body.candidates[0].content.parts || [])
      .map((part) => part.text || "").join("");
    try {
      const data = applyAiDevice(base, extractJson(text));
      data.fingerprint.timezone = "auto";
      data.fingerprint.language = "auto";
      data.fingerprint.geolocation = "auto";
      return { ok: true, data, model };
    } catch (err) {
      return { ok: false, error: publicError(err && err.message) };
    }
  }
  return { ok: false, error: lastError };
}

module.exports = {
  hasKey,
  saveKey,
  applyAiDevice,
  extractJson,
  generateFingerprint,
  publicError
};
