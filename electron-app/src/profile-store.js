"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const BASE_DIR = path.join(app.getPath("userData"), "privacy-shield");

function getDataDir() {
  try {
    const auth = require("./auth-store");
    return auth.getCurrentUserDataDir();
  } catch (_) {
    return path.join(BASE_DIR, "default");
  }
}

function getProfilesFile()   { return path.join(getDataDir(), "profiles.json"); }
function getProxyLibFile()   { return path.join(getDataDir(), "proxy-library.json"); }
function getOpenProfilesFile() { return path.join(getDataDir(), "open-profiles.json"); }

function ensureDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── Profiles ──────────────────────────────────────────────────────────────────

function getProfiles() {
  const data = readJson(getProfilesFile(), []);
  return Array.isArray(data) ? data : [];
}

function saveProfiles(profiles) {
  writeJson(getProfilesFile(), profiles);
}

// ── Proxy Library ──────────────────────────────────────────────────────────────

function getProxyLibrary() {
  const data = readJson(getProxyLibFile(), []);
  return Array.isArray(data) ? data : [];
}

function saveProxyLibrary(lib) {
  writeJson(getProxyLibFile(), lib);
}

// ── Open profiles (auto-restore) ──────────────────────────────────────────────

function getOpenProfiles() {
  const data = readJson(getOpenProfilesFile(), []);
  return Array.isArray(data) ? data : [];
}

function saveOpenProfiles(profileIds) {
  writeJson(getOpenProfilesFile(), Array.isArray(profileIds) ? profileIds : []);
}

// ── ID generation ──────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Default structures ─────────────────────────────────────────────────────────

function getDefaultFingerprint() {
  return {
    userAgent: "auto", userAgentValue: "",
    canvas: "noise",
    webgl: "noise", webglInfo: "manual",
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    webgpu: false,
    clientRects: "real",
    timezone: "auto", timezoneValue: "America/New_York", timezoneOffset: 300,
    language: "auto", languageValue: "en-US",
    geolocation: "auto", geoLat: 40.7128, geoLng: -74.006, geoAccuracy: 50,
    cpuCores: "manual", cpuCoresValue: 4,
    ram: "manual", ramValue: 8,
    screen: "manual", screenWidth: 1920, screenHeight: 1080,
    audio: "noise",
    fonts: "real",
    mediaDevices: "real", cameras: 1, microphones: 1, speakers: 1,
    deviceName: "off", deviceNameValue: "",
    ports: "block", blockedPorts: [3389, 5938],
    doNotTrack: false,
    webrtc: "altered", webrtcIP: "",
    blockStorage: false, blockCookies: false,
    browserVersion: "148",
    ispName: "", ispAsn: "", ispOrg: "", city: "", state: ""
  };
}

function getDefaultProxy() {
  return { enabled: false, scheme: "socks5", host: "", port: 1080, username: "", password: "", rotationUrl: "", bypassList: [] };
}

// ── CRUD operations ────────────────────────────────────────────────────────────

function createProfile(data) {
  const profiles = getProfiles();
  const now = Date.now();
  const profile = {
    id: generateId(),
    name: data.name || "Profile " + (profiles.length + 1),
    status: data.status || "new",
    tags: Array.isArray(data.tags) ? data.tags : [],
    notes: data.notes || "",
    os: data.os || "windows",
    browserApp: data.browserApp || "chrome",
    windowMode: data.windowMode || "normal",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    fingerprint: data.fingerprint || getDefaultFingerprint(),
    proxy: data.proxy || getDefaultProxy(),
    cookies: data.cookies || [],
    localStorageData: data.localStorageData || {},
    session: data.session || null
  };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

function updateProfile(id, data) {
  const profiles = getProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = profiles[idx];
  profiles[idx] = { ...existing, ...data, id, updatedAt: Date.now() };
  if (data.fingerprint) profiles[idx].fingerprint = { ...existing.fingerprint, ...data.fingerprint };
  if (data.proxy) profiles[idx].proxy = { ...existing.proxy, ...data.proxy };
  saveProfiles(profiles);
  return profiles[idx];
}

function deleteProfile(id, hard = false) {
  let profiles = getProfiles();
  if (hard) {
    profiles = profiles.filter((p) => p.id !== id);
  } else {
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx !== -1) profiles[idx].deletedAt = Date.now();
  }
  saveProfiles(profiles);
}

