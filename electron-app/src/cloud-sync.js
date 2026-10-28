"use strict";

// Cloud sync via Supabase.
// All user data (profiles, proxies, open-profiles state) syncs to Supabase
// so the same account works on any PC. Auth is also done via Supabase.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { app, safeStorage } = require("electron");

const SUPABASE_URL = "https://pnhzsteoouhngjdgsfeh.supabase.co";
const SUPABASE_KEY = "sb_publishable_8xJbMF4kr6yTALY-XJua-Q_XFT0iKe2";

const BASE_DIR     = path.join(app.getPath("userData"), "privacy-shield");
const SESSION_FILE = path.join(BASE_DIR, "supabase-session.json");
const PROXY_KEY_FILE = path.join(BASE_DIR, "proxy-sync-key.bin");

// Write to BOTH OneDrive Desktop AND userData. OneDrive Files-On-Demand
// can silently swallow appendFileSync writes; userData is the reliable copy.
const LOG_TARGETS = (() => {
  const targets = [];
  for (const dir of [path.join(os.homedir(), "OneDrive", "Desktop"), path.join(os.homedir(), "Desktop")]) {
    try { if (fs.existsSync(dir)) { targets.push(path.join(dir, "privacy-shield-error.txt")); break; } } catch (_) {}
  }
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    targets.push(path.join(BASE_DIR, "privacy-shield-error.txt"));
  } catch (_) {}
  if (!targets.length) targets.push(path.join(os.tmpdir(), "privacy-shield-error.txt"));
  return targets;
})();
function logLine(msg) {
  const line = new Date().toISOString() + " [cloud] " + msg + "\n";
  for (const t of LOG_TARGETS) {
    try { fs.appendFileSync(t, line, "utf8"); } catch (_) {}
  }
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch (_) { return fallback; }
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value || fallback));
  } catch (_) {
    return fallback;
  }
}

function sanitizeProxyForCloud(proxy) {
  const clone = sealProxySecrets(cloneJson(proxy, {}));
  delete clone.username;
  delete clone.password;
  delete clone.passwordEnc;
  delete clone.rotationUrl;
  return clone;
}

// Proxy credentials sync end-to-end encrypted: the key comes from the account
// password (scrypt, salted by user id), so only someone who knows the password
// can read them. Supabase only ever sees the ciphertext in `secretsEnc`.
const PROXY_SECRET_FIELDS = ["username", "password", "rotationUrl"];

function saveProxyKey(password, userId) {
  try {
    const key = crypto.scryptSync(String(password), "ps-proxy-sync:" + userId, 32);
    ensureDir(BASE_DIR);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key.toString("base64")) : key;
    fs.writeFileSync(PROXY_KEY_FILE, data);
  } catch (err) { logLine("proxy key save failed: " + err.message); }
}

function loadProxyKey() {
  try {
    const raw = fs.readFileSync(PROXY_KEY_FILE);
    return raw.length === 32 ? raw : Buffer.from(safeStorage.decryptString(raw), "base64");
  } catch (_) { return null; }
}

// AES-256-GCM with the account key: iv(12) | tag(16) | ciphertext. null = no key.
function sealBuffer(buf) {
  const key = loadProxyKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// Throws on wrong account password or tampering.
function openBuffer(buf) {
  const key = loadProxyKey();
  if (!key) throw new Error("no sync key — log in again");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

function sealProxySecrets(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;
  const secrets = {};
  for (const f of PROXY_SECRET_FIELDS) if (proxy[f]) secrets[f] = String(proxy[f]);
  const sealed = Object.keys(secrets).length && sealBuffer(Buffer.from(JSON.stringify(secrets), "utf8"));
  return sealed ? { ...proxy, secretsEnc: sealed.toString("base64") } : proxy;
}

// Returns {username,password,rotationUrl} or {} (no blob / wrong password / tampered).
function openProxySecrets(proxy) {
  const blob = proxy && proxy.secretsEnc;
  if (!blob) return {};
  try { return JSON.parse(openBuffer(Buffer.from(String(blob), "base64")).toString("utf8")); }
  catch (_) { return {}; }
}

// ── Browser-data backups (Supabase Storage, bucket profile-backups/<uid>/) ──

const BACKUP_BUCKET = "profile-backups";

async function backupInfo(profileId) {
  const userId = getCurrentUserId();
  if (!cloudReady() || !userId) return null;
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).list(userId, { search: profileId + ".bin" });
  if (error) throw new Error(error.message);
  const hit = (data || []).find((o) => o.name === profileId + ".bin");
  return hit ? { updatedAt: hit.updated_at || hit.created_at || "" } : null;
}

async function uploadBackup(profileId, buf) {
  const userId = getCurrentUserId();
  if (!cloudReady() || !userId) throw new Error("not logged in");
  const { error } = await supabase.storage.from(BACKUP_BUCKET)
    .upload(`${userId}/${profileId}.bin`, buf, { upsert: true, contentType: "application/octet-stream" });
  if (error) throw new Error(error.message);
}

async function downloadBackup(profileId) {
  const userId = getCurrentUserId();
  if (!cloudReady() || !userId) throw new Error("not logged in");
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).download(`${userId}/${profileId}.bin`);
  if (error) throw new Error(error.message);
  return Buffer.from(await data.arrayBuffer());
}

