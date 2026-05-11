"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

const BASE_DIR    = path.join(app.getPath("userData"), "privacy-shield");
const USERS_FILE  = path.join(BASE_DIR, "accounts.json");
const SESSION_FILE = path.join(BASE_DIR, "session.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + password + "ps2024").digest("hex");
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getUsers() {
  const data = readJson(USERS_FILE, []);
  return Array.isArray(data) ? data : [];
}

function getUserDataDir(userId) {
  return path.join(BASE_DIR, "users", userId);
}

function register(email, password) {
  if (!email || !password) return { ok: false, error: "Email and password are required" };
  email = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address" };
  if (password.length < 6) return { ok: false, error: "Password must be at least 6 characters" };

  const users = getUsers();
  if (users.find((u) => u.email === email)) return { ok: false, error: "This email is already registered" };

  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id: generateId(), email, passwordHash: hashPassword(password, salt), salt, createdAt: Date.now() };
  users.push(user);
  writeJson(USERS_FILE, users);

  // Create user data directory and migrate any pre-account profiles into it
  const userDir = getUserDataDir(user.id);
  ensureDir(userDir);
  migrateExistingData(userDir);

  // Save session
  writeJson(SESSION_FILE, { userId: user.id, email: user.email, loginAt: Date.now() });

  return { ok: true, user: { id: user.id, email: user.email } };
}

function login(email, password) {
  if (!email || !password) return { ok: false, error: "Email and password are required" };
  email = email.toLowerCase().trim();

  const users = getUsers();
  const user = users.find((u) => u.email === email);
  if (!user) return { ok: false, error: "Incorrect email or password" };

  if (hashPassword(password, user.salt) !== user.passwordHash)
    return { ok: false, error: "Incorrect email or password" };

  writeJson(SESSION_FILE, { userId: user.id, email: user.email, loginAt: Date.now() });
  return { ok: true, user: { id: user.id, email: user.email } };
}

function logout() {
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

// On first account creation, migrate profiles/proxies from old flat location into user dir
function migrateExistingData(userDir) {
  const oldProfiles = path.join(BASE_DIR, "profiles.json");
  const oldProxy    = path.join(BASE_DIR, "proxy-library.json");
  const oldOpen     = path.join(BASE_DIR, "open-profiles.json");
  const newProfiles = path.join(userDir, "profiles.json");
  const newProxy    = path.join(userDir, "proxy-library.json");
  const newOpen     = path.join(userDir, "open-profiles.json");
  if (fs.existsSync(oldProfiles) && !fs.existsSync(newProfiles))
    fs.copyFileSync(oldProfiles, newProfiles);
  if (fs.existsSync(oldProxy) && !fs.existsSync(newProxy))
    fs.copyFileSync(oldProxy, newProxy);
  if (fs.existsSync(oldOpen) && !fs.existsSync(newOpen))
    fs.copyFileSync(oldOpen, newOpen);
}

module.exports = { register, login, logout, getSession, getCurrentUserDataDir };
