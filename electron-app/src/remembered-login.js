"use strict";
// Remembered sign-in for this computer: the last email always, the password only
// when "Remember me" is ticked, encrypted by the OS (Windows DPAPI / macOS
// Keychain). Lets the app sign itself back in when the cloud rejects the saved
// session (a renewal lost to a dropped connection logs the user out), so team
// members don't have to dig up their email and password after updates.

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "privacy-shield", "remembered-login.json");

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), "utf8")) || {}; } catch (_) { return {}; }
}
function write(data) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(data));
}

// password null = remember the email only (and forget any saved password).
function remember(email, password) {
  const data = { email: String(email || "").trim().toLowerCase() };
  if (password) {
    try {
      if (safeStorage.isEncryptionAvailable()) data.passwordEnc = safeStorage.encryptString(String(password)).toString("base64");
    } catch (_) {}
  }
  write(data);
}

// { email, password } — password is "" when none is saved or the OS cannot
// decrypt it (e.g. the macOS Keychain refused a new unsigned build).
function get() {
  const data = read();
  let password = "";
  if (data.passwordEnc) {
    try { password = safeStorage.decryptString(Buffer.from(data.passwordEnc, "base64")); } catch (_) {}
  }
  return { email: data.email || "", password };
}

function forgetPassword() {
  const data = read();
  if (data.passwordEnc) { delete data.passwordEnc; write(data); }
}

module.exports = { remember, get, forgetPassword };
