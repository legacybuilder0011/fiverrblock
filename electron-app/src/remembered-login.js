"use strict";
// "Remember me": the last email (to prefill the login page) and, per account,
// the password encrypted by the OS (DPAPI / Keychain via safeStorage). Per
// account so "Continue as" and quiet re-login work for every saved account,
// not only the last one used.

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "privacy-shield", "remembered-login.json");
const norm = (email) => String(email || "").trim().toLowerCase();

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), "utf8")) || {}; } catch (_) { return {}; }
}
function write(data) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(data));
}
// Older files kept one password in passwordEnc for data.email.
function passwords(data) {
  const map = { ...(data.passwords || {}) };
  if (data.passwordEnc && data.email && !map[data.email]) map[data.email] = data.passwordEnc;
  return map;
}

// password null = remember the email only (and forget that account's password).
function remember(email, password) {
  const data = read();
  const key = norm(email);
  const map = passwords(data);
  delete map[key];
  if (password) {
    try {
      if (safeStorage.isEncryptionAvailable()) map[key] = safeStorage.encryptString(String(password)).toString("base64");
    } catch (_) {}
  }
  write({ email: key, passwords: map });
}

// { email, password } for the given account (default: the last email). password
// is "" when none is saved or the OS cannot decrypt it (e.g. the macOS Keychain
// refused a new unsigned build).
function get(email) {
  const data = read();
  const key = norm(email) || data.email || "";
  const enc = passwords(data)[key];
  let password = "";
  if (enc) {
    try { password = safeStorage.decryptString(Buffer.from(enc, "base64")); } catch (_) {}
  }
  return { email: key, password };
}

function forgetPassword(email) {
  const data = read();
  const map = passwords(data);
  const key = norm(email) || data.email;
  if (map[key]) { delete map[key]; write({ email: data.email || "", passwords: map }); }
}

module.exports = { remember, get, forgetPassword };