function sanitizeProfileForCloud(profile) {
  const clone = cloneJson(profile, {});
  delete clone.cookies;
  delete clone.localStorageData;
  delete clone.session;
  if (clone.proxy) clone.proxy = sanitizeProxyForCloud(clone.proxy);
  return clone;
}

// Defensive Supabase load — if the package is missing or fails to init,
// the app should still work (without cloud sync). All sync functions
// short-circuit when `supabase` is null.
let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  const WS = require("ws");
  const { net } = require("electron");

  // Use Electron's net.fetch (Chromium network stack) instead of Node.js global fetch.
  // This respects system certificates including corporate TLS inspection (DPI),
  // avoiding "fetch failed" errors that the undici-based Node.js fetch produces.
  // Wrap with error logging so a failure surfaces the real cause (DNS, TLS, etc).
  const electronFetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    try {
      const res = await net.fetch(input, init);
      if (!res.ok) logLine(`fetch ${init?.method || "GET"} ${url} -> ${res.status}`);
      return res;
    } catch (err) {
      logLine(`fetch ${init?.method || "GET"} ${url} threw: ${err.code || ""} ${err.message || err}`);
      throw err;
    }
  };

  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: electronFetch },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => {
          const data = readJson(SESSION_FILE, {});
          return data[key] || null;
        },
        setItem: (key, value) => {
          const data = readJson(SESSION_FILE, {});
          data[key] = value;
          writeJson(SESSION_FILE, data);
        },
        removeItem: (key) => {
          const data = readJson(SESSION_FILE, {});
          delete data[key];
          writeJson(SESSION_FILE, data);
        }
      }
    },
    realtime: { transport: WS }
  });
} catch (err) {
  const msg = "Cloud sync disabled — Supabase failed to load: " + (err.message || err);
  console.error(msg);
  logLine(msg);
  supabase = null;
}

function cloudReady() { return supabase != null; }

// ── Auth ─────────────────────────────────────────────────────────────────────

