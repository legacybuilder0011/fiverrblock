"use strict";

// Checks the fingerprint engines that actually launch. Patched Chromium applies
// the profile seed inside the browser. Stealthfox applies a Firefox fingerprint
// the same way. Identities are built on this PC. This does not call a remote
// daily device feed, and it does not compile the unused local Chromium patch.

function platformFamily(osName) {
  const os = String(osName || "windows").toLowerCase();
  if (os === "macos" || os === "ios" || os === "mac") return "macos";
  if (os === "linux") return "linux";
  return "windows";
}

function expectedBrand(profile) {
  const fp = (profile && profile.fingerprint) || {};
  const picked = String(fp.browser || profile.browserApp || "chrome").toLowerCase();
  return picked === "edge" ? "Edge" : "Chrome";
}

function auditPatched(profile) {
  const real = require("./real-browser-manager");
  const store = require("./profile-store");
  const cfg = store.buildConfigFromProfile(profile) || {};
  const built = real.patchedFingerprintArgs(profile, cfg);
  const args = built.args || [];
  const seed = built.seed;
  const issues = [];
  const warnings = [];
  const passes = [];
  const family = platformFamily(profile && profile.os);
  const brand = expectedBrand(profile);
  const fp = (profile && profile.fingerprint) || {};
  const stealth = fp.spoofingLevel === "stealth" || Boolean(cfg._stealth);
  const expectedDisable = stealth ? "--disable-spoofing=font,canvas,audio,clientrects" : "--disable-spoofing=font";

  if (!(seed >= 1 && seed <= 2147483647)) issues.push("The Patched Chromium seed is out of range.");
  if (!args.includes(`--fingerprint=${seed}`)) issues.push("Patched Chromium launch is missing this profile's seed.");
  if (!args.includes(`--fingerprint-platform=${family}`)) issues.push("Patched Chromium launch is missing the operating system.");
  if (!args.includes(`--fingerprint-brand=${brand}`)) issues.push("Patched Chromium launch is missing the browser brand.");
  if (!args.includes("--fingerprint-brand-version=148.0.7778.215")) issues.push("Patched Chromium launch is missing the browser version.");
  if (args.some((arg) => String(arg).startsWith("--user-agent"))) issues.push("Patched Chromium launch includes a typed user-agent.");
  if (args.some((arg) => /--disable-spoofing=[^\s]*gpu/.test(String(arg)))) issues.push("Patched Chromium launch turns off the graphics-card spoof.");
  if (!args.includes(expectedDisable)) issues.push(stealth
    ? "Stealth is not turning off canvas, audio, and text-measurement noise."
    : "Patched Chromium is not keeping canvas noise on.");
  if (typeof cfg.hardwareConcurrency === "number" && !args.includes(`--fingerprint-hardware-concurrency=${cfg.hardwareConcurrency}`)) {
    issues.push("Patched Chromium launch is missing the CPU count.");
  }
  if (cfg.timezone && /^[A-Za-z]+\/[A-Za-z_+-]+/.test(cfg.timezone) && !args.includes(`--timezone=${cfg.timezone}`)) {
    issues.push("Patched Chromium launch is missing the timezone.");
  }

  const cloud = real.cloudLaunchSpec(profile, cfg);
  const cloudArgs = (cloud && cloud.args) || [];
  if (cloudArgs.some((arg) => String(arg).startsWith("--disable-spoofing="))) issues.push("Cloud launch still sends a disable-spoofing flag.");
  if (!cloudArgs.includes(`--fingerprint=${seed}`)) issues.push("Cloud launch is missing this profile's seed.");
  if (!cloudArgs.includes(`--fingerprint-platform=${family}`)) issues.push("Cloud launch is missing the operating system.");
  if (!cloudArgs.includes(`--fingerprint-brand=${brand}`)) issues.push("Cloud launch is missing the browser brand.");
  if (cfg.language) {
    if (!cloudArgs.includes(`--lang=${cfg.language}`)) issues.push("Cloud launch is missing the profile language.");
    const accept = cloudArgs.find((arg) => String(arg).startsWith("--accept-lang="));
    if (!accept || !String(accept).includes(cfg.language)) issues.push("Cloud launch is missing the profile language list.");
  }

  if (!issues.length) passes.push(`C++ fingerprint service applies seed ${seed} inside Patched Chromium as ${brand} on ${family}.`);
  try {
    if (real.patchedChromiumReady()) passes.push("Patched Chromium is installed on this PC.");
    else warnings.push("Patched Chromium is not on this PC yet. Start downloads it. The fingerprint flags are ready.");
  } catch (_) {}

  return {
    ok: issues.length === 0,
    label: issues.length ? "Patched Chromium fingerprint is incomplete" : "On for this profile: Patched Chromium",
    passes,
    warnings,
    issues
  };
}

