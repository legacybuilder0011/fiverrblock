"use strict";

// Auth + per-user data dir.
// Auth is now backed by Supabase (cloud-sync.js). The local session.json is
// kept only to remember the userId for the per-user data directory.

const fs   = require("fs");
const path = require("path");
const { app } = require("electron");
const cloud  = require("./cloud-sync");

const BASE_DIR     = path.join(app.getPath("userData"), "privacy-shield");
const SESSION_FILE = path.join(BASE_DIR, "session.json");

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch (_) { return fallback; }
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function getUserDataDir(userId) {
  return path.join(BASE_DIR, "users", userId);
}

async function register(email, password) {
  if (!email || !password) return { ok: false, error: "Email and password are required" };
  email = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address" };
  if (password.length < 6) return { ok: false, error: "Password must be at least 6 characters" };

  const result = await cloud.register(email, password);
  if (!result.ok) return result;

  // Persist the local user identifier so per-user dirs work even offline
  ensureDir(getUserDataDir(result.user.id));
  writeJson(SESSION_FILE, { userId: result.user.id, email: result.user.email, loginAt: Date.now() });

  return { ok: true, user: result.user };
}

async function login(email, password) {
  if (!email || !password) return { ok: false, error: "Email and password are required" };
  email = email.toLowerCase().trim();

  const result = await cloud.login(email, password);
  if (!result.ok) return result;

  ensureDir(getUserDataDir(result.user.id));
  writeJson(SESSION_FILE, { userId: result.user.id, email: result.user.email, loginAt: Date.now() });

  return { ok: true, user: result.user };
}

async function logout() {
  await cloud.logout();
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

function getSession() {
  return readJson(SESSION_FILE, null);
}

function getCurrentUserDataDir() {
  const session = getSession();
  if (session && session.userId) return getUserDataDir(session.userId);
  return path.join(BASE_DIR, "default");
}

module.exports = { register, login, logout, getSession, getCurrentUserDataDir };
