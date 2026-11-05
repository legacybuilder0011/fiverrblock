"use strict";
// Opens two profiles of one engine at once, then prints each window's taskbar AppUserModelID.
// Run: node_modules/electron/dist/electron.exe eval-logs/taskbar-check.js <engine> <read-aumid.ps1>
const { app } = require("electron");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const engine = ["real-brave", "patched-chromium"].find((e) => process.argv.includes(e)) || "patched-chromium";
const prof = (id) => ({ id, name: id, os: "windows", browserApp: "chrome", engine, proxy: { networkMode: "direct" }, fingerprint: { browser: "chrome", fingerprintSeed: id } });
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => res.end("<title>fp " + req.url + "</title>fp"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = prof("tbA" + Date.now()), b = prof("tbB" + Date.now());
  console.log("A:", JSON.stringify(await rb.launchProfile(a, base + "/A", {})).slice(0, 80));
  console.log("B:", JSON.stringify(await rb.launchProfile(b, base + "/B", {})).slice(0, 80));
  await new Promise((r) => setTimeout(r, 2000));
  console.log(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", process.argv[process.argv.length - 1]], { encoding: "utf8" }));
  await rb.closeProfile(a.id); await rb.closeProfile(b.id);
  server.close(); app.quit();
});
