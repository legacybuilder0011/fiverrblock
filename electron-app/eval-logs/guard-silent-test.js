"use strict";
// H: guard rules active but its background never runs -> page says "VPN Guard did not start", app is told.
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  let told = "";
  const page = await vpn.connectionPage({ extension: "TestVPN", realIp: "0.0.0.0", next: [], onConnected: async () => ({}), onGuardMissing: (w) => { told = w; } });
  const g = vpn.writeGuard("silent", "0.0.0.0", page);
  fs.writeFileSync(path.join(g, "background.js"), "throw new Error('dead background');");
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "silent-"));
  const child = cp.spawn(rb.patchedChromiumBinary(), [`--user-data-dir=${udd}`, "--no-first-run", "--remote-debugging-port=9620",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${g}`, "--fingerprint=5", page], { stdio: "ignore" });
  await sleep(32000);
  const b = await chromium.connectOverCDP("http://127.0.0.1:9620"); const ctx = b.contexts()[0];
  const conn = ctx.pages().find((p) => p.url().startsWith("http://127.0.0.1"));
  const h = conn ? await conn.locator("h2").textContent() : "(no page)";
  const p2 = await ctx.newPage(); const site = await p2.goto("https://example.com/", { timeout: 10000 }).then(() => "loads", () => "blocked");
  console.log(`${h === "VPN Guard did not start" ? "PASS" : "FAIL"}  H1 page: ${h}`);
  console.log(`${site === "blocked" ? "PASS" : "FAIL"}  H2 sites still blocked: ${site}`);
  console.log(`${told === "background" ? "PASS" : "FAIL"}  H3 app told: ${told || "no"}`);
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  app.quit();
});
