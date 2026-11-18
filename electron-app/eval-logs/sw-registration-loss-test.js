"use strict";
// G: the guard's background registration is lost while the profile still lists it
// (what happened in "mr anuoluwapo"). G1 reproduces it with the old fixed version;
// G2 checks that a launch with writeGuard's new version brings it back.
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), netSock = require("net");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BRAVE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const relay = http.createServer((q, r) => { r.writeHead(502); r.end(); });
relay.on("connect", (req, sock, head) => { const [h, p] = req.url.split(":");
  const up = netSock.connect(Number(p) || 443, h, () => { sock.write("HTTP/1.1 200 OK\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy()); });
app.whenReady().then(async () => {
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "swloss-"));
  const vdir = udd + "-vpn"; fs.mkdirSync(vdir);
  fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "TestVPN", version: "1.0", permissions: ["proxy"], background: { service_worker: "bg.js" } }));
  fs.writeFileSync(path.join(vdir, "bg.js"), `chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "127.0.0.1", port: ${relay.address().port} } } }, scope: "regular" });`);
  let port = 9600, child, b;
  const launch = async (guardDir, page) => {
    child = cp.spawn(BRAVE, [`--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${++port}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${vdir},${guardDir}`, page], { stdio: "ignore" });
    await sleep(5000); b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  };
  const regs = async () => { const p = await b.contexts()[0].newPage(); await p.goto("chrome://serviceworker-internals/"); await sleep(1500);
    const t = await p.locator("body").innerText(); await p.close(); return (t.match(/Scope: chrome-extension:\/\/\w+/g) || []).length; };
  const tryOpen = async () => { const p = await b.contexts()[0].newPage(); const r = await p.goto("https://example.com/", { timeout: 12000 }).then(() => "loads", () => "blocked"); await p.close(); return r; };
  const closeNicely = async () => { const s = await b.newBrowserCDPSession(); await s.send("Browser.close").catch(() => {}); await sleep(5000); };
  const page = () => vpn.connectionPage({ extension: "TestVPN", realIp: "0.0.0.0", next: [], onConnected: async () => ({}) });

  // 1. Normal launch with a fixed-version guard (how 1.18.49 and older worked).
  const fixed = vpn.writeGuard("swloss", "0.0.0.0", await page());
  const mf = path.join(fixed, "manifest.json"); const m = JSON.parse(fs.readFileSync(mf, "utf8")); m.version = "1.0.0"; fs.writeFileSync(mf, JSON.stringify(m));
  await launch(fixed, await page()); await sleep(6000);
  console.log("setup: extension backgrounds registered:", await regs(), "| sites:", await tryOpen());
  // 2. Lose the guard's registration the way the live profile did, then close.
  // Like updating 1.18.48 -> 1.18.49: same version 1.0.0, one more permission. Start, force-close, start.
  await closeNicely();
  const m2 = JSON.parse(fs.readFileSync(mf, "utf8")); m2.permissions = (m2.permissions || []).filter((x) => x !== "management");
  fs.writeFileSync(mf, JSON.stringify(m2));
  await launch(fixed, await page()); await sleep(6000); await closeNicely();
  m2.permissions.push("management"); fs.writeFileSync(mf, JSON.stringify(m2));
  await launch(fixed, await page()); await sleep(8000);
  console.log("  after permission change, same version: registered", await regs(), "| sites", await tryOpen());
  try { child.kill(); cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {} await sleep(3000);
  // 3. Reopen with the same fixed version: the guard background should stay missing.
  await launch(fixed, await page()); await sleep(8000);
  const n1 = await regs(), r1 = await tryOpen();
  console.log(`${n1 < 2 && r1 === "blocked" ? "PASS" : "FAIL"}  G1 reproduced: backgrounds registered ${n1}/2, sites ${r1}`);
  await closeNicely();
  // 4. Reopen the way the fixed app does: writeGuard stamps a new version.
  const pg2 = await page(); await sleep(2100);
  await launch(vpn.writeGuard("swloss", "0.0.0.0", pg2), pg2); await sleep(8000);
  const n2 = await regs(), r2 = await tryOpen();
  console.log(`${n2 === 2 && r2 === "loads" ? "PASS" : "FAIL"}  G2 new version brings it back: backgrounds registered ${n2}/2, sites ${r2}`);
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  relay.close(); app.quit();
});
