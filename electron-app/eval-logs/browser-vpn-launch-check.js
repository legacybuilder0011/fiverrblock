"use strict";
// The real launch path for "VPN extension" mode: guard loaded, connection page
// first, Chrome's own session restore off. Run with Electron.
const { app } = require("electron");
const fs = require("fs"), path = require("path"), cp = require("child_process");
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
app.whenReady().then(async () => {
  const profile = { id: "bvpn-launch", name: "t", os: "windows", engine: "patched-chromium", proxy: { networkMode: "extension" }, fingerprint: { browser: "chrome", fingerprintSeed: "bvpn" }, extensions: [] };
  const url = await vpn.connectionPage({ extension: "TestVPN", realIp: "0.0.0.0", next: [], onConnected: async () => ({}) });
  const res = await rb.launchProfile(profile, url, { extraExtensionDirs: [vpn.writeGuard(profile.id, "0.0.0.0")] });
  await new Promise((r) => setTimeout(r, 3000));
  const cmd = cp.execSync(`powershell -NoProfile -c "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${res.pid}\\").CommandLine"`, { encoding: "utf8" });
  await rb.closeProfile(profile.id);
  await new Promise((r) => setTimeout(r, 1500));
  const prefs = JSON.parse(fs.readFileSync(path.join(res.dataDir, "Default", "Preferences"), "utf8"));
  console.log("launched:", res.ok);
  console.log("guard loaded:", /vpn-guard/.test(cmd));
  console.log("opens connection page first:", cmd.includes(url));
  console.log("no proxy flag (VPN extension controls the connection):", !/--proxy-server/.test(cmd));
  console.log("Chrome session restore off:", prefs.session && prefs.session.restore_on_startup === 5);
  app.quit();
});
