"use strict";
// VPN extension mode on the patched engine (debug port) with a test "VPN"
// extension that routes the browser through a local relay, like ExpressVPN does:
//   A. VPN connects -> sites load; VPN switched off -> sites blocked within seconds
//   B. next launch with the VPN still off -> a site opened at startup is blocked
//   C. switch the VPN on in that session -> sites load again
// Run: node_modules/electron/dist/electron.exe eval-logs/browser-vpn-test.js
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), netSock = require("net");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), "bvpn-"));
let port = 9390;
const results = [];
const expect = (name, got, want) => { results.push(`${got === want ? "PASS" : "FAIL"}  ${name}: ${got}`); };

const relay = http.createServer((req, res) => { res.writeHead(502); res.end(); });
relay.on("connect", (req, sock, head) => {
  const [h, p] = req.url.split(":");
  const up = netSock.connect(Number(p) || 443, h, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});

// Test VPN: on/off switch kept in its storage, applied at startup like a real VPN extension.
function testVpnExtension(relayPort) {
  const dir = path.join(udd, "..", path.basename(udd) + "-testvpn");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "TestVPN", version: "1.0", permissions: ["proxy", "storage"], background: { service_worker: "bg.js" } }));
  fs.writeFileSync(path.join(dir, "bg.js"), `
self.vpnOn = () => chrome.storage.local.set({ on: true }).then(() => chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "127.0.0.1", port: ${relayPort} } } }, scope: "regular" }));
self.vpnOff = () => chrome.storage.local.set({ on: false }).then(() => chrome.proxy.settings.clear({ scope: "regular" }));
const apply = async () => { const { on } = await chrome.storage.local.get({ on: true }); return on ? self.vpnOn() : self.vpnOff(); };
chrome.runtime.onStartup.addListener(apply); chrome.runtime.onInstalled.addListener(apply); apply();`);
  return dir;
}

async function launch(extDirs, startUrl) {
  const child = cp.spawn(rb.patchedChromiumBinary(), [`--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${++port}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${extDirs.join(",")}`,
    "--fingerprint=12345", startUrl], { stdio: "ignore" });
  await sleep(2500);
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const sw = (name) => b.contexts()[0].serviceWorkers().find((w) => w.url().endsWith(name));
  const tryOpen = async () => { const p = await b.contexts()[0].newPage(); const r = await p.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", () => "blocked"); await p.close(); return r; };
  return { b, child, sw, tryOpen, pages: () => b.contexts()[0].pages() };
}
const stop = async (s) => { try { cp.execSync(`taskkill /PID ${s.child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {} await sleep(2500); };

app.whenReady().then(async () => {
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const real = "0.0.0.0"; // the test relay exits through this PC, so no real-IP veto here
  const testVpn = testVpnExtension(relay.address().port);
  const page = () => vpn.connectionPage({ extension: "TestVPN", realIp: real, next: ["https://example.com/"], onConnected: async () => ({ country: "Testland", needsRestart: false }) });

  // A
  let s = await launch([vpn.writeGuard("bvpn", real), testVpn], await page());
  let movedOn = false;
  for (let i = 0; i < 20 && !movedOn; i++) { await sleep(1000); movedOn = s.pages().some((p) => p.url().startsWith("https://example.com")); }
  const says = movedOn ? "" : " (page says: " + await s.pages()[0].locator("body").innerText().catch(() => "?") + ")";
  expect("A1 connection page moved on once the VPN connected", (movedOn ? "moved on" : "still waiting") + says.replace(/\s+/g, " ").slice(0, 160), "moved on");
  expect("A2 sites with the VPN on", await s.tryOpen(), "loads");
  await s.sw("bg.js").evaluate(() => self.vpnOff());
  await sleep(4000);
  expect("A3 sites 4 s after the VPN was switched off (kill switch)", await s.tryOpen(), "blocked");
  await stop(s);

  // B: how the app launches in this mode (connection page first)
  s = await launch([vpn.writeGuard("bvpn", real), testVpn], await page());
  await sleep(1500);
  expect("B1 site opened 1.5 s after launch with the VPN off", await s.tryOpen(), "blocked");
  await sleep(6000);
  expect("B2 sites after 7 s with the VPN still off", await s.tryOpen(), "blocked");
  expect("B3 connection page still waiting", s.pages().some((p) => p.url().startsWith("https://example.com")) ? "moved on" : "waiting", "waiting");

  // C
  await s.sw("bg.js").evaluate(() => self.vpnOn());
  await sleep(5000);
  expect("C1 sites after switching the VPN back on", await s.tryOpen(), "loads");
  await stop(s);

  // D: team IP check. A teammate's open profile "IG 12" holds the same IP, then closes.
  let teammateOnIp = true;
  const pageD = await vpn.connectionPage({ extension: "TestVPN", realIp: real, next: ["https://example.com/"],
    onConnected: async () => ({ country: "Testland", needsRestart: false }),
    checkIp: async () => (teammateOnIp ? { name: "IG 12", device: "Office PC" } : null) });
  s = await launch([vpn.writeGuard("bvpn", real, pageD), testVpn], pageD);
  await sleep(9000);
  const conn = s.pages().find((p) => p.url().startsWith("http://127.0.0.1"));
  const heading = conn ? await conn.locator("h2").textContent().catch(() => "") : "(page moved on)";
  expect("D1 page asks for a different location", heading, "Pick a different VPN location");
  expect("D2 sites while the IP is in use by a teammate", await s.tryOpen(), "blocked");
  const guardSw = s.b.contexts()[0].serviceWorkers().find((w) => w.url().endsWith("background.js"));
  if (guardSw) console.log("guard debug:", JSON.stringify(await guardSw.evaluate(async () => {
    let r; try { r = await (await fetch(self.STATUS_URL + "allowed?ip=1.2.3.4", { cache: "no-store" })).text(); } catch (e) { r = "fetch error: " + e.message; }
    return { statusUrl: self.STATUS_URL, answer: r, state: await chrome.storage.session.get(null) };
  }).catch((e) => String(e))).replace(/"ip":"([0-9]+\.[0-9]+)\.[0-9.]+"/g, '"ip":"$1.x.x"'));
  teammateOnIp = false;
  movedOn = false;
  for (let i = 0; i < 20 && !movedOn; i++) { await sleep(1000); movedOn = s.pages().some((p) => p.url().startsWith("https://example.com")); }
  expect("D3 page moves on once the IP is free", movedOn ? "moved on" : "still waiting", "moved on");
  await sleep(31000); // the guard rechecks every 30 s
  expect("D4 sites once the IP is free", await s.tryOpen(), "loads");
  await stop(s);

  console.log(results.join("\n"));
  relay.close(); app.quit();
});
