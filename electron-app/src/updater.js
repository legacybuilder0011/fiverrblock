"use strict";

// Auto-update via electron-updater, wired to GitHub Releases
// (publish config in package.json). Downloads new versions in the
// background and offers to restart-and-install.
//
// Active ONLY in the packaged app. During `npm start` (dev / unpackaged)
// there is no update metadata (app-update.yml) and autoUpdater would throw,
// so we no-op. Every path is wrapped so a network/parse failure can never
// crash startup.

const { app, dialog, BrowserWindow, net } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const RELEASES_URL = "https://github.com/legacybuilder0011/fiverrblock/releases/latest";
const DOWNLOAD_BASE = "https://github.com/legacybuilder0011/fiverrblock/releases/download";

let started = false;

// This Mac's zip from latest-mac.yml: the arm64 one on Apple chips, the other on Intel.
function pickMacZip(files, arch) {
  const zips = (files || []).filter((f) => f && /\.zip$/i.test(f.url || ""));
  return zips.find((f) => (arch === "arm64") === /arm64/i.test(f.url));
}

// Streams to disk and returns the base64 sha512 latest-mac.yml lists.
// ponytail: ignores write backpressure; fine for a ~200 MB file on local disk.
function download(url, dest, size, win) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash("sha512");
    let got = 0;
    const req = net.request(url);
    req.on("response", (res) => {
      if (res.statusCode !== 200) { out.destroy(); return reject(new Error("Download failed: HTTP " + res.statusCode)); }
      res.on("data", (chunk) => {
        got += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        if (size && win && !win.isDestroyed()) win.setProgressBar(Math.min(1, got / size));
      });
      res.on("end", () => out.end(() => resolve(hash.digest("base64"))));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
});

// Unsigned self-update: the app downloads the zip itself, so it never gets the
// quarantine flag and Gatekeeper's "could not verify" prompt doesn't come back.
// The bundle is swapped by a shell script after this process exits.
async function macSelfUpdate(i, win, info) {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) throw new Error("App bundle not found at " + bundle);
  if (bundle.startsWith("/Volumes/")) throw new Error("The app is running from the installer disk. Drag it into Applications first.");
  fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  const file = pickMacZip(i && i.files, process.arch);
  if (!file) throw new Error("No Mac update file for " + process.arch);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ps-update-"));
  const zip = path.join(work, "update.zip");
  info(`mac update: downloading ${file.url}`);
  try {
    const sha = await download(`${DOWNLOAD_BASE}/v${i.version}/${file.url}`, zip, file.size, win);
    if (file.sha512 && sha !== file.sha512) throw new Error("The download was damaged (checksum mismatch). Try again later.");
    await run("/usr/bin/ditto", ["-x", "-k", zip, path.join(work, "app")]);
  } finally {
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
  }
  const name = fs.readdirSync(path.join(work, "app")).find((n) => n.endsWith(".app"));
  if (!name) throw new Error("The update file has no app inside.");
  const fresh = path.join(work, "app", name);
  await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", fresh]).catch(() => {});

  try { await require("./real-browser-manager").closeAllAndSettle(); } catch (_) {}
  try { await require("./camoufox-manager").closeAll(); } catch (_) {}

  // Keep the old bundle until the new one is in place; put it back if the move fails.
  const script = 'while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done\n' +
    'rm -rf "$OLD.old"\n' +
    'if mv "$OLD" "$OLD.old"; then\n' +
    '  if mv "$NEW" "$OLD"; then rm -rf "$OLD.old"; else mv "$OLD.old" "$OLD"; fi\n' +
    'fi\n' +
    'open "$OLD"\n' +
    'rm -rf "$WORK"\n';
  spawn("/bin/sh", ["-c", script], {
    detached: true, stdio: "ignore",
    env: { ...process.env, PID: String(process.pid), OLD: bundle, NEW: fresh, WORK: work }
  }).unref();
  info(`mac update: installing v${i.version}, restarting`);
  app.quit();
}

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

  // macOS builds are unsigned and Squirrel.Mac refuses to install unsigned
  // updates, so on a Mac the app swaps its own bundle (macSelfUpdate).
  if (process.platform === "darwin") {
    autoUpdater.autoDownload = false;
    let told = "";
    autoUpdater.on("update-available", async (i) => {
      const v = (i && i.version) || "";
      if (!v || told === v) return;
      told = v;
      const parent = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed());
      try {
        const { response } = await dialog.showMessageBox(parent || undefined, {
          type: "info", buttons: ["Update now", "Later"], defaultId: 0, cancelId: 1,
          title: "Update available",
          message: `Privacy Shield v${v} is available.`,
          detail: "The app downloads the update, closes and reopens on the new version. Open profiles are saved first."
        });
        if (response !== 0) return;
        await macSelfUpdate(i, parent, info);
      } catch (err) {
        fail("mac update: " + (err && (err.stack || err.message) || err));
        const { response } = await dialog.showMessageBox(parent || undefined, {
          type: "warning", buttons: ["Open download page", "Later"], defaultId: 0, cancelId: 1,
          title: "Update failed",
          message: "The update could not be installed automatically.",
          detail: "Download the new Mac version, open it and drag Privacy Shield Browser into Applications (Replace).\n\n" + (err && err.message || err)
        }).catch(() => ({ response: 1 }));
        if (response === 0) require("electron").shell.openExternal(RELEASES_URL);
      }
    });
  } else {
    // Download in the background; install on quit if the user doesn't restart now.
    autoUpdater.autoDownload = true;
  }
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