function duplicateProfile(id) {
  const profiles = getProfiles();
  const src = profiles.find((p) => p.id === id);
  if (!src) return null;
  const now = Date.now();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = generateId();
  copy.name = src.name + " (copy)";
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.deletedAt = null;
  profiles.push(copy);
  saveProfiles(profiles);
  return copy;
}

function restoreProfile(id) {
  return updateProfile(id, { deletedAt: null });
}

// ── Proxy library CRUD ─────────────────────────────────────────────────────────

function addProxyEntry(entry) {
  const lib = getProxyLibrary();
  const newEntry = { id: generateId(), ...entry };
  lib.push(newEntry);
  saveProxyLibrary(lib);
  return newEntry;
}

function updateProxyEntry(id, data) {
  const lib = getProxyLibrary();
  const idx = lib.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  lib[idx] = { ...lib[idx], ...data, id };
  saveProxyLibrary(lib);
  return lib[idx];
}

function deleteProxyEntry(id) {
  const lib = getProxyLibrary().filter((e) => e.id !== id);
  saveProxyLibrary(lib);
}

// ── WebGL presets (same as extension) ──────────────────────────────────────────

const PROFILE_WEBGL_PRESETS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)", platform: "windows" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", platform: "macos" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", platform: "macos" },
  { vendor: "Intel", renderer: "Mesa Intel(R) UHD Graphics 620 (KBL GT2)", platform: "linux" },
  { vendor: "Intel", renderer: "Mesa Intel(R) HD Graphics 5500 (BDW GT2)", platform: "linux" },
  { vendor: "AMD", renderer: "AMD RENOIR (LLVM 12.0.0, 128 bits)", platform: "linux" },
  { vendor: "Mesa/X.org", renderer: "llvmpipe (LLVM 12.0.0, 256 bits)", platform: "linux" }
];

// ── Config builder (same logic as background.js:buildConfigFromProfile) ────────

