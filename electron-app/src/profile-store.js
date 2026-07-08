"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app, safeStorage } = require("electron");

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
function getProxyProviderFile() { return path.join(getDataDir(), "proxy-provider.json"); }
function getVpsProxyFile() { return path.join(getDataDir(), "vps-proxies.json"); }
function getCloudPhoneProviderFile() { return path.join(getDataDir(), "android-cloud-provider.json"); }
function getCloudPhoneFile() { return path.join(getDataDir(), "android-cloud-phones.json"); }
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

// Atomic write: serialize to a temp file, fsync it, keep the last-known-good
// copy as <file>.bak, then rename the temp over the target. rename() is atomic
// on the same volume, so a crash/OOM/power-loss mid-write can never leave a
// half-written (corrupt) profiles.json — the live file is either the old or the
// new complete version, and .bak is a recovery point. This matters more the
// bigger the account gets (a torn write on a large file would lose everything).
function writeJson(file, data) {
  ensureDir();
  const json = JSON.stringify(data, null, 2);
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, json, "utf8");
    try { fs.fsyncSync(fd); } catch (_) {}
  } finally {
    fs.closeSync(fd);
  }
  // Preserve the previous good file as .bak before overwriting.
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch (_) {}
  fs.renameSync(tmp, file);
}

// Secrets are persisted through Electron safeStorage when available. The fallback
// is only for unsupported dev environments; Windows packaged builds use DPAPI.
function encryptSecret(value) {
  if (!value) return "";
  const text = String(value);
  if (text.startsWith("safe:") || text.startsWith("plain:")) return text;
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return "safe:" + safeStorage.encryptString(text).toString("base64");
    }
  } catch (_) {}
  return "plain:" + Buffer.from(text, "utf8").toString("base64");
}

function decryptSecret(value) {
  if (!value) return "";
  const text = String(value);
  try {
    if (text.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(text.slice(5), "base64"));
    }
    if (text.startsWith("plain:")) {
      return Buffer.from(text.slice(6), "base64").toString("utf8");
    }
  } catch (_) {
    return "";
  }
  return text;
}

function secretForDisk(obj, field) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  const encField = field + "Enc";
  if (typeof out[field] === "string" && out[field]) {
    out[encField] = encryptSecret(out[field]);
    delete out[field];
  }
  return out;
}

function secretForRuntime(obj, field) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  const encField = field + "Enc";
  if (!out[field] && out[encField]) out[field] = decryptSecret(out[encField]);
  delete out[encField];
  return out;
}

function proxyForDisk(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;
  return secretForDisk(proxy, "password");
}

function proxyForRuntime(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;
  return secretForRuntime(proxy, "password");
}

function profileForDisk(profile) {
  if (!profile || typeof profile !== "object") return profile;
  return { ...profile, proxy: proxyForDisk(profile.proxy) };
}

function profileForRuntime(profile) {
  if (!profile || typeof profile !== "object") return profile;
  return { ...profile, proxy: proxyForRuntime(profile.proxy) };
}

function proxyEntryForDisk(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return proxyForDisk(entry);
}

function proxyEntryForRuntime(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return proxyForRuntime(entry);
}

const LOCAL_ONLY_PROFILE_FIELDS = ["cookies", "localStorageData", "session"];
const BUILTIN_SPOOF_SKIP_HOSTS = ["instagram.com"];
const LOCAL_ONLY_PROXY_FIELDS = ["username", "password", "passwordEnc", "rotationUrl"];

function cloneForSync(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value || fallback));
  } catch (_) {
    return fallback;
  }
}

function stripLocalProxyFields(proxy) {
  const clone = cloneForSync(proxy);
  for (const field of LOCAL_ONLY_PROXY_FIELDS) delete clone[field];
  return clone;
}

function sanitizeProfileForSync(profile) {
  const clone = cloneForSync(profile);
  for (const field of LOCAL_ONLY_PROFILE_FIELDS) delete clone[field];
  if (clone.proxy) clone.proxy = stripLocalProxyFields(clone.proxy);
  return clone;
}

function sanitizeProxyForSync(entry) {
  return stripLocalProxyFields(entry);
}

// ── Profiles ──────────────────────────────────────────────────────────────────

function getProfiles() {
  const data = readJson(getProfilesFile(), []);
  return Array.isArray(data) ? data.map(profileForRuntime) : [];
}

function saveProfiles(profiles) {
  writeJson(getProfilesFile(), Array.isArray(profiles) ? profiles.map(profileForDisk) : []);
}

// ── Proxy Library ──────────────────────────────────────────────────────────────

function getProxyLibrary() {
  const data = readJson(getProxyLibFile(), []);
  return Array.isArray(data) ? data.map(proxyEntryForRuntime) : [];
}

function saveProxyLibrary(lib) {
  writeJson(getProxyLibFile(), Array.isArray(lib) ? lib.map(proxyEntryForDisk) : []);
}

function mergeProxySecretsFromLocal(remoteProxy, localProxy) {
  const merged = { ...(remoteProxy || {}) };
  if (localProxy && typeof localProxy === "object") {
    for (const field of LOCAL_ONLY_PROXY_FIELDS) {
      if (!merged[field] && localProxy[field]) merged[field] = localProxy[field];
    }
  }
  return merged;
}

function mergeProfileFromSync(remoteProfile, localProfile) {
  const merged = sanitizeProfileForSync(remoteProfile);
  const local = localProfile && typeof localProfile === "object" ? localProfile : {};
  merged.cookies = Array.isArray(local.cookies) ? local.cookies : [];
  merged.localStorageData = local.localStorageData && typeof local.localStorageData === "object" ? local.localStorageData : {};
  merged.session = Object.prototype.hasOwnProperty.call(local, "session") ? local.session : null;
  merged.proxy = mergeProxySecretsFromLocal(merged.proxy || local.proxy || getDefaultProxy(), local.proxy);
  return merged;
}

function mergeProxyFromSync(remoteProxy, localProxy) {
  return mergeProxySecretsFromLocal(sanitizeProxyForSync(remoteProxy), localProxy);
}

function saveSyncedProfiles(remoteProfiles) {
  const localById = new Map(getProfiles().map((profile) => [profile.id, profile]));
  const merged = (Array.isArray(remoteProfiles) ? remoteProfiles : [])
    .filter((profile) => profile && profile.id)
    .map((profile) => mergeProfileFromSync(profile, localById.get(profile.id)));
  saveProfiles(merged);
  return getProfiles();
}

function saveSyncedProxyLibrary(remoteProxies) {
  const localById = new Map(getProxyLibrary().map((proxy) => [proxy.id, proxy]));
  const merged = (Array.isArray(remoteProxies) ? remoteProxies : [])
    .filter((proxy) => proxy && proxy.id)
    .map((proxy) => mergeProxyFromSync(proxy, localById.get(proxy.id)));
  saveProxyLibrary(merged);
  return getProxyLibrary();
}

function getProxyProviderConfig() {
  const data = readJson(getProxyProviderFile(), {});
  return {
    endpoint: typeof data.endpoint === "string" ? data.endpoint : "",
    token: typeof data.tokenEnc === "string" ? decryptSecret(data.tokenEnc) : (typeof data.token === "string" ? data.token : ""),
    authMode: ["bearer", "x-api-key", "none"].includes(data.authMode) ? data.authMode : "bearer"
  };
}

function saveProxyProviderConfig(config = {}) {
  const existing = getProxyProviderConfig();
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : existing.endpoint;
  const authMode = ["bearer", "x-api-key", "none"].includes(config.authMode) ? config.authMode : existing.authMode;
  const token = typeof config.token === "string" && config.token.length ? config.token : existing.token;
  const saved = {
    endpoint,
    tokenEnc: config.clearToken ? "" : encryptSecret(token),
    authMode
  };
  writeJson(getProxyProviderFile(), saved);
  return { endpoint: saved.endpoint, token: config.clearToken ? "" : token, authMode: saved.authMode };
}

// ── VPS proxy records ─────────────────────────────────────────────────────────

function vpsForDisk(record) {
  if (!record || typeof record !== "object") return record;
  const ssh = { ...(record.ssh || {}) };
  const proxy = { ...(record.proxy || {}) };
  return {
    ...record,
    ssh: secretForDisk(secretForDisk(ssh, "password"), "privateKey"),
    proxy: proxyForDisk(proxy)
  };
}

function vpsForRuntime(record, includeSecrets = false) {
  if (!record || typeof record !== "object") return record;
  const base = {
    ...record,
    proxy: includeSecrets ? proxyForRuntime(record.proxy) : sanitizeProxyForSync(proxyForRuntime(record.proxy))
  };
  if (includeSecrets) {
    base.ssh = secretForRuntime(secretForRuntime(record.ssh || {}, "password"), "privateKey");
  } else {
    const ssh = record.ssh || {};
    base.ssh = {
      host: ssh.host || "",
      port: ssh.port || 22,
      username: ssh.username || "root",
      hasPassword: Boolean(ssh.passwordEnc || ssh.password),
      hasPrivateKey: Boolean(ssh.privateKeyEnc || ssh.privateKey)
    };
  }
  return base;
}

function getVpsProxies(options = {}) {
  const data = readJson(getVpsProxyFile(), []);
  return Array.isArray(data) ? data.map((r) => vpsForRuntime(r, Boolean(options.includeSecrets))) : [];
}

function saveVpsProxies(records) {
  writeJson(getVpsProxyFile(), Array.isArray(records) ? records.map(vpsForDisk) : []);
}

function upsertVpsProxy(record) {
  const records = getVpsProxies({ includeSecrets: true });
  const now = Date.now();
  const id = record.id || generateId();
  const idx = records.findIndex((r) => r.id === id);
  const next = {
    ...(idx === -1 ? {} : records[idx]),
    ...record,
    id,
    updatedAt: now,
    createdAt: idx === -1 ? now : records[idx].createdAt || now
  };
  if (idx === -1) records.push(next);
  else records[idx] = next;
  saveVpsProxies(records);
  return vpsForRuntime(next, false);
}

function deleteVpsProxy(id) {
  const records = getVpsProxies({ includeSecrets: true }).filter((r) => r.id !== id);
  saveVpsProxies(records);
}

// Android cloud phone records. The app manages provider/device metadata and
// opens provider-hosted consoles; it does not create Android OS instances by itself.
function getCloudPhoneProviderConfig() {
  const data = readJson(getCloudPhoneProviderFile(), {});
  return {
    endpoint: typeof data.endpoint === "string" ? data.endpoint : "",
    token: typeof data.tokenEnc === "string" ? decryptSecret(data.tokenEnc) : (typeof data.token === "string" ? data.token : ""),
    authMode: ["bearer", "x-api-key", "none"].includes(data.authMode) ? data.authMode : "bearer"
  };
}

function saveCloudPhoneProviderConfig(config = {}) {
  const existing = getCloudPhoneProviderConfig();
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : existing.endpoint;
  const authMode = ["bearer", "x-api-key", "none"].includes(config.authMode) ? config.authMode : existing.authMode;
  const token = typeof config.token === "string" && config.token.length ? config.token : existing.token;
  const saved = {
    endpoint,
    tokenEnc: config.clearToken ? "" : encryptSecret(token),
    authMode
  };
  writeJson(getCloudPhoneProviderFile(), saved);
  return { endpoint: saved.endpoint, token: config.clearToken ? "" : token, authMode: saved.authMode };
}

function normalizeAndroidVersion(value) {
  const v = String(value || "14").trim();
  return ["10", "11", "12", "13", "14", "15"].includes(v) ? v : "14";
}

function normalizeCloudPhoneRecord(record = {}, existing = {}) {
  const now = Date.now();
  return {
    ...existing,
    id: record.id || existing.id || generateId(),
    label: String(record.label || existing.label || "Android Cloud Phone").trim(),
    provider: String(record.provider || existing.provider || "").trim(),
    country: String(record.country || existing.country || "").toLowerCase(),
    androidVersion: normalizeAndroidVersion(record.androidVersion || existing.androidVersion),
    model: String(record.model || existing.model || "Pixel 8").trim(),
    manufacturer: String(record.manufacturer || existing.manufacturer || "Google").trim(),
    imei: String(record.imei || existing.imei || "").replace(/[^\d]/g, "").slice(0, 17),
    hardwareFingerprint: String(record.hardwareFingerprint || existing.hardwareFingerprint || "").trim(),
    remoteUrl: String(record.remoteUrl || existing.remoteUrl || "").trim(),
    status: ["available", "running", "stopped", "busy", "offline"].includes(record.status) ? record.status : (existing.status || "available"),
    profileId: record.profileId || existing.profileId || "",
    notes: record.notes || existing.notes || "",
    createdAt: existing.createdAt || record.createdAt || now,
    updatedAt: now
  };
}

function getCloudPhones() {
  const data = readJson(getCloudPhoneFile(), []);
  return Array.isArray(data) ? data.map((record) => normalizeCloudPhoneRecord(record)) : [];
}

function saveCloudPhones(records) {
  writeJson(getCloudPhoneFile(), Array.isArray(records) ? records.map((record) => normalizeCloudPhoneRecord(record)) : []);
}

function upsertCloudPhone(record) {
  const records = getCloudPhones();
  const id = record.id || generateId();
  const idx = records.findIndex((item) => item.id === id);
  const next = normalizeCloudPhoneRecord({ ...record, id }, idx === -1 ? {} : records[idx]);
  if (idx === -1) records.push(next);
  else records[idx] = next;
  saveCloudPhones(records);
  return next;
}

