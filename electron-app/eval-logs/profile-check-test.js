"use strict";
// Runs the in-app "Check this profile" (src/profile-check.js) on real engines through
// a local fake proxy (answers ipify over CONNECT-less plain HTTP? no: tunnels HTTPS).
// Run: node_modules/electron/dist/electron.exe eval-logs/profile-check-test.js <engine>
const { app } = require("electron");
const http = require("http"), netSock = require("net"), path = require("path");
const src = (m) => require(path.join(__dirname, "..", "src", m));
const AUTH = "Basic " + Buffer.from("psuser:pspass").toString("base64");
const engine = ["real-brave", "patched-chromium"].find((e) => process.argv.includes(e)) || "patched-chromium";
const proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
proxy.on("connect", (req, sock, head) => {
  if (req.headers["proxy-authorization"] !== AUTH) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"t\"\r\n\r\n"); return; }
  const [host, port] = req.url.split(":");
  const up = netSock.connect(Number(port) || 443, host, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
app.whenReady().then(async () => {
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const profile = { id: "chk-" + engine, name: "chk", os: "windows", browserApp: "chrome", engine,
    proxy: { networkMode: "proxy", enabled: true, scheme: "http", host: "127.0.0.1", port: proxy.address().port, username: "psuser", password: "pspass" },
    fingerprint: { browser: "chrome", fingerprintSeed: "chk-" + engine, timezone: "manual", timezoneValue: "America/New_York", language: "manual", languageValue: "en-US" } };
  const config = src("profile-store").buildConfigFromProfile(profile);
  const rb = src("real-browser-manager");
  const t0 = Date.now();
  const res = await src("profile-check").runCheck({ profile, config, others: [{ id: "x", name: "Twin", fpHash: "nope", ip: "" }],
    open: (url) => rb.launchProfile(profile, url, {}) });
  await rb.closeProfile(profile.id).catch(() => {});
  console.log(engine, "took", Math.round((Date.now() - t0) / 1000) + "s", "ok=" + res.ok, "passed=" + res.passed, res.error || "");
  for (const c of res.checks || []) console.log(" ", c.ok === true ? "PASS" : c.ok === false ? "FAIL" : "INFO", c.name, "-", c.detail);
  proxy.close(); app.quit();
});
