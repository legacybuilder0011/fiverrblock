"use strict";
// Loads the real ExpressVPN extension (not logged in) with the VPN guard and
// prints what the guard sees, then tries a site.
// Run: electron eval-logs/browser-vpn-express-check.js <expressvpn-extension-dir>
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const exp = process.argv.find((a) => a.includes("fgddmllnllkalaagkghckoinaemmogpe"));
  const real = await vpn.realIp();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "expchk-"));
  const page = await vpn.connectionPage({ extension: "ExpressVPN", realIp: real, next: [], onConnected: async () => ({}) });
  const exe = process.argv.includes("brave") ? "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" : rb.patchedChromiumBinary();
  const child = cp.spawn(exe, [`--user-data-dir=${udd}`, "--no-first-run", "--remote-debugging-port=9411",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${vpn.writeGuard("expchk", real, page)},${exp}`, "--fingerprint=1", page], { stdio: "ignore" });
  await sleep(8000);
  const b = await chromium.connectOverCDP("http://127.0.0.1:9411");
  if (process.argv.includes("popup")) {
    const popup = await b.contexts()[0].newPage();
    await popup.goto("chrome-extension://fgddmllnllkalaagkghckoinaemmogpe/" + (process.env.POPUP || "popup.html")).catch((e) => console.log("popup open error", String(e).slice(0, 120)));
    console.log("popup text:", (await popup.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    await sleep(8000);
  }
  const g = b.contexts()[0].serviceWorkers().find((w) => w.url().endsWith("background.js") && !w.url().includes("fgdd"));
  const st = g ? await g.evaluate(async () => ({ proxy: await chrome.proxy.settings.get({}), state: await chrome.storage.session.get(null) })).catch((e) => String(e)) : "guard not found";
  console.log("guard sees:", JSON.stringify(st).replace(/"ip":"([0-9]+\.[0-9]+)\.[0-9.]+"/g, '"ip":"$1.x.x"').slice(0, 600));
  const p = await b.contexts()[0].newPage();
  console.log("example.com with ExpressVPN installed but NOT logged in:", await p.goto("https://example.com/", { timeout: 15000 }).then(() => "LOADS (leak)", () => "blocked"));
  for (const q of ["https://duckduckgo.com/?q=test", "https://www.google.com/search?q=test", "https://search.brave.com/search?q=test"]) {
    console.log("search", q.split("/")[2] + ":", await p.goto(q, { timeout: 15000 }).then(() => "LOADS (leak)", () => "blocked"));
  }
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  app.quit();
});
