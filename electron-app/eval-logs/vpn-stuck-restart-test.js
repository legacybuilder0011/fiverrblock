"use strict";
// F: VPN extension "connected" but passing nothing (its worker died in real life).
// The guard must restart it after ~20 s; the restarted VPN works -> sites load.
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), netSock = require("net");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relay = http.createServer((q, r) => { r.writeHead(502); r.end(); });
relay.on("connect", (req, sock, head) => {
  const [h, p] = req.url.split(":");
  const up = netSock.connect(Number(p) || 443, h, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
app.whenReady().then(async () => {
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-"));
  const dir = udd + "-vpn"; fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "StuckVPN", version: "1.0", permissions: ["proxy", "storage"], background: { service_worker: "bg.js" } }));
  // First start: proxy points at a closed port (connected, nothing passes). Later starts: the working relay.
  fs.writeFileSync(path.join(dir, "bg.js"), `(async () => { const { starts = 0 } = await chrome.storage.local.get("starts");
    await chrome.storage.local.set({ starts: starts + 1 });
    const port = starts === 0 ? 1 : ${relay.address().port};
    chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "127.0.0.1", port } } }, scope: "regular" }); })();`);
  let logged = [];
  const page = await vpn.connectionPage({ extension: "StuckVPN", realIp: "0.0.0.0", next: [], onConnected: async () => ({}), onGuardState: (g) => logged.push(g) });
  const child = cp.spawn(rb.patchedChromiumBinary(), [`--user-data-dir=${udd}`, "--no-first-run", "--remote-debugging-port=9499",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${vpn.writeGuard("stuck", "0.0.0.0", page)},${dir}`, "--fingerprint=3", page], { stdio: "ignore" });
  await sleep(3000);
  const b = await chromium.connectOverCDP("http://127.0.0.1:9499"); const ctx = b.contexts()[0];
  const tryOpen = async () => { const p = await ctx.newPage(); const r = await p.goto("https://example.com/", { timeout: 12000 }).then(() => "loads", () => "blocked"); await p.close(); return r; };
  const r1 = await tryOpen();
  await sleep(40000);
  const r2 = await tryOpen();
  const restarted = logged.find((g) => g.restarted);
  console.log(`${r1 === "blocked" ? "PASS" : "FAIL"}  F1 stuck VPN: sites ${r1}`);
  console.log(`${restarted ? "PASS" : "FAIL"}  F2 guard restarted it: ${restarted ? restarted.restarted : "no"}`);
  console.log(`${r2 === "loads" ? "PASS" : "FAIL"}  F3 after restart: sites ${r2}`);
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  relay.close(); app.quit();
});