function auditStealthfox(profile) {
  const cam = require("./camoufox-manager");
  const store = require("./profile-store");
  const fp = (profile && profile.fingerprint) || {};
  const px = (profile && profile.proxy) || {};
  const issues = [];
  const warnings = [];
  const passes = [];
  let opts;
  try {
    opts = cam.profileToOptions(profile) || {};
  } catch (err) {
    return {
      ok: false,
      label: "Stealthfox fingerprint is incomplete",
      passes,
      warnings,
      issues: ["Stealthfox could not build this profile's fingerprint."]
    };
  }

  const family = platformFamily(profile && profile.os);
  if (opts.os !== family) issues.push("Stealthfox operating system does not match this profile.");
  if (opts.block_webrtc !== true) issues.push("Stealthfox is not hiding the real network address.");

  let expectedLocale = "";
  if (fp.language === "manual" && fp.languageValue) expectedLocale = fp.languageValue;
  else {
    const cc = px.detectedCountryCode || fp.countryCode;
    if (cc && typeof store.pickLanguageForCountry === "function") {
      expectedLocale = store.pickLanguageForCountry(fp.fingerprintSeed || profile.id || "default", cc);
    }
  }
  if (expectedLocale && opts.locale !== expectedLocale) issues.push(`Stealthfox language is ${opts.locale || "empty"}. It should be ${expectedLocale}.`);

  const wantedW = Number(fp.screenWidth);
  const wantedH = Number(fp.screenHeight);
  if (Number.isFinite(wantedW) && Number.isFinite(wantedH) && wantedW >= 320 && wantedH >= 480) {
    const w = Math.round(Math.min(3840, wantedW));
    const h = Math.round(Math.min(2160, wantedH));
    if (!opts.screen || opts.screen.minWidth !== w || opts.screen.minHeight !== h || opts.screen.maxWidth !== w || opts.screen.maxHeight !== h) {
      issues.push("Stealthfox screen does not match this profile.");
    }
  }

  let tz = "";
  if (fp.timezone === "manual" && fp.timezoneValue) tz = fp.timezoneValue;
  else if (px.detectedTimezone) tz = px.detectedTimezone;
  if (tz && (!opts.config || opts.config.timezone !== tz)) issues.push("Stealthfox timezone does not match this profile.");

  if (!opts.fingerprint) warnings.push("Stealthfox has no saved Firefox fingerprint yet. The first start creates one and reuses it.");
  if (!issues.length) passes.push("C++ fingerprint service applies this profile inside Stealthfox.");

  return {
    ok: issues.length === 0,
    label: issues.length ? "Stealthfox fingerprint is incomplete" : "On for this profile: Stealthfox",
    passes,
    warnings,
    issues
  };
}

function auditProfileFingerprintService(profile) {
  const engine = String((profile && profile.engine) || "chromium").toLowerCase();
  if (engine === "patched-chromium") return auditPatched(profile);
  if (engine === "stealthfox") return auditStealthfox(profile);
  return {
    ok: true,
    label: "Available on Patched Chromium and Stealthfox",
    passes: ["This engine does not apply the C++ fingerprint seed. Patched Chromium and Stealthfox do."],
    warnings: [],
    issues: []
  };
}

module.exports = {
  auditProfileFingerprintService,
  expectedBrand,
  platformFamily
};
