"use strict";
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
function restoreWindow(pid, waitMs = 15000, placeOnForeground = false) {
  if (process.platform !== "win32") return Promise.resolve({ ok: true });
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve({ ok: false, reason: "invalid-pid" });
  // Read via Electron's asar-aware fs; PowerShell cannot read an asar path.
  const script = fs.readFileSync(path.join(__dirname, "browser-window.ps1"), "utf8");
  const place = placeOnForeground ? " -PlaceOnForeground" : "";
  const command = "& {\n" + script + "\n} -BrowserPid " + pid + " -WaitMs " + Math.max(0, Math.min(15000, waitMs)) + place;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 25000, maxBuffer: 65536 }, (err, stdout) => {
        if (err) return resolve({ ok: false, reason: "window-check-failed" });
        try { resolve(JSON.parse(String(stdout).trim())); }
        catch (_) { resolve({ ok: false, reason: "window-check-failed" }); }
      });
  });
}
function waitForWindow(child, check = (pid) => restoreWindow(pid, 15000, true)) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onError = (err) => finish({ ok: false, reason: "launch-failed", detail: "Browser could not start (" + (err.code || "process error") + ")." });
    const onExit = (code) => finish({ ok: false, reason: "launch-failed", detail: "Browser exited before opening a window (code " + (code == null ? "unknown" : code) + ")." });
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode != null) return onExit(child.exitCode);
    setImmediate(() => {
      if (finished) return;
      Promise.resolve().then(() => check(child.pid)).then(finish, () => finish({ ok: false, reason: "window-check-failed" }));
    });
  });
}
module.exports = { restoreWindow, waitForWindow };