function buildProfileUA(os, version, browser) {
  const br = browser || "chrome";
  const v  = String(version || "148");
  const full = v.includes(".") ? v : v + ".0.0.0";

  const osStr = {
    macos:  { win: "Macintosh; Intel Mac OS X 10_15_7", platform: "MacIntel"      },
    linux:  { win: "X11; Linux x86_64",                 platform: "Linux x86_64"  },
    windows:{ win: "Windows NT 10.0; Win64; x64",       platform: "Win32"         },
  }[os] || { win: "Windows NT 10.0; Win64; x64", platform: "Win32" };

  switch (br) {
    case "firefox": {
      const fv = v.includes(".") ? v.split(".")[0] : v;
      return { ua: `Mozilla/5.0 (${osStr.win}; rv:${fv}.0) Gecko/20100101 Firefox/${fv}.0`, platform: osStr.platform };
    }
    case "safari": {
      const mac = "Macintosh; Intel Mac OS X 10_15_7";
      return { ua: `Mozilla/5.0 (${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${full} Safari/605.1.15`, platform: "MacIntel" };
    }
    case "edge":
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 Edg/${full}`, platform: osStr.platform };
    case "brave":
      // Brave uses a standard Chrome UA — it's identified by brave.isBrave API, not the UA string
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`, platform: osStr.platform };
    default: // chrome
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`, platform: osStr.platform };
  }
}

function buildConfigFromProfile(profile) {
  if (!profile) return null;
  const fp = profile.fingerprint || {};
  const cfg = {
    enabled: true,
    rotateFingerprint: false,
    perTabFingerprint: false,
    blockCookies: Boolean(fp.blockCookies),
    blockStorage: Boolean(fp.blockStorage),
    spoofUA: true,
    spoofGeo: true,
    spoofTimezone: true,
    blockCanvas: fp.canvas !== "real",
    _canvasMode: fp.canvas || "noise",
    blockWebGL: fp.webgl !== "real",
    _webglMode: fp.webgl || "noise",
    _webgpu: Boolean(fp.webgpu),
    _clientRects: fp.clientRects || "real",
    _doNotTrack: Boolean(fp.doNotTrack),
    blockAudio: fp.audio !== "real",
    _audioMode: fp.audio || "noise",
    blockBattery: true,
    blockPlugins: true,
    blockFonts: true,
    blockHardware: true,
    blockScreen: true,
    _mediaDevices: fp.mediaDevices || "real",
    _cameras: typeof fp.cameras === "number" ? fp.cameras : 1,
    _microphones: typeof fp.microphones === "number" ? fp.microphones : 1,
    _speakers: typeof fp.speakers === "number" ? fp.speakers : 1,
    _deviceName: fp.deviceName || "off",
    _deviceNameValue: fp.deviceNameValue || "",
    _ports: fp.ports || "real",
    _blockedPorts: Array.isArray(fp.blockedPorts) ? fp.blockedPorts : [3389, 5938],
    _webrtcMode: fp.webrtc || "altered",
    _webrtcIP: fp.webrtcIP || "",
    _profileId: profile.id,
    _profileName: profile.name,
    hardwareConcurrency: 4,
    deviceMemory: 8,
    language: "en-US",
    languages: ["en-US", "en"],
    timezone: "America/New_York",
    localeOffsetMinutes: 300,
    geo: { latitude: 40.7128, longitude: -74.006, accuracy: 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 }
  };

  const platformMap = { windows: "Win32", macos: "MacIntel", linux: "Linux x86_64" };
  cfg.platform = platformMap[profile.os || "windows"] || "Win32";

  if (fp.userAgent === "manual" && fp.userAgentValue) {
    cfg.userAgent = fp.userAgentValue;
  } else {
    const bv = fp.browserVersion || "148";
    const built = buildProfileUA(profile.os || "windows", bv, fp.browser || profile.browserApp || "chrome");
    cfg.userAgent = built.ua;
    cfg.platform = built.platform;
  }

  if (fp.webglInfo === "manual" && fp.webglVendor) {
    cfg._gpuVendor = fp.webglVendor;
    cfg._gpuRenderer = fp.webglRenderer || "";
  } else {
    const gi = parseInt(profile.id.slice(-4), 36) % PROFILE_WEBGL_PRESETS.length;
    cfg._gpuVendor = PROFILE_WEBGL_PRESETS[gi].vendor;
    cfg._gpuRenderer = PROFILE_WEBGL_PRESETS[gi].renderer;
  }

  if (fp.timezone === "manual") {
    cfg.timezone = fp.timezoneValue || "UTC";
    cfg.localeOffsetMinutes = typeof fp.timezoneOffset === "number" ? fp.timezoneOffset : 0;
  }

  if (fp.language === "manual" && fp.languageValue) {
    cfg.language = fp.languageValue;
    cfg.languages = [fp.languageValue, fp.languageValue.split("-")[0]].filter(Boolean);
  }

  if (fp.geolocation === "manual") {
    cfg.geo = {
      latitude: Number(fp.geoLat) || 0,
      longitude: Number(fp.geoLng) || 0,
      accuracy: Number(fp.geoAccuracy) || 50,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null
    };
  }

  if (fp.cpuCores === "manual") cfg.hardwareConcurrency = Number(fp.cpuCoresValue) || 4;
  if (fp.ram === "manual") cfg.deviceMemory = Number(fp.ramValue) || 8;

  if (fp.screen === "manual") {
    cfg.screen = {
      width: Number(fp.screenWidth) || 1920,
      height: Number(fp.screenHeight) || 1080,
      availWidth: Number(fp.screenWidth) || 1920,
      availHeight: (Number(fp.screenHeight) || 1080) - 40,
      colorDepth: 24, pixelDepth: 24
    };
  }

  return cfg;
}

module.exports = {
  getProfiles,
  saveProfiles,
  getProxyLibrary,
  saveProxyLibrary,
  generateId,
  getDefaultFingerprint,
  getDefaultProxy,
  createProfile,
  updateProfile,
  deleteProfile,
  duplicateProfile,
  restoreProfile,
  addProxyEntry,
  updateProxyEntry,
  deleteProxyEntry,
  buildConfigFromProfile,
  getOpenProfiles,
  saveOpenProfiles,
  PROFILE_WEBGL_PRESETS
};