function deleteCloudPhone(id) {
  saveCloudPhones(getCloudPhones().filter((record) => record.id !== id));
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
    fingerprintSeed: "", hardwareId: "", fontProfile: "windows", installedFonts: [],
    colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1,
    deviceClass: "desktop", mobileModel: "", mobileManufacturer: "", platformVersion: "", androidBuild: "",
    architecture: "x86", bitness: "64", maxTouchPoints: 0, screenOrientation: "landscape-primary",
    touchEmulation: false, sensorEmulation: false, viewportMobile: false, pointerType: "fine", hoverType: "hover",
    deviceMotion: null, deviceOrientation: null,
    ports: "block", blockedPorts: [3389, 5938],
    doNotTrack: false,
    webrtc: "altered", webrtcIP: "",
    blockStorage: false, blockCookies: false,
    tlsSpoof: false,
    spoofingLevel: "full", spoofSkipHosts: [],
    browserVersion: "auto",
    ispName: "", ispAsn: "", ispOrg: "", city: "", state: ""
  };
}

function getDefaultProxy() {
  return { networkMode: "direct", enabled: false, scheme: "socks5", host: "", port: 1080, username: "", password: "", rotationUrl: "", bypassList: [] };
}

function normalizeEngine(engine) {
  const value = String(engine || "").toLowerCase();
  if (value === "stealthfox" || value === "real-chrome" || value === "real-brave" || value === "patched-chromium") return value;
  return "chromium";
}

function isRealBrowserEngine(engine) {
  const e = String(engine || "").toLowerCase();
  return e === "real-chrome" || e === "real-brave" || e === "patched-chromium";
}

function isPatchedChromiumEngine(engine) {
  return String(engine || "").toLowerCase() === "patched-chromium";
}

function realBrowserRuntimeLabel(engine) {
  const e = String(engine || "").toLowerCase();
  if (e === "real-brave") return "Real Brave";
  if (e === "patched-chromium") return "Patched Chromium";
  return "Real Google Chrome";
}

// ── CRUD operations ────────────────────────────────────────────────────────────

function syncProfileBg(profile) {
  // Fire-and-forget cloud sync — never block local writes on the network
  try {
    const cloud = require("./cloud-sync");
    cloud.pushProfile(sanitizeProfileForSync(profile)).catch(() => {});
  } catch (_) {}
}

function syncDeleteProfileBg(id) {
  try {
    const cloud = require("./cloud-sync");
    cloud.deleteProfileRemote(id).catch(() => {});
  } catch (_) {}
}

// Build a fully-formed profile object from user data WITHOUT touching disk.
// Shared by createProfile (single) and createProfilesBatch (bulk) so the two
// paths can never drift.
function buildNewProfile(data, nameIndex) {
  const now = Date.now();
  const profile = {
    id: generateId(),
    name: data.name || "Profile " + nameIndex,
    status: data.status || "new",
    tags: Array.isArray(data.tags) ? data.tags : [],
    notes: data.notes || "",
    os: data.os || "windows",
    browserApp: data.browserApp || "chrome",
    windowMode: data.windowMode || "normal",
    // Which engine launches on Start. External real-browser modes use installed
    // Chrome/Brave with a separate user-data dir per profile.
    engine: normalizeEngine(data.engine),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    fingerprint: data.fingerprint || getDefaultFingerprint(),
    proxy: data.proxy || getDefaultProxy(),
    extensions: Array.isArray(data.extensions) ? data.extensions : [],
    cookies: data.cookies || [],
    localStorageData: data.localStorageData || {},
    session: data.session || null
  };
  profile.fingerprint = normalizeProfileFingerprint(profile, { randomizeDefaultGpu: true });
  return profile;
}

function createProfile(data) {
  const profiles = getProfiles();
  const profile = buildNewProfile(data, profiles.length + 1);
  profiles.push(profile);
  saveProfiles(profiles);
  syncProfileBg(profile);
  return profile;
}

// Create many profiles in ONE read + ONE write + ONE batched cloud push.
// Replaces looping createProfile() (which re-read and re-wrote the entire,
// ever-growing file per profile — O(n²) synchronous disk I/O that froze the
// UI on bulk generate, and fired one Supabase request per profile).
function createProfilesBatch(dataList) {
  const list = Array.isArray(dataList) ? dataList : [];
  if (!list.length) return [];
  const profiles = getProfiles();
  const created = [];
  for (let i = 0; i < list.length; i++) {
    const profile = buildNewProfile(list[i], profiles.length + 1);
    profiles.push(profile);
    created.push(profile);
  }
  saveProfiles(profiles);            // single write
  // Single batched cloud push (fire-and-forget) instead of N requests.
  try {
    const cloud = require("./cloud-sync");
    cloud.pushAllProfiles(created.map(sanitizeProfileForSync)).catch(() => {});
  } catch (_) {}
  return created;
}

function updateProfile(id, data) {
  const profiles = getProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = profiles[idx];
  profiles[idx] = { ...existing, ...data, id, updatedAt: Date.now() };
  if (data.fingerprint) profiles[idx].fingerprint = { ...existing.fingerprint, ...data.fingerprint };
  if (data.proxy) {
    const nextProxy = { ...existing.proxy, ...data.proxy };
    if (Object.prototype.hasOwnProperty.call(data.proxy, "password") && data.proxy.password === "" && existing.proxy?.password) {
      nextProxy.password = existing.proxy.password;
    }
    profiles[idx].proxy = nextProxy;
  }
  profiles[idx].engine = normalizeEngine(profiles[idx].engine);
  profiles[idx].fingerprint = normalizeProfileFingerprint(profiles[idx], { randomizeDefaultGpu: false });
  saveProfiles(profiles);
  syncProfileBg(profiles[idx]);
  return profiles[idx];
}

function deleteProfile(id, hard = false) {
  let profiles = getProfiles();
  if (hard) {
    profiles = profiles.filter((p) => p.id !== id);
    syncDeleteProfileBg(id);
  } else {
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx !== -1) {
      profiles[idx].deletedAt = Date.now();
      syncProfileBg(profiles[idx]);
    }
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
  copy.fingerprint = normalizeProfileFingerprint(copy, { regenerateIdentity: true, randomizeDefaultGpu: true });
  profiles.push(copy);
  saveProfiles(profiles);
  syncProfileBg(copy);
  return copy;
}

// Permanently remove ALL soft-deleted (trashed) profiles in one local write,
// then fire the Supabase row deletions in the background. Much faster than
// hard-deleting one id at a time (which rewrites the whole file each call).
function purgeDeletedProfiles() {
  const profiles = getProfiles();
  const deleted = profiles.filter((p) => p.deletedAt);
  if (!deleted.length) return 0;
  const kept = profiles.filter((p) => !p.deletedAt);
  saveProfiles(kept);
  for (const p of deleted) syncDeleteProfileBg(p.id);
  return deleted.length;
}

function restoreProfile(id) {
  return updateProfile(id, { deletedAt: null });
}

// ── Proxy library CRUD ─────────────────────────────────────────────────────────

function syncProxyLibBg() {
  try {
    const cloud = require("./cloud-sync");
    cloud.pushAllProxies(getProxyLibrary().map(sanitizeProxyForSync)).catch(() => {});
  } catch (_) {}
}

function addProxyEntry(entry) {
  const lib = getProxyLibrary();
  const newEntry = { id: generateId(), source: "private", private: true, useCount: 0, lastUsedAt: null, ...entry };
  lib.push(newEntry);
  saveProxyLibrary(lib);
  syncProxyLibBg();
  return newEntry;
}

function updateProxyEntry(id, data) {
  const lib = getProxyLibrary();
  const idx = lib.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  lib[idx] = { ...lib[idx], ...data, id };
  saveProxyLibrary(lib);
  syncProxyLibBg();
  return lib[idx];
}

function deleteProxyEntry(id) {
  const lib = getProxyLibrary().filter((e) => e.id !== id);
  saveProxyLibrary(lib);
  try {
    const cloud = require("./cloud-sync");
    cloud.deleteProxyRemote(id).catch(() => {});
  } catch (_) {}
}

function markProxyUsed(id) {
  const lib = getProxyLibrary();
  const idx = lib.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  lib[idx] = {
    ...lib[idx],
    useCount: Number(lib[idx].useCount || 0) + 1,
    lastUsedAt: Date.now()
  };
  saveProxyLibrary(lib);
  syncProxyLibBg();
  return lib[idx];
}

function pickPrivateProxy(country) {
  const wanted = String(country || "").toLowerCase();
  const lib = getProxyLibrary();
  const candidates = lib
    .filter((e) => e && e.host && e.port)
    .filter((e) => e.private !== false && e.source !== "public")
    .filter((e) => !wanted || e.country === wanted || e.country === "")
    .sort((a, b) => {
      const uses = Number(a.useCount || 0) - Number(b.useCount || 0);
      if (uses !== 0) return uses;
      return Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0);
    });
  return candidates[0] || null;
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