async function register(email, password) {
  if (!cloudReady()) return { ok: false, error: "Cloud not available — check Desktop/privacy-shield-error.txt for details" };
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    if (!data.user) return { ok: false, error: "Could not create account" };
    // When email confirmation is enabled in Supabase, signUp returns no session.
    // Tell the caller so the UI can show "check your email" instead of trying to open the app.
    const needsConfirmation = !data.session;
    return { ok: true, needsConfirmation, user: { id: data.user.id, email: data.user.email } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function login(email, password) {
  if (!cloudReady()) return { ok: false, error: "Cloud not available" };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    saveProxyKey(password, data.user.id);
    return { ok: true, user: { id: data.user.id, email: data.user.email } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function logout() {
  if (cloudReady()) { try { await supabase.auth.signOut(); } catch (_) {} }
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  try { fs.unlinkSync(PROXY_KEY_FILE); } catch (_) {}
}

async function getSession() {
  if (!cloudReady()) return null;
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return null;
    return {
      userId: data.session.user.id,
      email: data.session.user.email,
      loginAt: Date.now()
    };
  } catch (_) { return null; }
}

// The signed-in user's current Supabase access token. The cloud runner verifies
// it to know whose profiles a request is for. Team members never type a token.
function readStoredAccessToken() {
  const sess = readJson(SESSION_FILE, {});
  for (const key of Object.keys(sess)) {
    try {
      const val = typeof sess[key] === "string" ? JSON.parse(sess[key]) : sess[key];
      const s = val && (val.currentSession || val);
      if (s && s.access_token && (!s.expires_at || s.expires_at * 1000 > Date.now() + 15000)) return s.access_token;
    } catch (_) {}
  }
  return "";
}

async function refreshAccessToken() {
  if (!cloudReady()) return readStoredAccessToken();
  try {
    const { data } = await supabase.auth.refreshSession();
    return (data && data.session && data.session.access_token) || readStoredAccessToken();
  } catch (_) { return readStoredAccessToken(); }
}

async function getAccessToken() {
  if (!cloudReady()) return readStoredAccessToken();
  try {
    const { data } = await supabase.auth.getSession();
    const session = data && data.session;
    const exp = session && session.expires_at ? session.expires_at * 1000 : 0;
    if (session && session.access_token && exp > Date.now() + 120000) return session.access_token;
    const fresh = await refreshAccessToken();
    return fresh || (session && session.access_token) || "";
  } catch (_) { return readStoredAccessToken(); }
}

function getCurrentUserId() {
  const sess = readJson(SESSION_FILE, {});
  // Find the session key — Supabase stores it under 'sb-<project>-auth-token'
  for (const key of Object.keys(sess)) {
    try {
      const val = typeof sess[key] === "string" ? JSON.parse(sess[key]) : sess[key];
      if (val && val.user && val.user.id) return val.user.id;
      if (val && val.currentSession && val.currentSession.user) return val.currentSession.user.id;
    } catch (_) {}
  }
  return null;
}

// ── Data sync — profiles ─────────────────────────────────────────────────────

async function pullProfiles() {
  if (!cloudReady()) return { ok: false, error: "cloud not available", profiles: [] };
  try {
    const userId = getCurrentUserId();
    if (!userId) return { ok: false, error: "not logged in", profiles: [] };
    const { data, error } = await supabase
      .from("profiles")
      .select("profile_id, data, updated_at, user_id")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    // Belt-and-suspenders: drop any row whose user_id doesn't match — guards
    // against an RLS misconfig on the server. Should be a no-op when RLS is on.
    const rows = (data || []).filter((r) => r.user_id === userId);
    return { ok: true, profiles: rows.map((r) => sanitizeProfileForCloud(r.data)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushProfile(profile) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId || !profile || !profile.id) return { ok: false, error: "not logged in" };
    const cloudProfile = sanitizeProfileForCloud(profile);
    const { error } = await supabase
      .from("profiles")
      .upsert(
        { user_id: userId, profile_id: profile.id, data: cloudProfile, updated_at: new Date().toISOString() },
        { onConflict: "user_id,profile_id" }
      );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushAllProfiles(profiles) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId || !profiles || !profiles.length) return { ok: true, count: 0 };
    const rows = profiles
      .map((p) => sanitizeProfileForCloud(p))
      .filter((p) => p && p.id)
      .map((p) => ({
        user_id: userId,
        profile_id: p.id,
        data: p,
        updated_at: new Date().toISOString()
      }));
    if (!rows.length) return { ok: true, count: 0 };
    const { error } = await supabase
      .from("profiles")
      .upsert(rows, { onConflict: "user_id,profile_id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: rows.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function deleteProfileRemote(profileId) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId) return { ok: false, error: "not logged in" };
    const { error } = await supabase
      .from("profiles")
      .delete()
      .eq("user_id", userId)
      .eq("profile_id", profileId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Data sync — proxies ──────────────────────────────────────────────────────

async function pullProxies() {
  if (!cloudReady()) return { ok: false, proxies: [] };
  try {
    const userId = getCurrentUserId();
    if (!userId) return { ok: false, error: "not logged in", proxies: [] };
    const { data, error } = await supabase
      .from("proxies")
      .select("proxy_id, data, updated_at, user_id")
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    const rows = (data || []).filter((r) => r.user_id === userId);
    return { ok: true, proxies: rows.map((r) => sanitizeProxyForCloud(r.data)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushAllProxies(proxies) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId || !proxies || !proxies.length) return { ok: true, count: 0 };
    const rows = proxies
      .map((p) => sanitizeProxyForCloud(p))
      .filter((p) => p && p.id)
      .map((p) => ({
        user_id: userId,
        proxy_id: p.id,
        data: p,
        updated_at: new Date().toISOString()
      }));
    if (!rows.length) return { ok: true, count: 0 };
    const { error } = await supabase
      .from("proxies")
      .upsert(rows, { onConflict: "user_id,proxy_id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: rows.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function deleteProxyRemote(proxyId) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId) return { ok: false, error: "not logged in" };
    const { error } = await supabase
      .from("proxies")
      .delete()
      .eq("user_id", userId)
      .eq("proxy_id", proxyId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Initial sync after login ─────────────────────────────────────────────────

async function fullSync(localProfiles, localProxies) {
  // 1. Push anything we have locally that's missing remotely (first-time login on this PC)
  if (localProfiles && localProfiles.length) await pushAllProfiles(localProfiles);
  if (localProxies && localProxies.length) await pushAllProxies(localProxies);

  // 2. Pull the merged set (server is now the source of truth)
  const profilesResult = await pullProfiles();
  const proxiesResult = await pullProxies();

  return {
    ok: true,
    profiles: profilesResult.ok ? profilesResult.profiles : [],
    proxies: proxiesResult.ok ? proxiesResult.proxies : []
  };
}

module.exports = {
  register, login, logout, getSession, getCurrentUserId, getAccessToken, refreshAccessToken,
  pullProfiles, pushProfile, pushAllProfiles, deleteProfileRemote,
  pullProxies, pushAllProxies, deleteProxyRemote,
  sealProxySecrets, openProxySecrets, sealBuffer, openBuffer,
  backupInfo, uploadBackup, downloadBackup, logLine, cloudReady,
  hasSyncKey: () => fs.existsSync(PROXY_KEY_FILE),
  fullSync
};
