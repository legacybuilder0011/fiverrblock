"use strict";

// Cloud sync via Supabase.
// All user data (profiles, proxies, open-profiles state) syncs to Supabase
// so the same account works on any PC. Auth is also done via Supabase.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SUPABASE_URL = "https://tlavlrntgzsqvgicyzzz.supabase.co";
const SUPABASE_KEY = "sb_publishable_tu-E950ukBD0lJ3z7OKfXg_DUSpzhdX";

const BASE_DIR     = path.join(app.getPath("userData"), "privacy-shield");
const SESSION_FILE = path.join(BASE_DIR, "supabase-session.json");

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch (_) { return fallback; }
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// Defensive Supabase load — if the package is missing or fails to init,
// the app should still work (without cloud sync). All sync functions
// short-circuit when `supabase` is null.
let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
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
  }
  });
} catch (err) {
  console.error("Cloud sync disabled — Supabase failed to load:", err.message || err);
  supabase = null;
}

function cloudReady() { return supabase != null; }

// ── Auth ─────────────────────────────────────────────────────────────────────

async function register(email, password) {
  if (!cloudReady()) return { ok: false, error: "Cloud not available — try again or update the app" };
  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { ok: false, error: error.message };
    if (!data.user) return { ok: false, error: "Could not create account" };
    return { ok: true, user: { id: data.user.id, email: data.user.email } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function login(email, password) {
  if (!cloudReady()) return { ok: false, error: "Cloud not available" };
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true, user: { id: data.user.id, email: data.user.email } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function logout() {
  if (cloudReady()) { try { await supabase.auth.signOut(); } catch (_) {} }
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
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
    const { data, error } = await supabase
      .from("profiles")
      .select("profile_id, data, updated_at")
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, profiles: (data || []).map((r) => r.data) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushProfile(profile) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId || !profile || !profile.id) return { ok: false, error: "not logged in" };
    const { error } = await supabase
      .from("profiles")
      .upsert(
        { user_id: userId, profile_id: profile.id, data: profile, updated_at: new Date().toISOString() },
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
    const rows = profiles.map((p) => ({
      user_id: userId,
      profile_id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));
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
    const { data, error } = await supabase
      .from("proxies")
      .select("proxy_id, data, updated_at");
    if (error) return { ok: false, error: error.message };
    return { ok: true, proxies: (data || []).map((r) => r.data) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function pushAllProxies(proxies) {
  if (!cloudReady()) return { ok: false };
  try {
    const userId = getCurrentUserId();
    if (!userId || !proxies || !proxies.length) return { ok: true, count: 0 };
    const rows = proxies.map((p) => ({
      user_id: userId,
      proxy_id: p.id,
      data: p,
      updated_at: new Date().toISOString()
    }));
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
  register, login, logout, getSession, getCurrentUserId,
  pullProfiles, pushProfile, pushAllProfiles, deleteProfileRemote,
  pullProxies, pushAllProxies, deleteProxyRemote,
  fullSync
};