const COUNTRY_IDENTITY_DATA = {
  us: {
    country: "United States", continent: "North America", language: "en-US",
    cities: [
      { city: "New York", state: "New York", timezone: "America/New_York", offset: 300, lat: 40.7128, lng: -74.0060, providers: [["Comcast Cable Communications", "7922", "Comcast Cable"], ["Verizon Business", "701", "Verizon Business"]] },
      { city: "Los Angeles", state: "California", timezone: "America/Los_Angeles", offset: 480, lat: 34.0522, lng: -118.2437, providers: [["Charter Communications", "20115", "Spectrum"], ["AT&T Services", "7018", "AT&T Internet"]] },
      { city: "Chicago", state: "Illinois", timezone: "America/Chicago", offset: 360, lat: 41.8781, lng: -87.6298, providers: [["Comcast Cable Communications", "7922", "Comcast Cable"], ["RCN", "6079", "Astound Broadband"]] }
    ]
  },
  gb: {
    country: "United Kingdom", continent: "Europe", language: "en-GB",
    cities: [
      { city: "London", state: "England", timezone: "Europe/London", offset: 0, lat: 51.5074, lng: -0.1278, providers: [["BT Group plc", "2856", "BT Group plc"], ["Virgin Media", "5089", "Virgin Media"]] },
      { city: "Manchester", state: "England", timezone: "Europe/London", offset: 0, lat: 53.4808, lng: -2.2426, providers: [["Sky UK Limited", "5607", "Sky Broadband"], ["TalkTalk Communications", "13285", "TalkTalk"]] }
    ]
  },
  de: {
    country: "Germany", continent: "Europe", language: "de-DE",
    cities: [
      { city: "Berlin", state: "Berlin", timezone: "Europe/Berlin", offset: -60, lat: 52.52, lng: 13.405, providers: [["Deutsche Telekom AG", "3320", "Deutsche Telekom AG"], ["Vodafone GmbH", "3209", "Vodafone GmbH"]] },
      { city: "Frankfurt", state: "Hesse", timezone: "Europe/Berlin", offset: -60, lat: 50.1109, lng: 8.6821, providers: [["Telefonica Germany", "6805", "Telefonica Germany"], ["1&1 Versatel", "8881", "1&1 Versatel"]] }
    ]
  },
  nl: {
    country: "Netherlands", continent: "Europe", language: "nl-NL",
    cities: [
      { city: "Amsterdam", state: "North Holland", timezone: "Europe/Amsterdam", offset: -60, lat: 52.3676, lng: 4.9041, providers: [["KPN Netherlands", "1136", "KPN Netherlands"], ["VodafoneZiggo", "33915", "VodafoneZiggo"]] },
      { city: "Rotterdam", state: "South Holland", timezone: "Europe/Amsterdam", offset: -60, lat: 51.9244, lng: 4.4777, providers: [["T-Mobile Thuis", "50266", "Odido"], ["KPN Netherlands", "1136", "KPN Netherlands"]] }
    ]
  },
  fr: {
    country: "France", continent: "Europe", language: "fr-FR",
    cities: [
      { city: "Paris", state: "Ile-de-France", timezone: "Europe/Paris", offset: -60, lat: 48.8566, lng: 2.3522, providers: [["Orange S.A.", "3215", "Orange S.A."], ["Free SAS", "12322", "Free SAS"]] },
      { city: "Lyon", state: "Auvergne-Rhone-Alpes", timezone: "Europe/Paris", offset: -60, lat: 45.764, lng: 4.8357, providers: [["Bouygues Telecom", "5410", "Bouygues Telecom"], ["SFR SA", "15557", "SFR SA"]] }
    ]
  },
  ch: {
    country: "Switzerland", continent: "Europe", language: "de-DE",
    cities: [
      { city: "Zurich", state: "Zurich", timezone: "Europe/Zurich", offset: -60, lat: 47.3769, lng: 8.5417, providers: [["Swisscom AG", "3303", "Swisscom AG"], ["Sunrise GmbH", "6730", "Sunrise GmbH"]] },
      { city: "Geneva", state: "Geneva", timezone: "Europe/Zurich", offset: -60, lat: 46.2044, lng: 6.1432, providers: [["Salt Mobile SA", "15796", "Salt Mobile SA"], ["Swisscom AG", "3303", "Swisscom AG"]] }
    ]
  },
  se: {
    country: "Sweden", continent: "Europe", language: "sv-SE",
    cities: [
      { city: "Stockholm", state: "Stockholm", timezone: "Europe/Stockholm", offset: -60, lat: 59.3293, lng: 18.0686, providers: [["Telia Company AB", "1257", "Telia Company AB"], ["Tele2 Sverige AB", "1257", "Tele2 Sverige AB"]] },
      { city: "Gothenburg", state: "Vastra Gotaland", timezone: "Europe/Stockholm", offset: -60, lat: 57.7089, lng: 11.9746, providers: [["Telenor Sverige AB", "2119", "Telenor Sverige AB"], ["Bahnhof AB", "8473", "Bahnhof AB"]] }
    ]
  },
  ca: {
    country: "Canada", continent: "North America", language: "en-CA",
    cities: [
      { city: "Toronto", state: "Ontario", timezone: "America/Toronto", offset: 300, lat: 43.6532, lng: -79.3832, providers: [["Rogers Communications Inc.", "812", "Rogers Communications"], ["Bell Canada", "577", "Bell Canada"]] },
      { city: "Vancouver", state: "British Columbia", timezone: "America/Vancouver", offset: 480, lat: 49.2827, lng: -123.1207, providers: [["TELUS Communications", "852", "TELUS Communications"], ["Shaw Communications", "6327", "Shaw Communications"]] }
    ]
  },
  au: {
    country: "Australia", continent: "Oceania", language: "en-AU",
    cities: [
      { city: "Sydney", state: "New South Wales", timezone: "Australia/Sydney", offset: -600, lat: -33.8688, lng: 151.2093, providers: [["Telstra Corporation Ltd", "1221", "Telstra Corporation"], ["Optus Internet", "4804", "Optus Internet"]] },
      { city: "Melbourne", state: "Victoria", timezone: "Australia/Melbourne", offset: -600, lat: -37.8136, lng: 144.9631, providers: [["TPG Telecom", "7545", "TPG Telecom"], ["Aussie Broadband", "4764", "Aussie Broadband"]] }
    ]
  },
  jp: {
    country: "Japan", continent: "Asia", language: "ja-JP",
    cities: [
      { city: "Tokyo", state: "Tokyo", timezone: "Asia/Tokyo", offset: -540, lat: 35.6762, lng: 139.6503, providers: [["NTT Communications Corporation", "2914", "NTT Communications"], ["KDDI Corporation", "2516", "KDDI Corporation"]] },
      { city: "Osaka", state: "Osaka", timezone: "Asia/Tokyo", offset: -540, lat: 34.6937, lng: 135.5023, providers: [["SoftBank Corp.", "17676", "SoftBank Corp."], ["Internet Initiative Japan", "2497", "IIJ"]] }
    ]
  },
  sg: {
    country: "Singapore", continent: "Asia", language: "en-SG",
    cities: [
      { city: "Singapore", state: "Singapore", timezone: "Asia/Singapore", offset: -480, lat: 1.3521, lng: 103.8198, providers: [["Singtel Fibre Broadband", "9506", "Singtel Fibre"], ["StarHub Internet", "4657", "StarHub Internet"], ["M1 Limited", "17547", "M1 Limited"]] }
    ]
  },
  br: {
    country: "Brazil", continent: "South America", language: "pt-BR",
    cities: [
      { city: "Sao Paulo", state: "Sao Paulo", timezone: "America/Sao_Paulo", offset: 180, lat: -23.5505, lng: -46.6333, providers: [["Claro NXT Telecomunicacoes Ltda", "28573", "Claro NXT Telecomunicacoes"], ["Telefonica Brasil S.A.", "27699", "Vivo"]] },
      { city: "Rio de Janeiro", state: "Rio de Janeiro", timezone: "America/Sao_Paulo", offset: 180, lat: -22.9068, lng: -43.1729, providers: [["Oi S.A.", "7738", "Oi S.A."], ["TIM Brasil", "26615", "TIM Brasil"]] }
    ]
  },
  in: {
    country: "India", continent: "Asia", language: "hi-IN",
    cities: [
      { city: "Mumbai", state: "Maharashtra", timezone: "Asia/Kolkata", offset: -330, lat: 19.076, lng: 72.8777, providers: [["Reliance Jio Infocomm Limited", "55836", "Reliance Jio Infocomm"], ["Bharti Airtel Ltd.", "45609", "Bharti Airtel"]] },
      { city: "Delhi", state: "Delhi", timezone: "Asia/Kolkata", offset: -330, lat: 28.6139, lng: 77.209, providers: [["Tata Teleservices", "45820", "Tata Teleservices"], ["ACT Fibernet", "24309", "ACT Fibernet"]] }
    ]
  },
  ae: {
    country: "United Arab Emirates", continent: "Asia", language: "ar-AE",
    cities: [
      { city: "Dubai", state: "Dubai", timezone: "Asia/Dubai", offset: -240, lat: 25.2048, lng: 55.2708, providers: [["Emirates Integrated Telecom", "15802", "du"], ["Etisalat UAE", "5384", "Etisalat UAE"]] },
      { city: "Abu Dhabi", state: "Abu Dhabi", timezone: "Asia/Dubai", offset: -240, lat: 24.4539, lng: 54.3773, providers: [["Etisalat UAE", "5384", "Etisalat UAE"], ["Emirates Integrated Telecom", "15802", "du"]] }
    ]
  },
  ru: {
    country: "Russia", continent: "Europe", language: "ru-RU",
    cities: [
      { city: "Moscow", state: "Moscow", timezone: "Europe/Moscow", offset: -180, lat: 55.7558, lng: 37.6173, providers: [["Rostelecom", "12389", "Rostelecom"], ["MTS PJSC", "8359", "MTS PJSC"]] },
      { city: "Saint Petersburg", state: "Saint Petersburg", timezone: "Europe/Moscow", offset: -180, lat: 59.9311, lng: 30.3609, providers: [["ER-Telecom", "9049", "ER-Telecom"], ["Beeline", "3216", "Beeline"]] }
    ]
  },
  tr: {
    country: "Turkey", continent: "Asia", language: "tr-TR",
    cities: [
      { city: "Istanbul", state: "Istanbul", timezone: "Europe/Istanbul", offset: -180, lat: 41.0082, lng: 28.9784, providers: [["Turk Telekomunikasyon A.S.", "9121", "Turk Telekomunikasyon"], ["Turkcell Superonline", "34984", "Turkcell Superonline"]] },
      { city: "Ankara", state: "Ankara", timezone: "Europe/Istanbul", offset: -180, lat: 39.9334, lng: 32.8597, providers: [["Vodafone Net", "8386", "Vodafone Net"], ["Turk Telekomunikasyon A.S.", "9121", "Turk Telekomunikasyon"]] }
    ]
  },
  ng: {
    country: "Nigeria", continent: "Africa", language: "en-US",
    cities: [
      { city: "Lagos", state: "Lagos State", timezone: "Africa/Lagos", offset: -60, lat: 6.5244, lng: 3.3792, providers: [["Airtel Networks Limited", "36873", "Airtel Networks Limited"], ["MTN Nigeria", "29465", "MTN Nigeria"]] },
      { city: "Abuja", state: "Federal Capital Territory", timezone: "Africa/Lagos", offset: -60, lat: 9.0765, lng: 7.3986, providers: [["Glo Mobile", "37148", "Globacom Limited"], ["Smile Telecoms", "37684", "Smile Telecoms"]] }
    ]
  }
};

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function jitter(value, amount = 0.035) {
  return Number((Number(value) + ((Math.random() * 2 - 1) * amount)).toFixed(6));
}

const ANDROID_DEVICE_PROFILES = [
  {
    manufacturer: "Google", model: "Pixel 8", android: "14", build: "UP1A.231005.007",
    screen: [412, 915], dpr: 2.625, cores: 8, ram: 8,
    gpuVendor: "Qualcomm", gpuRenderer: "Adreno (TM) 740"
  },
  {
    manufacturer: "Google", model: "Pixel 7", android: "14", build: "UP1A.231005.007",
    screen: [412, 915], dpr: 2.625, cores: 8, ram: 8,
    gpuVendor: "ARM", gpuRenderer: "Mali-G710"
  },
  {
    manufacturer: "Samsung", model: "SM-S911B", android: "14", build: "UP1A.231005.007",
    screen: [384, 854], dpr: 3, cores: 8, ram: 8,
    gpuVendor: "Qualcomm", gpuRenderer: "Adreno (TM) 740"
  },
  {
    manufacturer: "Samsung", model: "SM-A546B", android: "14", build: "UP1A.231005.007",
    screen: [360, 800], dpr: 3, cores: 8, ram: 6,
    gpuVendor: "ARM", gpuRenderer: "Mali-G68"
  },
  {
    manufacturer: "Xiaomi", model: "23021RAA2Y", android: "13", build: "TKQ1.221013.002",
    screen: [393, 873], dpr: 2.75, cores: 8, ram: 8,
    gpuVendor: "Qualcomm", gpuRenderer: "Adreno (TM) 619"
  },
  {
    manufacturer: "OnePlus", model: "CPH2449", android: "14", build: "UP1A.231005.007",
    screen: [412, 919], dpr: 3, cores: 8, ram: 12,
    gpuVendor: "Qualcomm", gpuRenderer: "Adreno (TM) 740"
  },
  {
    manufacturer: "Samsung", model: "SM-S921B", android: "14", build: "UP1A.231005.007",
    screen: [360, 780], dpr: 3, cores: 8, ram: 8,
    gpuVendor: "Qualcomm", gpuRenderer: "Adreno (TM) 750"
  }
];

const IOS_DEVICE_PROFILES = [
  {
    manufacturer: "Apple", model: "iPhone 15 Pro", ios: "17.2", build: "21C62",
    screen: [393, 852], dpr: 3, cores: 6, ram: 8,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  },
  {
    manufacturer: "Apple", model: "iPhone 15", ios: "17.2", build: "21C62",
    screen: [393, 852], dpr: 3, cores: 6, ram: 6,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  },
  {
    manufacturer: "Apple", model: "iPhone 14", ios: "16.6", build: "20G75",
    screen: [390, 844], dpr: 3, cores: 6, ram: 6,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  },
  {
    manufacturer: "Apple", model: "iPhone 13", ios: "17.1", build: "21B91",
    screen: [390, 844], dpr: 3, cores: 6, ram: 4,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  },
  {
    manufacturer: "Apple", model: "iPhone SE (3rd gen)", ios: "17.2", build: "21C62",
    screen: [375, 667], dpr: 2, cores: 6, ram: 4,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  },
  {
    manufacturer: "Apple", model: "iPad Air (5th gen)", ios: "17.2", build: "21C62",
    screen: [820, 1180], dpr: 2, cores: 8, ram: 8,
    gpuVendor: "Apple", gpuRenderer: "Apple GPU"
  }
];

function normalizeDeviceClass(value) {
  const v = String(value || "desktop").toLowerCase();
  if (["mobile", "android", "ios", "iphone", "ipad", "phone"].includes(v)) return "mobile";
  if (v === "random") return "random";
  return "desktop";
}

function normalizeBrowserApp(value, fallback = "chrome") {
  const v = String(value || "").toLowerCase();
  if (["privacy", "chrome", "brave", "edge", "firefox", "safari"].includes(v)) return v;
  if (v === "random") return "random";
  return fallback;
}

function randomDeviceName(osName) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 7; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  if (osName === "android") return randomChoice(["Pixel", "Galaxy", "Android"]) + "-" + suffix.slice(0, 5);
  if (osName === "ios") return randomChoice(["iPhone", "iPhone", "iPad"]) + "-" + suffix.slice(0, 5);
  if (osName === "macos") return randomChoice(["MacBook-Pro", "MacBook-Air", "iMac"]) + "-" + randomInt(10, 99);
  if (osName === "linux") return randomChoice(["ubuntu", "fedora", "debian", "workstation"]) + "-" + suffix.slice(0, 5).toLowerCase();
  return randomChoice(["DESKTOP", "LAPTOP", "PC", "WORKSTATION"]) + "-" + suffix;
}

function randomHardwareId(osName) {
  const hex = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
  if (osName === "android") return `ANDROID-${hex(4)}-${hex(4)}-${hex(2)}`;
  if (osName === "ios") return `IOS-${hex(4)}-${hex(4)}-${hex(2)}`;
  if (osName === "macos") return `MAC-${hex(4)}-${hex(2)}-${hex(2)}`;
  if (osName === "linux") return `LINUX-${hex(4)}-${hex(4)}`;
  return `{${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}}`;
}

function mobileSensorProfile() {
  return {
    motion: {
      acceleration: { x: 0, y: 0, z: 0 },
      accelerationIncludingGravity: {
        x: Number(((Math.random() - 0.5) * 0.08).toFixed(3)),
        y: Number(((Math.random() - 0.5) * 0.08).toFixed(3)),
        z: Number((9.78 + Math.random() * 0.08).toFixed(3))
      },
      rotationRate: {
        alpha: Number(((Math.random() - 0.5) * 0.18).toFixed(3)),
        beta: Number(((Math.random() - 0.5) * 0.18).toFixed(3)),
        gamma: Number(((Math.random() - 0.5) * 0.18).toFixed(3))
      },
      interval: 16
    },
    orientation: {
      alpha: randomInt(0, 359),
      beta: Number(((Math.random() - 0.5) * 4).toFixed(2)),
      gamma: Number(((Math.random() - 0.5) * 4).toFixed(2)),
      absolute: false
    }
  };
}

