"use strict";
// Launches a Camoufox profile and reads Firefox's add-on list to confirm the bundled
// extension (Firefox copy) was accepted and is active.
// Run: node_modules/electron/dist/electron.exe eval-logs/camoufox-addon-check.js
const { app } = require("electron");
const fs = require("fs"), path = require("path");
const cf = require(path.join(__dirname, "..", "src", "camoufox-manager"));
app.whenReady().then(async () => {
  const profile = { id: "addonchk", name: "addonchk", os: "windows", engine: "stealthfox", proxy: { networkMode: "direct" }, fingerprint: {} };
  const opts = cf.profileToOptions(profile);
  console.log("addons passed:", JSON.stringify(opts.addons));
  const res = await cf.launchProfile(profile, "about:blank");
  console.log("launch:", JSON.stringify(res).slice(0, 200));
  await new Promise((r) => setTimeout(r, 6000));
  const udd = opts.user_data_dir;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(udd, "extensions.json"), "utf8"));
    for (const a of j.addons || []) console.log("  addon:", a.id, "| active=" + a.active, "| userDisabled=" + a.userDisabled, "| appDisabled=" + a.appDisabled, "| location=" + a.location);
  } catch (e) { console.log("  no extensions.json:", e.message); }
  await cf.closeProfile(profile.id).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const prefs = fs.readFileSync(path.join(udd, "prefs.js"), "utf8");
  const m = /user_pref\("extensions\.webextensions\.uuids", "(.*)"\);/.exec(prefs);
  const uuids = m ? JSON.parse(m[1].replace(/\\"/g, '"')) : {};
  console.log("loaded add-on ids:", Object.keys(uuids).join(", ") || "none");
  const uuid = uuids["scroll-and-refresh@privacyshield"];
  if (uuid) {
    await cf.launchProfile(profile, `moz-extension://${uuid}/popup.html`);
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const h = require(path.join(__dirname, "..", "src", "camoufox-manager"));
      const ctx = [...(h._instances ? h._instances.values() : [])][0];
    } catch (_) {}
    console.log("popup opened at", `moz-extension://${uuid}/popup.html`);
    await cf.closeProfile(profile.id).catch(() => {});
  }
  app.quit();
});
