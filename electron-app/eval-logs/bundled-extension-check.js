"use strict";
// Launches a profile per engine and reads the browser's own extension records to
// confirm the bundled extensions loaded and are enabled.
// Run: node_modules/electron/dist/electron.exe eval-logs/bundled-extension-check.js
const { app } = require("electron");
const fs = require("fs"), path = require("path");
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const engines = ["patched-chromium", "real-brave"].filter((e) => process.argv.includes(e));
app.whenReady().then(async () => {
  for (const engine of engines.length ? engines : ["patched-chromium", "real-brave"]) {
    const profile = { id: "extchk-" + engine, name: "extchk", os: "windows", browserApp: "chrome", engine, proxy: { networkMode: "direct" }, fingerprint: { browser: "chrome", fingerprintSeed: "extchk" } };
    const res = await rb.launchProfile(profile, "about:blank", {});
    await new Promise((r) => setTimeout(r, 5000));
    await rb.closeProfile(profile.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const dir = res.dataDir;
    let found = [];
    for (const f of ["Secure Preferences", "Preferences"]) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, "Default", f), "utf8"));
        const st = (j.extensions && j.extensions.settings) || {};
        for (const [id, e] of Object.entries(st)) {
          if (String(e.path || "").includes("scroll-and-refresh")) found.push(`${id} state=${e.state} disable_reasons=${JSON.stringify(e.disable_reasons || [])} location=${e.location} (${f})`);
        }
      } catch (_) {}
    }
    console.log(engine, "launch ok=" + res.ok, found.length ? "\n   " + found.join("\n   ") : "\n   NOT FOUND in browser extension records");
  }
  app.quit();
});