function fontListForOs(osName, language) {
  const common = ["Arial", "Arial Black", "Courier New", "Georgia", "Times New Roman", "Trebuchet MS", "Verdana", "Impact", "Comic Sans MS", "Webdings", "Symbol"];
  const windows = [
    "Calibri", "Cambria", "Candara", "Consolas", "Corbel", "Constantia", "Lucida Console", "Lucida Sans Unicode",
    "Segoe UI", "Segoe UI Symbol", "Segoe UI Emoji", "Tahoma", "Microsoft Sans Serif",
    "Palatino Linotype", "Book Antiqua", "Garamond", "Franklin Gothic Medium", "Century Gothic",
    "MS Sans Serif", "MS Serif", "Wingdings", "Wingdings 2", "Wingdings 3",
    "Arial Narrow", "Arial Rounded MT Bold", "Wide Latin", "Agency FB",
    "Baskerville Old Face", "Bell MT", "Bodoni MT", "Broadway", "Brush Script MT",
    "Copperplate Gothic Bold", "Copperplate Gothic Light", "Engravers MT",
    "Eras Bold ITC", "Eras Demi ITC", "Eras Light ITC", "Eras Medium ITC",
    "Footlight MT Light", "Forte", "French Script MT", "Gloucester MT Extra Condensed",
    "Goudy Old Style", "Harrington", "High Tower Text", "Jokerman", "Kristen ITC",
    "Magneto", "Mistral", "Modern No. 20", "Old English Text MT", "Onyx",
    "Palace Script MT", "Papyrus", "Perpetua", "Playbill", "Poor Richard", "Pristina",
    "Rage Italic", "Rockwell", "Rockwell Condensed", "Rockwell Extra Bold",
    "Script MT Bold", "Showcard Gothic", "Snap ITC", "Stencil", "Tempus Sans ITC",
    "Tw Cen MT", "Viner Hand ITC", "Vivaldi", "Vladimir Script"
  ];
  const mac = [
    "Avenir", "Avenir Next", "Avenir Next Condensed", "Geeza Pro", "Helvetica Neue", "Helvetica",
    "Menlo", "Monaco", "San Francisco", "Apple Color Emoji", "Apple Symbols", "Palatino",
    "Optima", "Futura", "Gill Sans", "Baskerville", "Didot", "Big Caslon",
    "Cochin", "Copperplate", "Hoefler Text", "Lucida Grande", "Marker Felt",
    "Noteworthy", "Papyrus", "Skia", "Zapfino", "Chalkboard SE", "Chalkduster",
    "American Typewriter", "Andale Mono", "Bradley Hand", "Brush Script MT",
    "Courier", "Herculanum", "Zapf Dingbats",
    "Hiragino Sans", "PingFang SC", "Songti SC"
  ];
  const ios = [
    "Helvetica Neue", "Helvetica", "Arial", "Courier New", "Georgia", "Times New Roman", "Verdana",
    "Arial Rounded MT Bold", "American Typewriter", "Avenir", "Avenir Next", "Avenir Next Condensed",
    "Baskerville", "Bodoni 72", "Bradley Hand", "Chalkboard SE", "Chalkduster", "Charter",
    "Cochin", "Copperplate", "DIN Alternate", "DIN Condensed", "Didact Gothic",
    "Futura", "Geeza Pro", "Gill Sans", "Hiragino Mincho ProN", "Hiragino Sans",
    "Hoefler Text", "Kailasa", "Marker Felt", "Menlo", "Noteworthy",
    "Optima", "Palatino", "Papyrus", "Rockwell", "San Francisco", "Apple Color Emoji",
    "Snell Roundhand", "Superclarendon", "Thonburi", "Zapf Dingbats", "Zapfino",
    "Apple SD Gothic Neo", "Farah", "Galvji", "Mishafi", "Noto Nastaliq Urdu"
  ];
  const linux = [
    "DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif",
    "Liberation Sans", "Liberation Serif", "Liberation Mono",
    "Noto Sans", "Noto Serif", "Noto Color Emoji", "Noto Mono",
    "Ubuntu", "Ubuntu Mono", "Ubuntu Condensed",
    "Cantarell", "FreeMono", "FreeSans", "FreeSerif",
    "Droid Sans", "Droid Serif", "Droid Sans Mono",
    "Source Code Pro", "Source Sans Pro", "Open Sans", "Roboto"
  ];
  const android = [
    "Roboto", "Roboto Thin", "Roboto Light", "Roboto Medium", "Roboto Bold", "Roboto Black",
    "Roboto Condensed", "Roboto Condensed Light", "Roboto Condensed Bold",
    "Noto Sans", "Noto Serif", "Noto Color Emoji", "Noto Emoji",
    "Droid Sans", "Droid Sans Fallback", "Droid Serif", "Droid Sans Mono",
    "Google Sans", "Google Sans Medium", "Google Sans Bold",
    "Cutive Mono", "Coming Soon", "Dancing Script", "Source Sans Pro"
  ];
  const locale = {
    "ja-JP": ["Yu Gothic", "Yu Gothic UI", "Meiryo", "Meiryo UI", "MS Gothic", "MS PGothic", "MS Mincho", "Noto Sans CJK JP", "Hiragino Sans"],
    "zh-CN": ["SimSun", "SimHei", "Microsoft YaHei", "FangSong", "KaiTi", "Noto Sans SC"],
    "zh-TW": ["MingLiU", "PMingLiU", "Microsoft JhengHei", "Noto Sans TC"],
    "ko-KR": ["Malgun Gothic", "Gulim", "Dotum", "Batang", "Noto Sans KR"],
    "de-DE": ["Bahnschrift", "Segoe UI"],
    "fr-FR": ["Segoe UI", "Calibri"],
    "ru-RU": ["Arial", "Times New Roman"],
    "ar-AE": ["Segoe UI", "Arial", "Tahoma", "Simplified Arabic"],
    "hi-IN": ["Nirmala UI", "Mangal", "Aparajita"],
    "pt-BR": ["Segoe UI", "Calibri"],
    "tr-TR": ["Segoe UI", "Arial"],
    "sv-SE": ["Segoe UI", "Calibri"],
    "nl-NL": ["Segoe UI", "Calibri"],
    "es-ES": ["Segoe UI", "Calibri"],
    "it-IT": ["Segoe UI", "Calibri"],
    "th-TH": ["Tahoma", "Leelawadee", "Leelawadee UI"],
    "vi-VN": ["Tahoma", "Arial"],
    "id-ID": ["Segoe UI", "Arial"]
  }[language] || [];
  const base = osName === "android" ? android : osName === "ios" ? ios : osName === "macos" ? mac : osName === "linux" ? linux : windows;
  return [...new Set([...common, ...base, ...locale])];
}

function resolvedFontListForProfile(fingerprint = {}, osName = "windows") {
  if (fingerprint.fonts === "blocked") return [];
  if (Array.isArray(fingerprint.installedFonts) && fingerprint.installedFonts.length) {
    return fingerprint.installedFonts.map((font) => String(font)).filter(Boolean);
  }
  const language = fingerprint.language === "manual" && fingerprint.languageValue
    ? fingerprint.languageValue
    : "en-US";
  return fontListForOs(fingerprint.fontProfile || osName, language);
}

function hasAnyToken(value, tokens) {
  const text = String(value || "").toLowerCase();
  return tokens.some((token) => text.includes(token));
}

function gpuLooksCompatibleWithOs(osName, vendor, renderer) {
  const text = `${vendor || ""} ${renderer || ""}`.toLowerCase();
  if (!text.trim()) return false;
  if (osName === "android") return hasAnyToken(text, ["adreno", "mali", "qualcomm", "arm", "powervr", "immortalis"]);
  if (osName === "ios") return hasAnyToken(text, ["apple"]);
  if (osName === "macos") return hasAnyToken(text, ["apple", "metal", "m1", "m2", "m3", "m4", "iris", "intel"]);
  if (osName === "linux") return hasAnyToken(text, ["mesa", "x.org", "llvm", "intel", "amd", "radeon", "nvidia"]);
  return hasAnyToken(text, ["direct3d", "d3d11", "nvidia", "geforce", "intel", "iris", "uhd", "amd", "radeon"]);
}

function findAndroidDeviceByModel(model) {
  const target = String(model || "").trim().toLowerCase();
  if (!target) return null;
  return ANDROID_DEVICE_PROFILES.find((device) => device.model.toLowerCase() === target) || null;
}

function findIOSDeviceByModel(model) {
  const target = String(model || "").trim().toLowerCase();
  if (!target) return null;
  return IOS_DEVICE_PROFILES.find((device) => device.model.toLowerCase() === target) || null;
}

function applyMobileDeviceDefaults(fp, osName) {
  const catalog = osName === "ios" ? IOS_DEVICE_PROFILES : ANDROID_DEVICE_PROFILES;
  const findByModel = osName === "ios" ? findIOSDeviceByModel : findAndroidDeviceByModel;

  const w = Number(fp.screenWidth) || 0;
  const h = Number(fp.screenHeight) || 0;
  const matchingDevice = catalog.find((d) => d.screen[0] === w && d.screen[1] === h);

  if (matchingDevice) {
    if (!fp.mobileModel || !findByModel(fp.mobileModel)) {
      fp.mobileModel = matchingDevice.model;
      fp.mobileManufacturer = matchingDevice.manufacturer;
      fp.platformVersion = matchingDevice.ios || matchingDevice.android || "";
      fp.androidBuild = matchingDevice.build || "";
    }
    return;
  }

  let device = findByModel(fp.mobileModel);
  if (!device) device = randomChoice(catalog);

  fp.screen = "manual";
  fp.screenWidth = device.screen[0];
  fp.screenHeight = device.screen[1];
  fp.devicePixelRatio = device.dpr;
  if (!fp.cpuCoresValue || Number(fp.cpuCoresValue) > 8) fp.cpuCoresValue = device.cores;
  if (!fp.ramValue || Number(fp.ramValue) > 12) fp.ramValue = device.ram;
  fp.mobileModel = device.model;
  fp.mobileManufacturer = device.manufacturer;
  fp.platformVersion = device.ios || device.android || "";
  fp.androidBuild = device.build || "";
  if (!gpuLooksCompatibleWithOs(osName, fp.webglVendor, fp.webglRenderer)) {
    fp.webglVendor = device.gpuVendor;
    fp.webglRenderer = device.gpuRenderer;
    fp.webglInfo = "manual";
  }
}

function osForCountry(countryCode, deviceClass = "desktop") {
  if (deviceClass === "mobile") return "android";
  if (countryCode === "au" || countryCode === "ch") return randomChoice(["macos", "windows", "windows"]);
  if (countryCode === "ng" || countryCode === "in") return randomChoice(["windows", "windows", "linux"]);
  return randomChoice(["windows", "windows", "windows", "macos"]);
}

function browserForOs(osName, requestedBrowser = "random") {
  let requested = normalizeBrowserApp(requestedBrowser, "random");
  // Safari (WebKit) and Firefox (Gecko) aren't real engines in this Chromium
  // build — claiming them creates a detectable UA-vs-engine mismatch. Always
  // coerce to Chrome so the claimed browser matches the actual Blink engine.
  if (requested === "safari" || requested === "firefox") requested = "chrome";
  if (requested !== "random") return requested;
  if (osName === "android") return randomChoice(["privacy", "chrome", "chrome", "brave", "edge"]);
  if (osName === "ios") return randomChoice(["chrome", "chrome", "edge"]);
  const options = osName === "macos"
    ? ["privacy", "chrome", "chrome", "brave", "edge"]
    : ["privacy", "chrome", "chrome", "chrome", "brave", "edge"];
  return randomChoice(options);
}

// The REAL major version of the Chromium engine bundled with Electron (used only
// as a floor/reference). Kept for diagnostics; the claimed UA version is the
// current real-world Chrome (see LATEST_CHROME_BY_OS) because being a year behind
// the real release is itself a strong bot tell — real Chrome auto-updates.
function currentEngineMajor() {
  try {
    const v = String((process.versions && process.versions.chrome) || "").split(".")[0];
    if (v && Number(v) > 0) return v;
  } catch (_) {}
  return "126";
}

// Current real-world Chrome full versions per OS. UPDATE THIS as Chrome releases.
// (Last updated 2026-07-02.) "Auto" version resolves to the value for the profile
// OS so the User-Agent + Client-Hints match what real users are actually running.
// Kept in lockstep with the bundled Chromium engine major (150) so the claimed UA
// version never falls behind the real engine — a UA/engine mismatch is a bot tell.
const LATEST_CHROME_BY_OS = {
  windows: "150.0.7871.46",
  macos:   "150.0.7871.46",
  linux:   "150.0.7871.46",
  android: "150.0.7871.63",
  ios:     "150.0.7871.51"
};
const LATEST_CHROME_FALLBACK = "150.0.7871.46";

function latestChromeForOs(osName) {
  return LATEST_CHROME_BY_OS[String(osName || "").toLowerCase()] || LATEST_CHROME_FALLBACK;
}

