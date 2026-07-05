"use strict";

// Auto-update via electron-updater, wired to GitHub Releases
// (publish config in package.json). Downloads new versions in the
// background and offers to restart-and-install.
//
// Active ONLY in the packaged app. During `npm start` (dev / unpackaged)
// there is no update metadata (app-update.yml) and autoUpdater would throw,
// so we no-op. Every path is wrapped so a network/parse failure can never
// crash startup.

const { app, dialog, BrowserWindow } = require("electron");

let started = false;

function initAutoUpdater(logInfo, logError) {
  const info = (m) => { try { logInfo && logInfo("auto-updater: " + m); } catch (_) {} };
  const fail = (m) => { try { logError && logError("auto-updater: " + m); } catch (_) {} };

  if (started) return;
  started = true;

  if (!app.isPackaged) { info("skipped (dev / unpackaged)"); return; }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    fail("electron-updater not available: " + (err.message || err));
    return;
  }

  // Download in the background; install on quit if the user doesn't restart now.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => info("checking"));
  autoUpdater.on("update-available", (i) => info("update available " + (i && i.version)));
  autoUpdater.on("update-not-available", () => info("up to date"));
  autoUpdater.on("download-progress", (p) => info("downloading " + Math.round(p && p.percent || 0) + "%"));
  autoUpdater.on("error", (err) => fail("error: " + (err && (err.stack || err.message) || err)));

  autoUpdater.on("update-downloaded", async (i) => {
    info("downloaded " + (i && i.version));
    const parent = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed());
    try {
      const { response } = await dialog.showMessageBox(parent || undefined, {
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `Privacy Shield ${i && i.version ? "v" + i.version : "update"} is ready to install.`,
        detail: "The update has been downloaded. Restart now to apply it, or it will install automatically the next time you close the app."
      });
      if (response === 0) setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch (e) { fail("quitAndInstall: " + (e.message || e)); } });
    } catch (_) {
      // Dialog failed — the autoInstallOnAppQuit fallback still applies.
    }
  });

  const check = () => {
    try {
      const p = autoUpdater.checkForUpdates();
      if (p && p.catch) p.catch((err) => fail("checkForUpdates rejected: " + (err.message || err)));
    } catch (err) {
      fail("check threw: " + (err.message || err));
    }
  };

  // First check shortly after launch, then every 6 hours (this is a tray app
  // that can stay open for days).
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

module.exports = { initAutoUpdater };