// Current real-world versions for the other browsers (UPDATE as they release).
// Brave ships a plain Chrome UA (identified by the navigator.brave API, not the
// string) built on Chromium 150 as of Brave 1.92.x. Safari uses its own scheme.
const LATEST_BRAVE_CHROMIUM = "150.0.7871.46"; // Brave 1.92.132 → Chromium 150
const LATEST_SAFARI = "26.5.2";                // Safari 26.5.2 (2026-06-29)

function latestVersionFor(browser, osName) {
  const b = String(browser || "chrome").toLowerCase();
  if (b === "brave") return LATEST_BRAVE_CHROMIUM;
  if (b === "safari") return LATEST_SAFARI;
  // edge tracks Chrome closely; chrome / privacy / default → current Chrome for OS
  return latestChromeForOs(osName);
}

function versionForBrowser(browser, osName) {
  // Real users are on the current release (auto-updated). Spread across the two
  // or three most recent majors so a batch of profiles isn't all identical, but
  // never far behind — an old version is a tell on its own.
  const latestMajor = Number(String(latestChromeForOs(osName)).split(".")[0]) || 150;
  const majors = [latestMajor, latestMajor, latestMajor - 1].filter((n) => n > 0);
  return String(randomChoice(majors));
}

function screenForOs(osName) {
  if (osName === "android") {
    const device = randomChoice(ANDROID_DEVICE_PROFILES);
    return { width: device.screen[0], height: device.screen[1], device };
  }
  if (osName === "ios") {
    const device = randomChoice(IOS_DEVICE_PROFILES);
    return { width: device.screen[0], height: device.screen[1], device };
  }
  const windows = [[1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [2560, 1440]];
  const mac = [[1440, 900], [1512, 982], [1728, 1117], [2560, 1600]];
  const linux = [[1366, 768], [1440, 900], [1920, 1080], [1600, 900]];
  const [width, height] = randomChoice(osName === "macos" ? mac : osName === "linux" ? linux : windows);
  return { width, height };
}

function randomWebglForOs(osName) {
  if (osName === "android") {
    const device = randomChoice(ANDROID_DEVICE_PROFILES);
    return { vendor: device.gpuVendor, renderer: device.gpuRenderer, platform: "android", device };
  }
  if (osName === "ios") {
    const device = randomChoice(IOS_DEVICE_PROFILES);
    return { vendor: device.gpuVendor, renderer: device.gpuRenderer, platform: "ios", device };
  }
  const matches = PROFILE_WEBGL_PRESETS.filter((preset) => preset.platform === osName);
  return randomChoice(matches.length ? matches : PROFILE_WEBGL_PRESETS);
}

// Does a WebGL renderer string plausibly belong to this OS family? Detectors
// cross-check the reported GPU against the platform — an "Apple GPU" on Windows
// or an "ANGLE ... Direct3D11" on macOS/Linux is an instant tell.
function webglRendererMatchesOs(renderer, osName) {
  const r = String(renderer || "").toLowerCase();
  if (!r) return false;
  const isApple = r.includes("apple") || r.includes("metal");
  const isMobile = r.includes("adreno") || r.includes("mali") || r.includes("powervr") || r.includes("xclipse") || r.includes("immortalis");
  if (osName === "ios" || osName === "macos") return isApple;
  if (osName === "android") return isMobile;
  // windows / linux desktop: must not be Apple or a mobile GPU
  if (isApple || isMobile) return false;
  // Linux uses OpenGL, never Direct3D
  if (osName === "linux") return !r.includes("d3d") && !r.includes("direct3d");
  return true;
}

function isDefaultGpuFingerprint(fingerprint = {}) {
  const defaultFp = getDefaultFingerprint();
  return !fingerprint.webglVendor
    || !fingerprint.webglRenderer
    || (fingerprint.webglVendor === defaultFp.webglVendor && fingerprint.webglRenderer === defaultFp.webglRenderer);
}

function normalizeProfileFingerprint(profile = {}, options = {}) {
  const osName = profile.os || "windows";
  const fp = { ...getDefaultFingerprint(), ...(profile.fingerprint || {}) };
  const regenerateIdentity = Boolean(options.regenerateIdentity);

  if (regenerateIdentity || !fp.fingerprintSeed) {
    fp.fingerprintSeed = crypto.randomBytes(8).toString("hex");
  }
  if (regenerateIdentity || !fp.hardwareId) {
    fp.hardwareId = randomHardwareId(osName);
  }
  if (!fp.browser) {
    fp.browser = profile.browserApp || "chrome";
  }
  if (!fp.fontProfile || ((osName === "android" || osName === "ios") && !["android", "ios"].includes(fp.fontProfile))) {
    fp.fontProfile = osName;
  }
  if (!Array.isArray(fp.installedFonts) || !fp.installedFonts.length || fp.fontProfile !== (profile.fingerprint || {}).fontProfile) {
    fp.installedFonts = resolvedFontListForProfile(fp, osName);
  }
  fp.tlsSpoof = false;
  if (options.randomizeDefaultGpu && isDefaultGpuFingerprint(fp)) {
    const webgl = randomWebglForOs(osName);
    fp.webglInfo = "manual";
    fp.webglVendor = webgl.vendor;
    fp.webglRenderer = webgl.renderer;
  }
  // Vary the remaining hardware that getDefaultFingerprint() hard-codes (screen
  // 1920x1080, 4 cores, 8GB RAM, dpr 1). Left fixed, every plain "New Profile"
  // shares an identical screen+CPU+RAM signature — a cross-account linkability
  // cluster when many profiles run on one device. Only fires on create
  // (randomizeDefaultGpu) and only when the value is still the untouched default,
  // so it never clobbers a country-generated identity or a user's manual pick.
  if (options.randomizeDefaultGpu && (osName === "windows" || osName === "macos" || osName === "linux")) {
    const d = getDefaultFingerprint();
    if (Number(fp.screenWidth) === d.screenWidth && Number(fp.screenHeight) === d.screenHeight) {
      const s = screenForOs(osName);
      if (s && s.width && s.height) { fp.screen = "manual"; fp.screenWidth = s.width; fp.screenHeight = s.height; }
    }
    if (fp.cpuCoresValue === d.cpuCoresValue) { fp.cpuCores = "manual"; fp.cpuCoresValue = randomChoice([4, 4, 6, 8, 8, 12, 16]); }
    if (fp.ramValue === d.ramValue) { fp.ram = "manual"; fp.ramValue = randomChoice([8, 8, 16, 16, 32]); }
    if (Number(fp.devicePixelRatio) === d.devicePixelRatio) { fp.devicePixelRatio = randomChoice([1, 1, 1.25, 1.5]); }
  }
  if (regenerateIdentity && fp.deviceName === "manual") {
    fp.deviceNameValue = randomDeviceName(osName);
  }
  if (osName === "android" || osName === "ios") {
    fp.deviceClass = "mobile";
    fp.architecture = "arm";
    fp.maxTouchPoints = Number(fp.maxTouchPoints) || 5;
    fp.screenOrientation = fp.screenOrientation || "portrait-primary";
    fp.touchEmulation = true;
    fp.sensorEmulation = true;
    fp.viewportMobile = true;
    fp.pointerType = "coarse";
    fp.hoverType = "none";
    applyMobileDeviceDefaults(fp, osName);
  }

  // ── Cross-field coherence enforcement (the auto-fixer) ────────────────────────
  // Runs on every save so a profile can never drift into a self-contradiction a
  // detector would catch: UA-version vs real engine, WebGL-GPU vs OS, and a
  // desktop OS still carrying mobile-only traits from a previous mobile pick.
  {
    // 1) WebGL GPU must match the OS family — re-pick a matching one if not.
    //    Enforced regardless of webglInfo mode ("manual"/"noise"/"real"): a stored
    //    renderer that contradicts the OS (e.g. an Apple/Metal string on a Windows
    //    profile, or a Direct3D11 string on macOS) is an instant ban tell wherever
    //    it surfaces — runtime injection, coherence audits, or cloud sync — so it
    //    must never persist, even when the user picked noise/passthrough mode.
    if (fp.webglRenderer && !webglRendererMatchesOs(fp.webglRenderer, osName)) {
      const webgl = randomWebglForOs(osName);
      fp.webglVendor = webgl.vendor;
      fp.webglRenderer = webgl.renderer;
    }

    // 2) A desktop OS must not keep mobile-only traits (touch, arm, coarse
    //    pointer) left over from a prior mobile OS selection.
    if (osName === "windows" || osName === "macos" || osName === "linux") {
      if (fp.deviceClass === "mobile") fp.deviceClass = "desktop";
      if (fp.architecture === "arm" && osName !== "macos") fp.architecture = "x86";
      fp.touchEmulation = false;
      fp.sensorEmulation = false;
      fp.viewportMobile = false;
      fp.pointerType = "fine";
      fp.hoverType = "hover";
      if (Number(fp.maxTouchPoints) > 0 && !(fp.screen === "manual" && Number(fp.screenWidth) > 1000)) fp.maxTouchPoints = 0;
    }
  }

  return fp;
}

function buildCountryIdentity(countryCode = "us", options = {}) {
  const code = String(countryCode || "us").toLowerCase();
  const country = COUNTRY_IDENTITY_DATA[code] || COUNTRY_IDENTITY_DATA.us;
  const city = randomChoice(country.cities);
  const provider = randomChoice(city.providers);
  const requestedDeviceClass = normalizeDeviceClass(options.deviceClass || options.deviceType);
  const deviceClass = requestedDeviceClass === "random"
    ? randomChoice(["desktop", "desktop", "desktop", "mobile"])
    : requestedDeviceClass;
  // Honor an explicit OS (e.g. the "Generate coherent identity" button keeps the
  // profile's chosen OS) so long as it agrees with the device class; otherwise
  // pick a plausible OS for the country + device class.
  const explicitOs = options.os && String(options.os).toLowerCase();
  const osMatchesClass = explicitOs && (
    (deviceClass === "mobile" && (explicitOs === "android" || explicitOs === "ios")) ||
    (deviceClass !== "mobile" && (explicitOs === "windows" || explicitOs === "macos" || explicitOs === "linux"))
  );
  const osName = osMatchesClass ? explicitOs : osForCountry(code, deviceClass);
  const browser = browserForOs(osName, options.browserApp || options.browser || "random");
  const screen = screenForOs(osName);
  const mobileDevice = (osName === "android" || osName === "ios") ? screen.device : null;
  const webgl = mobileDevice
    ? { vendor: mobileDevice.gpuVendor, renderer: mobileDevice.gpuRenderer }
    : randomWebglForOs(osName);
  const cores = mobileDevice ? mobileDevice.cores : randomChoice([2, 4, 4, 6, 8, 8, 12, 16]);
  const ram = mobileDevice ? mobileDevice.ram : randomChoice([4, 8, 8, 16, 16, 32]);
  const dpr = mobileDevice ? mobileDevice.dpr : randomChoice([1, 1, 1.25, 1.5, 2]);
  const connectionType = mobileDevice ? randomChoice(["cellular", "cellular", "wifi"]) : randomChoice(["wifi", "wifi", "ethernet"]);
  const sensors = mobileDevice ? mobileSensorProfile() : null;

  return {
    deviceClass,
    countryCode: code,
    country: country.country,
    continent: country.continent,
    timezone: city.timezone,
    offset: city.offset,
    language: country.language,
    latitude: jitter(city.lat),
    longitude: jitter(city.lng),
    city: city.city,
    state: city.state,
    organization: provider[2],
    ispName: provider[0],
    ispAsn: provider[1],
    ispOrg: provider[2],
    os: osName,
    browser,
    browserVersion: versionForBrowser(browser, osName),
    screenWidth: screen.width,
    screenHeight: screen.height,
    cpuCores: cores,
    ram,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    deviceName: mobileDevice ? `${mobileDevice.manufacturer}-${mobileDevice.model}` : randomDeviceName(osName),
    hardwareId: randomHardwareId(osName),
    fontProfile: osName,
    installedFonts: fontListForOs(osName, country.language),
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: dpr,
    mobileModel: mobileDevice ? mobileDevice.model : "",
    mobileManufacturer: mobileDevice ? mobileDevice.manufacturer : "",
    platformVersion: mobileDevice ? (mobileDevice.ios || mobileDevice.android || "") : "",
    androidBuild: mobileDevice ? (mobileDevice.build || "") : "",
    architecture: mobileDevice ? "arm" : "x86",
    bitness: "64",
    maxTouchPoints: mobileDevice ? randomChoice([5, 5, 10]) : 0,
    screenOrientation: mobileDevice ? "portrait-primary" : "landscape-primary",
    touchEmulation: Boolean(mobileDevice),
    sensorEmulation: Boolean(mobileDevice),
    viewportMobile: Boolean(mobileDevice),
    pointerType: mobileDevice ? "coarse" : "fine",
    hoverType: mobileDevice ? "none" : "hover",
    deviceMotion: sensors ? sensors.motion : null,
    deviceOrientation: sensors ? sensors.orientation : null,
    connectionType,
    downlink: mobileDevice ? randomChoice([3.5, 5, 8, 12, 18]) : randomChoice([8.5, 10, 12, 18, 25, 40]),
    rtt: mobileDevice ? randomChoice([45, 60, 80, 110, 150]) : randomChoice([25, 35, 50, 75, 100]),
    webrtc: "altered",
    cookies: [],
    ip: ""
  };
}

function buildCountryProfileData(countryCode = "us", idx = 1, options = {}) {
  const identity = buildCountryIdentity(countryCode, options);
  const fp = {
    ...getDefaultFingerprint(),
    browser: identity.browser,
    userAgent: "auto",
    userAgentValue: "",
    canvas: "noise",
    webgl: "noise",
    webglInfo: "manual",
    webglVendor: identity.webglVendor,
    webglRenderer: identity.webglRenderer,
    webgpu: false,
    clientRects: "real",
    timezone: "manual",
    timezoneValue: identity.timezone,
    timezoneOffset: identity.offset,
    language: "manual",
    languageValue: identity.language,
    geolocation: "manual",
    geoLat: identity.latitude,
    geoLng: identity.longitude,
    geoAccuracy: randomInt(25, 85),
    cpuCores: "manual",
    cpuCoresValue: identity.cpuCores,
    ram: "manual",
    ramValue: identity.ram,
    screen: "manual",
    screenWidth: identity.screenWidth,
    screenHeight: identity.screenHeight,
    audio: "noise",
    fonts: "real",
    mediaDevices: "real",
    cameras: randomChoice([1, 1, 2]),
    microphones: randomChoice([1, 1, 2]),
    speakers: randomChoice([1, 2]),
    deviceName: "manual",
    deviceNameValue: identity.deviceName,
    hardwareId: identity.hardwareId,
    fontProfile: identity.fontProfile,
    installedFonts: identity.installedFonts,
    colorDepth: identity.colorDepth,
    pixelDepth: identity.pixelDepth,
    devicePixelRatio: identity.devicePixelRatio,
    deviceClass: identity.deviceClass,
    mobileModel: identity.mobileModel,
    mobileManufacturer: identity.mobileManufacturer,
    platformVersion: identity.platformVersion,
    androidBuild: identity.androidBuild,
    architecture: identity.architecture,
    bitness: identity.bitness,
    maxTouchPoints: identity.maxTouchPoints,
    screenOrientation: identity.screenOrientation,
    touchEmulation: identity.touchEmulation,
    sensorEmulation: identity.sensorEmulation,
    viewportMobile: identity.viewportMobile,
    pointerType: identity.pointerType,
    hoverType: identity.hoverType,
    deviceMotion: identity.deviceMotion,
    deviceOrientation: identity.deviceOrientation,
    connectionType: identity.connectionType,
    downlink: identity.downlink,
    rtt: identity.rtt,
    ports: "block",
    blockedPorts: [3389, 5938],
    doNotTrack: false,
    webrtc: identity.webrtc,
    webrtcIP: "",
    blockStorage: false,
    blockCookies: false,
    browserVersion: identity.browserVersion,
    city: identity.city,
    state: identity.state,
    ispName: identity.ispName,
    ispAsn: identity.ispAsn,
    ispOrg: identity.ispOrg,
    countryCode: identity.countryCode,
    country: identity.country,
    continent: identity.continent,
    organization: identity.organization,
    ip: identity.ip,
    domain: ""
  };

  return {
    name: `${identity.country} ${identity.deviceClass === "mobile" ? "Mobile" : "Profile"} ${idx}`,
    status: "new",
    os: identity.os,
    browserApp: identity.browser,
    windowMode: "normal",
    tags: [identity.countryCode, identity.deviceClass, "country-profile"],
    fingerprint: fp,
    proxy: getDefaultProxy(),
    cookies: [],
    localStorageData: {}
  };
}

// ── Config builder (same logic as background.js:buildConfigFromProfile) ────────

function buildProfileUA(os, version, browser, fingerprint = {}) {
  const br = browser || "chrome";
  const v  = (!version || version === "auto") ? latestVersionFor(br, os) : String(version);
  const full = v.includes(".") ? v : v + ".0.0.0";
  const major = full.split(".")[0];

  if (os === "android") {
    const androidVersion = fingerprint.platformVersion || "14";
    const model = fingerprint.mobileModel || "Pixel 8";
    const build = fingerprint.androidBuild || "UP1A.231005.007";
    const browserToken = br === "edge"
      ? ` EdgA/${full}`
      : br === "privacy" ? ` PrivacyShield/${full}` : "";
    return {
      ua: `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model} Build/${build}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Mobile Safari/537.36${browserToken}`,
      platform: "Linux armv8l",
      os: "Android",
      version: major,
      platformVersion: androidVersion,
      mobile: true,
      model
    };
  }

  if (os === "ios") {
    const iosVersion = fingerprint.platformVersion || "26.5";
    const model = fingerprint.mobileModel || "iPhone 16";
    const isIpad = model.toLowerCase().includes("ipad");
    const iosVerUA = iosVersion.replace(/\./g, "_");
    const deviceUA = isIpad
      ? `(iPad; CPU OS ${iosVerUA} like Mac OS X)`
      : `(iPhone; CPU iPhone OS ${iosVerUA} like Mac OS X)`;
    const platform = isIpad ? "iPad" : "iPhone";
    let ua;
    switch (br) {
      case "firefox":
        ua = `Mozilla/5.0 ${deviceUA} AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${major}.0 Mobile/15E148 Safari/604.1`;
        break;
      case "edge":
        ua = `Mozilla/5.0 ${deviceUA} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${iosVersion} EdgiOS/${full} Mobile/15E148 Safari/604.1`;
        break;
      case "safari":
        ua = `Mozilla/5.0 ${deviceUA} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${iosVersion} Mobile/15E148 Safari/604.1`;
        break;
      default:
        ua = `Mozilla/5.0 ${deviceUA} AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${full} Mobile/15E148 Safari/604.1`;
    }
    return {
      ua,
      platform,
      os: "iOS",
      version: major,
      platformVersion: iosVersion,
      mobile: true,
      model
    };
  }

  const osStr = {
    macos:  { win: "Macintosh; Intel Mac OS X 10_15_7", platform: "MacIntel", os: "macOS" },
    linux:  { win: "X11; Linux x86_64",                 platform: "Linux x86_64", os: "Linux" },
    windows:{ win: "Windows NT 10.0; Win64; x64",       platform: "Win32", os: "Windows" },
  }[os] || { win: "Windows NT 10.0; Win64; x64", platform: "Win32", os: "Windows" };

  switch (br) {
    case "firefox": {
      const fv = v.includes(".") ? v.split(".")[0] : v;
      return { ua: `Mozilla/5.0 (${osStr.win}; rv:${fv}.0) Gecko/20100101 Firefox/${fv}.0`, platform: osStr.platform, os: osStr.os, version: fv };
    }
    case "safari": {
      const mac = "Macintosh; Intel Mac OS X 10_15_7";
      return { ua: `Mozilla/5.0 (${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${full} Safari/605.1.15`, platform: "MacIntel", os: "macOS", version: major };
    }
    case "edge":
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 Edg/${full}`, platform: osStr.platform, os: osStr.os, version: major };
    case "brave":
      // Brave uses a standard Chrome UA — it's identified by brave.isBrave API, not the UA string
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`, platform: osStr.platform, os: osStr.os, version: major };
    case "privacy":
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 PrivacyShield/${full}`, platform: osStr.platform, os: osStr.os, version: major };
    default: // chrome
      return { ua: `Mozilla/5.0 (${osStr.win}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`, platform: osStr.platform, os: osStr.os, version: major };
  }
}

// Deterministic per-profile fingerprint derivation. Without these, every
// profile reports the same hardwareConcurrency=4, deviceMemory=8, en-US,
// America/New_York — which lets Fiverr/Instagram cluster all your profiles
// together as "same person". Seed each value from the profile's fingerprintSeed
// so it's stable across launches but unique per profile.
function profileSeededInt(seedStr, salt) {
  const s = String(seedStr || "default") + ":" + String(salt || "");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pickWeighted(seedInt, choices) {
  const total = choices.reduce((a, c) => a + c[1], 0);
  let r = seedInt % total;
  for (const [val, w] of choices) {
    if (r < w) return val;
    r -= w;
  }
  return choices[choices.length - 1][0];
}
function pickHardwareConcurrency(seed, isMobile) {
  return pickWeighted(profileSeededInt(seed, "cpu"),
    isMobile ? [[4, 20], [6, 25], [8, 55]]
             : [[4, 15], [6, 20], [8, 40], [12, 15], [16, 10]]);
}
function pickDeviceMemory(seed, isMobile) {
  // Chromium clamps the API to 0.25/0.5/1/2/4/8. Above-8GB devices report 8.
  return pickWeighted(profileSeededInt(seed, "ram"),
    isMobile ? [[2, 25], [4, 45], [8, 30]]
             : [[4, 30], [8, 70]]);
}
// navigator.deviceMemory / Sec-CH-Device-Memory only ever expose 0.25/0.5/1/2/4/8
// in real Chrome (rounded down to a power of two, capped at 8) to limit
// fingerprinting. A physical-RAM figure like 16 or 32 is impossible and is an
// instant bot tell, so the runtime config value must be clamped even though the
// stored profile keeps the real RAM for display.
function clampDeviceMemory(gb) {
  const n = Number(gb);
  if (!isFinite(n) || n <= 0) return 8;
  if (n >= 8) return 8;
  let best = 0.25;
  for (const b of [0.25, 0.5, 1, 2, 4, 8]) if (n >= b) best = b;
  return best;
}
const TZ_BY_COUNTRY = {
  us: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix"],
  gb: ["Europe/London"],
  ca: ["America/Toronto", "America/Vancouver", "America/Edmonton"],
  au: ["Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Australia/Brisbane"],
  de: ["Europe/Berlin"], nl: ["Europe/Amsterdam"], fr: ["Europe/Paris"],
  ch: ["Europe/Zurich"], se: ["Europe/Stockholm"], jp: ["Asia/Tokyo"],
  sg: ["Asia/Singapore"], br: ["America/Sao_Paulo"], in: ["Asia/Kolkata"],
  ae: ["Asia/Dubai"], ru: ["Europe/Moscow"], tr: ["Europe/Istanbul"],
  ng: ["Africa/Lagos"], it: ["Europe/Rome"], es: ["Europe/Madrid"],
  pt: ["Europe/Lisbon"], kr: ["Asia/Seoul"], cn: ["Asia/Shanghai"]
};
const LANG_BY_COUNTRY = {
  us: ["en-US"], gb: ["en-GB"], ca: ["en-CA", "fr-CA"], au: ["en-AU"],
  de: ["de-DE"], nl: ["nl-NL"], fr: ["fr-FR"], ch: ["de-CH", "fr-CH", "it-CH"],
  se: ["sv-SE"], jp: ["ja-JP"], sg: ["en-SG"], br: ["pt-BR"],
  in: ["en-IN", "hi-IN"], ae: ["ar-AE", "en-AE"], ru: ["ru-RU"], tr: ["tr-TR"],
  ng: ["en-US"], it: ["it-IT"], es: ["es-ES"], pt: ["pt-PT"], kr: ["ko-KR"], cn: ["zh-CN"]
};
// Country-centre coordinates so the default geolocation stays coherent with the
// resolved timezone/language when a profile has no manual or proxy-detected geo.
const GEO_BY_COUNTRY = {
  us: [40.7128, -74.006], gb: [51.5074, -0.1278], ca: [43.6532, -79.3832],
  au: [-33.8688, 151.2093], de: [52.52, 13.405], nl: [52.3676, 4.9041],
  fr: [48.8566, 2.3522], ch: [47.3769, 8.5417], se: [59.3293, 18.0686],
  jp: [35.6762, 139.6503], sg: [1.3521, 103.8198], br: [-23.5505, -46.6333],
  in: [19.076, 72.8777], ae: [25.2048, 55.2708], ru: [55.7558, 37.6173],
  tr: [41.0082, 28.9784], ng: [6.5244, 3.3792], it: [41.9028, 12.4964],
  es: [40.4168, -3.7038], pt: [38.7223, -9.1393], kr: [37.5665, 126.978],
  cn: [39.9042, 116.4074]
};
function geoForCountry(seed, countryCode) {
  const c = GEO_BY_COUNTRY[String(countryCode || "").toLowerCase()] || GEO_BY_COUNTRY.us;
  // small deterministic jitter so co-country profiles aren't pixel-identical
  const j = (salt) => ((profileSeededInt(seed, salt) % 1000) / 1000 - 0.5) * 0.18;
  return { latitude: +(c[0] + j("lat")).toFixed(4), longitude: +(c[1] + j("lng")).toFixed(4) };
}
function pickTimezoneForCountry(seed, countryCode) {
  const list = TZ_BY_COUNTRY[String(countryCode || "").toLowerCase()] || TZ_BY_COUNTRY.us;
  return list[profileSeededInt(seed, "tz") % list.length];
}
function pickLanguageForCountry(seed, countryCode) {
  const list = LANG_BY_COUNTRY[String(countryCode || "").toLowerCase()] || LANG_BY_COUNTRY.us;
  return list[profileSeededInt(seed, "lang") % list.length];
}

function buildConfigFromProfile(profile) {
  if (!profile) return null;
  const fp = profile.fingerprint || {};
  // Safari/Firefox identities were retired — coerce legacy profiles to Chrome so
  // the UA and engine (Blink) always agree (a WebKit/Gecko UA on Chromium is a tell).
  const _browserDef = (() => { const b = fp.browser || profile.browserApp || "chrome"; return (b === "safari" || b === "firefox") ? "chrome" : b; })();
  const _seedDef = fp.fingerprintSeed || profile.id || "default";
  const _isMobileDef = (profile.os === "android" || profile.os === "ios") || fp.deviceClass === "mobile";
  const _ccDef = String((profile.proxy && profile.proxy.detectedCountryCode) || fp.countryCode || "us").toLowerCase();
  const _defLang = pickLanguageForCountry(_seedDef, _ccDef);
  const _defTz = pickTimezoneForCountry(_seedDef, _ccDef);
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
    // Media devices: an explicit "manual" pick keeps the user's counts. Otherwise
    // ("real"/"auto"/unset) derive a realistic per-profile device topology from the
    // seed and spoof it — leaving it "real" leaks the machine's actual device
    // layout identically across every profile (a same-machine linkage signal).
    ...(function () {
      if (fp.mediaDevices === "manual") {
        return {
          _mediaDevices: "manual",
          _cameras: typeof fp.cameras === "number" ? fp.cameras : 1,
          _microphones: typeof fp.microphones === "number" ? fp.microphones : 1,
          _speakers: typeof fp.speakers === "number" ? fp.speakers : 1,
        };
      }
      return {
        _mediaDevices: "manual",
        _microphones: pickWeighted(profileSeededInt(_seedDef, "mics"), [[1, 40], [2, 60]]),
        _speakers: pickWeighted(profileSeededInt(_seedDef, "spk"), [[1, 35], [2, 65]]),
        _cameras: pickWeighted(profileSeededInt(_seedDef, "cam"), [[0, 45], [1, 55]]),
      };
    })(),
    _deviceName: fp.deviceName || "off",
    _deviceNameValue: fp.deviceNameValue || "",
    _hardwareId: fp.hardwareId || "",
    _fontProfile: fp.fontProfile || profile.os || "windows",
    _fontList: resolvedFontListForProfile(fp, profile.os || "windows"),
    _devicePixelRatio: Number(fp.devicePixelRatio) || 1,
    _colorDepth: Number(fp.colorDepth) || 24,
    _pixelDepth: Number(fp.pixelDepth) || 24,
    _deviceClass: (profile.os === "android" || profile.os === "ios") ? "mobile" : (fp.deviceClass || "desktop"),
    _mobile: fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios",
    _mobileModel: fp.mobileModel || "",
    _mobileManufacturer: fp.mobileManufacturer || "",
    _platformVersion: fp.platformVersion || "",
    _androidBuild: fp.androidBuild || "",
    _architecture: (profile.os === "android" || profile.os === "ios") ? "arm" : (fp.architecture || "x86"),
    _bitness: fp.bitness || "64",
    _maxTouchPoints: Number(fp.maxTouchPoints) || ((profile.os === "android" || profile.os === "ios") ? 5 : 0),
    _screenOrientation: (profile.os === "android" || profile.os === "ios") ? "portrait-primary" : (fp.screenOrientation || "landscape-primary"),
    _touchEmulation: Boolean(fp.touchEmulation || fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios"),
    _sensorEmulation: Boolean(fp.sensorEmulation || fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios"),
    _viewportMobile: Boolean(fp.viewportMobile || fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios"),
    _pointerType: (fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios") ? "coarse" : (fp.pointerType || "fine"),
    _hoverType: (fp.deviceClass === "mobile" || profile.os === "android" || profile.os === "ios") ? "none" : (fp.hoverType || "hover"),
    _deviceMotion: fp.deviceMotion || null,
    _deviceOrientation: fp.deviceOrientation || null,
    _connectionType: fp.connectionType || ((profile.os === "android" || profile.os === "ios") ? "cellular" : "wifi"),
    _downlink: Number(fp.downlink) || 10,
    _rtt: Number(fp.rtt) || 50,
    _ports: fp.ports || "real",
    _blockedPorts: Array.isArray(fp.blockedPorts) ? fp.blockedPorts : [3389, 5938],
    _webrtcMode: fp.webrtc || "altered",
    // Manual IP wins; otherwise auto-fill from the detected VPN/proxy exit IP so
    // "Altered (show proxy IP)" reports the SAME public IP as the visible
    // connection (the VPN/proxy) instead of the real one. Never the real IP.
    _webrtcIP: fp.webrtcIP || (profile.proxy && profile.proxy.detectedIp) || "",
    _fingerprintSeed: fp.fingerprintSeed || profile.id || "",
    _stealth: fp.spoofingLevel === "stealth",
    _spoofSkipHosts: [
      ...new Set([
        ...BUILTIN_SPOOF_SKIP_HOSTS,
        ...(Array.isArray(fp.spoofSkipHosts) ? fp.spoofSkipHosts : [])
      ].map((host) => String(host || "").trim()).filter(Boolean))
    ],
    _browserApp: _browserDef,
    _countryCode: fp.countryCode || "",
    _country: fp.country || "",
    _continent: fp.continent || "",
    _city: fp.city || "",
    _state: fp.state || "",
    _organization: fp.organization || fp.ispOrg || "",
    _asn: fp.ispAsn || "",
    _ip: fp.ip || "",
    _profileId: profile.id,
    _profileName: profile.name,
    hardwareConcurrency: pickHardwareConcurrency(_seedDef, _isMobileDef),
    deviceMemory: pickDeviceMemory(_seedDef, _isMobileDef),
    language: _defLang,
    languages: [_defLang, _defLang.split("-")[0]].filter(Boolean),
    timezone: _defTz,
    localeOffsetMinutes: 300,
    geo: (() => { const g = geoForCountry(_seedDef, _ccDef); return { latitude: g.latitude, longitude: g.longitude, accuracy: 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null }; })(),
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 }
  };

  const platformMap = { windows: "Win32", macos: "MacIntel", linux: "Linux x86_64", android: "Linux armv8l", ios: "iPhone" };
  const osMap = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iOS" };
  cfg.platform = platformMap[profile.os || "windows"] || "Win32";
  cfg._uaOS = osMap[profile.os || "windows"] || "Windows";

  if (fp.userAgent === "manual" && fp.userAgentValue) {
    cfg.userAgent = fp.userAgentValue;
    cfg._uaVersion = (fp.userAgentValue.match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || String(fp.browserVersion || "150").split(".")[0];
  } else {
    // "auto" (or empty) → the current real-world Chrome for this OS, so the UA
    // matches what real users run (being a year behind is itself a bot tell).
    // A stored numeric/custom version is honored as-is.
    // Unset, "auto", or a bare major (e.g. "142" — always an auto-generated,
    // now-stale value from an older build) → resolve to the CURRENT real-world
    // version so no profile advertises a Chrome/Brave that's months behind.
    // Only an explicit full-version "custom" string (contains a dot, e.g.
    // "150.0.7871.46") is treated as a deliberate pin and kept as-is.
    let bv = fp.browserVersion;
    if (!bv || bv === "auto" || !String(bv).includes(".")) {
      bv = latestVersionFor(_browserDef, profile.os || "windows");
    }
    const built = buildProfileUA(profile.os || "windows", bv, _browserDef, fp);
    cfg.userAgent = built.ua;
    cfg.platform = built.platform;
    cfg._uaOS = built.os;
    cfg._uaVersion = built.version;
    cfg._platformVersion = built.platformVersion || cfg._platformVersion;
    cfg._mobile = Boolean(built.mobile);
    cfg._mobileModel = built.model || cfg._mobileModel;
  }

  if (fp.webglInfo === "manual" && fp.webglVendor) {
    cfg._gpuVendor = fp.webglVendor;
    cfg._gpuRenderer = fp.webglRenderer || "";
  } else {
    // Pick a GPU coherent with the profile OS. A macOS/Linux profile must never
    // report a Windows "Direct3D11" renderer (or vice-versa) — an instant tell.
    const osKey = profile.os === "macos" ? "macos" : profile.os === "linux" ? "linux" : "windows";
    const osPresets = PROFILE_WEBGL_PRESETS.filter((p) => p.platform === osKey);
    const pool = osPresets.length ? osPresets : PROFILE_WEBGL_PRESETS;
    const rawIndex = parseInt(String(profile.id || "").slice(-4), 36);
    const gi = (Number.isFinite(rawIndex) ? rawIndex : 0) % pool.length;
    const preset = pool[gi] || pool[0];
    cfg._gpuVendor = preset.vendor;
    cfg._gpuRenderer = preset.renderer;
  }

  // Auto mode: pull from the VPN/proxy detection saved on the profile.
  // This makes "Auto (from VPN / proxy IP)" actually do something rather than
  // leaving the field default. Manual overrides anything that's set.
  const px = profile.proxy || {};
  if (fp.timezone === "manual") {
    cfg.timezone = fp.timezoneValue || "UTC";
    cfg.localeOffsetMinutes = typeof fp.timezoneOffset === "number" ? fp.timezoneOffset : 0;
  } else if (fp.timezone === "auto" && px.detectedTimezone) {
    cfg.timezone = px.detectedTimezone;
  }

  if (fp.language === "manual" && fp.languageValue) {
    cfg.language = fp.languageValue;
    cfg.languages = [fp.languageValue, fp.languageValue.split("-")[0]].filter(Boolean);
  } else if (fp.language === "auto" && px.detectedCountryCode) {
    const langMap = { us:"en-US", gb:"en-GB", ca:"en-CA", au:"en-AU", de:"de-DE", nl:"nl-NL", fr:"fr-FR", ch:"de-DE", se:"sv-SE", jp:"ja-JP", sg:"en-SG", br:"pt-BR", in:"hi-IN", ae:"ar-AE", ru:"ru-RU", tr:"tr-TR", ng:"en-US", it:"it-IT", es:"es-ES", pt:"pt-PT", kr:"ko-KR", cn:"zh-CN" };
    const auto = langMap[String(px.detectedCountryCode).toLowerCase()];
    if (auto) {
      cfg.language = auto;
      cfg.languages = [auto, auto.split("-")[0]].filter(Boolean);
    }
  }

  if (fp.geolocation === "manual") {
    cfg.geo = {
      latitude: Number(fp.geoLat) || 0,
      longitude: Number(fp.geoLng) || 0,
      accuracy: Number(fp.geoAccuracy) || 50,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null
    };
  } else if (fp.geolocation === "auto" && (px.detectedLatitude || px.detectedLat)) {
    cfg.geo = {
      latitude: Number(px.detectedLatitude || px.detectedLat) || 0,
      longitude: Number(px.detectedLongitude || px.detectedLng) || 0,
      accuracy: 50,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null
    };
  }

  if (fp.cpuCores === "manual") cfg.hardwareConcurrency = Number(fp.cpuCoresValue) || 4;
  if (fp.ram === "manual") cfg.deviceMemory = clampDeviceMemory(fp.ramValue);
  cfg.deviceMemory = clampDeviceMemory(cfg.deviceMemory);

  if (fp.screen === "manual") {
    cfg.screen = {
      width: Number(fp.screenWidth) || 1920,
      height: Number(fp.screenHeight) || 1080,
      availWidth: Number(fp.screenWidth) || 1920,
      availHeight: cfg._mobile ? (Number(fp.screenHeight) || 1080) : (Number(fp.screenHeight) || 1080) - 40,
      colorDepth: Number(fp.colorDepth) || 24,
      pixelDepth: Number(fp.pixelDepth) || 24
    };
  }

  return cfg;
}

function getEngineCapabilities() {
  return {
    actualEngine: "Electron Chromium",
    actualEngineId: "electron-chromium",
    profileIsolation: true,
    perProfileSessionPartition: true,
    bundledBrowserRuntime: true,
    storageIsolation: ["cookies", "cache", "localStorage", "IndexedDB", "serviceWorkers", "authCache"],
    nativeEngines: ["chromium", "real-chrome", "real-brave", "patched-chromium"],
    identityTemplates: ["privacy", "chrome", "brave", "edge", "firefox", "safari"],
    chromiumCppPatches: false,
    aiDailyFingerprints: false,
    firefoxGeckoRuntime: false,
    notes: [
      "Profile windows can run on Privacy Shield's bundled Electron Chromium runtime or launch installed Chrome/Brave with isolated user-data directories.",
      "Firefox and Safari selections are identity templates, not separate Gecko/WebKit runtimes.",
      "Real Chrome/Brave mode uses the installed browser network stack but does not run the Electron preload fingerprint layer.",
      "Fingerprint data is generated locally from coherent templates, not from a daily AI-tested real-device service.",
      "No Chromium/Blink C++ patches are included in this Electron build."
    ]
  };
}

function getProfileSessionPartition(profileId) {
  const safeId = String(profileId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `persist:privacy-shield-profile-${safeId}`;
}

function getTransportFingerprintAudit(profile = {}) {
  const fp = profile.fingerprint || {};
  const px = profile.proxy || {};
  const engine = normalizeEngine(profile.engine);
  if (isRealBrowserEngine(engine)) {
    if (isPatchedChromiumEngine(engine)) {
      return {
        state: "patched-chromium",
        supported: true,
        label: "Patched Chromium (per-seed device)",
        message: "Bundled patched Chromium: canvas/audio/font/timezone/CPU/RAM are randomized per profile at the C++ level (stable per profile, different across profiles), with the WebGL GPU string + geolocation layered on. This is the strongest per-profile hardware identity."
      };
    }
    const isBrave = String(engine || "").toLowerCase() === "real-brave";
    if (isBrave) {
      return {
        state: "real-browser-spoofed",
        supported: true,
        label: "Real Brave transport + extension spoof",
        message: "Transport comes from installed Brave with a separate data directory (no CDP attach). A per-profile extension applies canvas/WebGL/audio/screen/timezone/geolocation spoofing inside the real browser."
      };
    }
    return {
      state: "real-browser",
      supported: true,
      label: "Real Chrome transport (no JS spoof)",
      message: "Transport comes from installed Chrome with a separate data directory. Current Chrome blocks command-line extensions, so the canvas/WebGL/audio JS spoof does not run; use Real Brave for full fingerprint spoofing."
    };
  }
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  const scheme = String(px.scheme || "").toLowerCase();
  const hasProxy = mode === "proxy" && Boolean(px.enabled && px.host && px.port);
  const isHttpProxy = hasProxy && (scheme === "http" || scheme === "https");

  if (!fp.tlsSpoof) {
    return {
      state: "native",
      supported: false,
      label: "Native Chromium TLS/HTTP2",
      message: "TLS/HTTP2 transport uses native Electron Chromium before page JavaScript runs; it can remain linkable across profiles."
    };
  }

  if (!isHttpProxy) {
    return {
      state: "unsupported",
      supported: false,
      label: "TLS spoof requested but unsupported",
      message: "TLS spoof is enabled, but this network mode cannot use the JA3 bridge. Use an enabled HTTP/HTTPS proxy, or it falls back to native Chromium transport."
    };
  }

  return {
    state: "mitm",
    supported: true,
    label: "JA3 bridge for normal HTTPS",
    message: "TLS JA3 bridge is enabled for normal HTTPS through this HTTP/HTTPS proxy. HTTP/2 framing and WebSocket upgrades are still limited coverage."
  };
}

function validateProfileConsistency(profile = {}) {
  const fp = profile.fingerprint || {};
  const px = profile.proxy || {};
  const selectedEngine = normalizeEngine(profile.engine);
  const osName = profile.os || "windows";
  const browser = fp.browser || profile.browserApp || "chrome";
  const deviceClass = fp.deviceClass || (osName === "android" ? "mobile" : "desktop");
  const sessionPartition = getProfileSessionPartition(profile.id || "__new__");
  const issues = [];
  const warnings = [];
  const passes = [];
  const addPass = (msg) => passes.push({ level: "pass", message: msg });
  const addWarn = (msg) => warnings.push({ level: "warn", message: msg });
  const addIssue = (msg) => issues.push({ level: "issue", message: msg });

  if (osName === "android") {
    if (deviceClass !== "mobile") addIssue("Android profiles should use mobile device class.");
    else addPass("Android profile uses mobile device class.");
    if (!fp.mobileModel) addWarn("Android mobile model is empty.");
    else addPass(`Android model is set to ${fp.mobileModel}.`);
    if (!fp.platformVersion) addWarn("Android platform version is empty.");
    if (!fp.androidBuild) addWarn("Android build string is empty.");
    if ((Number(fp.maxTouchPoints) || 0) < 1) addIssue("Android profiles should expose touch points.");
    else addPass(`Touch points are set to ${Number(fp.maxTouchPoints) || 0}.`);
    if (!fp.touchEmulation) addWarn("Touch emulation metadata is off.");
    if (!fp.sensorEmulation) addWarn("Sensor emulation metadata is off.");
    if (!String(fp.screenOrientation || "").startsWith("portrait")) addWarn("Android profiles usually use portrait-primary orientation.");
    if (!["chrome", "privacy", "brave", "edge"].includes(browser)) addWarn(`${browserLabelForAudit(browser)} is not a native Android runtime in this app; Chromium will be used with a compatible identity template.`);
  } else {
    if (deviceClass === "mobile") addWarn("Non-Android profile is marked mobile.");
    else addPass("Desktop OS uses desktop device class.");
    if ((Number(fp.maxTouchPoints) || 0) > 0) addWarn("Desktop profile has touch points enabled.");
  }
  if (isRealBrowserEngine(selectedEngine) && (osName === "android" || osName === "ios")) {
    addIssue("Real Chrome/Brave mode launches a desktop browser; use Windows, macOS, or Linux for this engine.");
  }

  if (browser === "safari" && osName !== "macos") {
    addIssue("Safari identity should only be used with macOS.");
  }
  if (browser === "firefox") {
    addWarn("Firefox is currently an identity template only; the launched runtime is still Electron Chromium.");
  }
  if (browser === "safari") {
    addWarn("Safari is currently an identity template only; the launched runtime is still Electron Chromium.");
  }

  if (profile.id) {
    addPass(`Storage partition is ${sessionPartition}.`);
  } else {
    addWarn("Unsaved profiles receive their isolated storage partition after creation.");
  }
  if (fp.fingerprintSeed) addPass("Per-profile fingerprint seed is set.");
  else addWarn("Per-profile fingerprint seed will be generated when the profile is saved.");
  if (fp.hardwareId) addPass("Profile hardware id metadata is set.");
  else addWarn("Profile hardware id metadata will be generated when the profile is saved.");

  const transport = getTransportFingerprintAudit({ ...profile, fingerprint: fp, proxy: px });
  if (transport.state === "unsupported") addIssue(transport.message);
  else if (transport.state === "patched-chromium") {
    addPass(transport.message);
    addPass("Per-profile fingerprint is engine-level (covers Web Workers and fonts), so profiles on one PC are not linkable by device signature.");
  }
  else if (transport.state === "real-browser-spoofed") {
    addPass(transport.message);
    addWarn("Extension spoofing does not run inside Web Workers, and Brave's own farbling may add extra canvas/audio noise on top of the profile's.");
  }
  else if (transport.state === "real-browser") {
    addPass(transport.message);
    addWarn("Real Chrome mode has no in-page fingerprint spoof (Chrome blocks command-line extensions). Switch this profile's engine to Real Brave for canvas/WebGL/audio/timezone spoofing.");
  }
  else if (transport.supported) {
    addPass(transport.message);
    addWarn("Transport spoofing is partial: full HTTP/2 fingerprint control requires a browser/network stack that supports it natively.");
  } else {
    addWarn(transport.message);
  }

  const screenWidth = Number(fp.screenWidth) || 0;
  const screenHeight = Number(fp.screenHeight) || 0;
  const dpr = Number(fp.devicePixelRatio) || 1;
  if (screenWidth <= 0 || screenHeight <= 0) addIssue("Screen width and height must be set.");
  else addPass(`Screen is ${screenWidth}x${screenHeight} at DPR ${dpr}.`);
  if (osName === "android" && screenWidth > screenHeight) addWarn("Android mobile screen is landscape-sized; portrait screens are more typical.");
  if (osName === "android" && (screenWidth < 320 || screenWidth > 480 || screenHeight < 640 || screenHeight > 1000)) {
    addWarn("Android mobile screen is outside the app's known phone profile range.");
  }
  if (osName !== "android" && screenWidth < 1024) addWarn("Desktop screen width is unusually small.");
  if (dpr < 1 || dpr > 4) addWarn("Device pixel ratio is outside the usual 1-4 range.");
  if (osName === "android" && dpr < 2) addWarn("Android DPR is lower than the app's known phone profiles.");

  const knownAndroid = findAndroidDeviceByModel(fp.mobileModel);
  if (osName === "android" && knownAndroid) {
    const [knownWidth, knownHeight] = knownAndroid.screen;
    if (screenWidth === knownWidth && screenHeight === knownHeight) {
      addPass(`Screen matches ${knownAndroid.model} profile dimensions.`);
    } else {
      addWarn(`Screen does not match ${knownAndroid.model} profile dimensions (${knownWidth}x${knownHeight}).`);
    }
    if (Math.abs(dpr - knownAndroid.dpr) <= 0.15) {
      addPass(`DPR matches ${knownAndroid.model} profile.`);
    } else {
      addWarn(`DPR does not match ${knownAndroid.model} profile (${knownAndroid.dpr}).`);
    }
  }

  if (fp.timezone === "manual" && fp.timezoneValue) addPass(`Timezone is set to ${fp.timezoneValue}.`);
  else addWarn("Timezone is not manually pinned for this profile.");
  if (fp.language === "manual" && fp.languageValue) addPass(`Language is set to ${fp.languageValue}.`);
  else addWarn("Language is not manually pinned for this profile.");
  if (fp.geolocation === "manual") addPass("Geolocation is manually pinned.");
  else addWarn("Geolocation is not manually pinned for this profile.");

  const fontProfile = fp.fontProfile || osName;
  const effectiveFonts = resolvedFontListForProfile(fp, osName);
  if (fp.fonts === "blocked") {
    addPass("Font checks are configured to return an empty profile font set.");
  } else if (effectiveFonts.length < 5) {
    addWarn("Profile font list is sparse; generated profiles should keep an OS-specific font baseline.");
  } else {
    addPass(`Font profile ${fontProfile} exposes ${effectiveFonts.length} OS/language fonts.`);
  }
  if (osName === "android" && fontProfile !== "android") addIssue("Android profiles should use the Android font profile.");
  if (osName !== "android" && fontProfile === "android") addWarn("Desktop profile is using Android fonts.");
  const fontText = effectiveFonts.map((font) => String(font).toLowerCase()).join("|");
  const fontAnchors = {
    android: ["roboto", "noto sans"],
    windows: ["segoe ui", "calibri"],
    macos: ["helvetica neue", "san francisco"],
    linux: ["dejavu sans", "liberation sans", "noto sans"]
  }[osName] || ["arial"];
  if (fp.fonts !== "blocked" && !fontAnchors.some((font) => fontText.includes(font))) {
    addWarn(`Font list is missing common ${osName} anchor fonts.`);
  }

  const gpuVendor = fp.webglVendor || "";
  const gpuRenderer = fp.webglRenderer || "";
  if (gpuVendor && gpuRenderer) {
    addPass("WebGL vendor and renderer are set.");
    if (gpuLooksCompatibleWithOs(osName, gpuVendor, gpuRenderer)) {
      addPass(`GPU renderer is compatible with ${osName}.`);
    } else {
      addWarn(`GPU renderer does not look typical for ${osName}.`);
    }
    if (knownAndroid) {
      const actualGpu = `${gpuVendor} ${gpuRenderer}`.toLowerCase();
      if (actualGpu.includes(knownAndroid.gpuVendor.toLowerCase()) || actualGpu.includes(knownAndroid.gpuRenderer.toLowerCase())) {
        addPass(`GPU matches ${knownAndroid.model} profile family.`);
      } else {
        addWarn(`GPU does not match ${knownAndroid.model} profile family (${knownAndroid.gpuRenderer}).`);
      }
    }
  } else {
    addWarn("WebGL vendor or renderer is missing.");
  }

  const summary = {
    storage: sessionPartition,
    screen: screenWidth > 0 && screenHeight > 0 ? `${screenWidth}x${screenHeight} @ ${dpr} DPR` : "missing",
    fonts: fp.fonts === "blocked" ? "blocked" : `${fontProfile}, ${effectiveFonts.length} fonts`,
    gpu: gpuVendor && gpuRenderer ? `${gpuVendor} / ${gpuRenderer}` : "missing",
    transport: transport.label
  };

  return {
    ok: issues.length === 0,
    score: Math.max(0, Math.min(100, 100 - issues.length * 25 - warnings.length * 8)),
    engine: getEngineCapabilities(),
    profile: {
      id: profile.id || "",
      name: profile.name || "",
      os: osName,
      browser,
      deviceClass,
      actualRuntime: selectedEngine === "stealthfox" ? "Stealthfox Firefox" : isRealBrowserEngine(selectedEngine) ? realBrowserRuntimeLabel(selectedEngine) : "Electron Chromium",
      sessionPartition
    },
    summary,
    issues,
    warnings,
    passes
  };
}

function browserLabelForAudit(browser) {
  return {
    privacy: "Privacy Shield",
    chrome: "Chrome",
    brave: "Brave",
    edge: "Edge",
    firefox: "Firefox",
    safari: "Safari"
  }[browser] || browser || "Browser";
}

module.exports = {
  getProfiles,
  saveProfiles,
  saveSyncedProfiles,
  getProxyLibrary,
  saveProxyLibrary,
  saveSyncedProxyLibrary,
  sanitizeProfileForSync,
  sanitizeProxyForSync,
  getProxyProviderConfig,
  saveProxyProviderConfig,
  getVpsProxies,
  upsertVpsProxy,
  deleteVpsProxy,
  getCloudPhoneProviderConfig,
  saveCloudPhoneProviderConfig,
  getCloudPhones,
  upsertCloudPhone,
  deleteCloudPhone,
  generateId,
  getDefaultFingerprint,
  getDefaultProxy,
  createProfile,
  createProfilesBatch,
  updateProfile,
  deleteProfile,
  purgeDeletedProfiles,
  duplicateProfile,
  restoreProfile,
  addProxyEntry,
  updateProxyEntry,
  deleteProxyEntry,
  markProxyUsed,
  pickPrivateProxy,
  buildConfigFromProfile,
  buildCountryIdentity,
  buildCountryProfileData,
  getEngineCapabilities,
  validateProfileConsistency,
  getOpenProfiles,
  saveOpenProfiles,
  PROFILE_WEBGL_PRESETS
};
