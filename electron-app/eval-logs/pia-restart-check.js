"use strict";
// Real PIA: log in + connect, close the browser, reopen the same profile.
// Does PIA's background come back and does the connection work after reopening?
// Run: PIA_USER=.. PIA_PASS=.. electron eval-logs/pia-restart-check.js <pia dir> [noguard]
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x");
const ID = "jplnlifepflhkbkgonidnobkakhmpnmh";
app.whenReady().then(async () => {
  const src = process.argv.find((a) => a.includes(ID));
  const noGuard = process.argv.includes("noguard");
  const pia = fs.mkdtempSync(path.join(os.tmpdir(), "pia-")); fs.cpSync(src, pia, { recursive: true });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "piar-"));
  const real = await vpn.realIp();
  let port = 9470;
  async function launch() {
    const page = await vpn.connectionPage({ extension: "PIA", realIp: real, next: [], onConnected: async () => ({}) });
    const exts = noGuard ? [pia] : [pia, vpn.writeGuard("pia-restart", real, page)];
    const child = cp.spawn("C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", [`--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${++port}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${exts.join(",")}`, page], { stdio: "ignore" });
    await sleep(4000);
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return { b, child, ctx: b.contexts()[0] };
  }
  async function report(s, label) {
    const ctx = s.ctx;
    const piaSw = ctx.serviceWorkers().some((w) => w.url().includes(ID));
    const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/src/popup.html`); await sleep(4000);
    const popText = mask((await pop.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")).slice(0, 110);
    const p2 = await ctx.newPage();
    const ex = await p2.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", (e) => "fails: " + String(e.message).split("\n")[0].slice(0, 50));
    await p2.close();
    console.log(`[${label}] PIA worker running: ${piaSw} | PIA popup: ${popText} | example.com: ${ex}`);
    return pop;
  }
  let s = await launch();
  const popup = await s.ctx.newPage();
  await popup.goto(`chrome-extension://${ID}/src/popup.html`); await sleep(2500);
  for (let step = 0; step < 8; step++) {
    const t = (await popup.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/^\s*CONNECTED/.test(t)) break;
    const pw = popup.locator("input[type=password]");
    if (await pw.count()) { await popup.locator("input").first().fill(process.env.PIA_USER); await pw.first().fill(process.env.PIA_PASS);
      await popup.getByText(/^\s*log ?in\s*$/i).last().click().catch(() => {}); await sleep(5000); continue; }
    const btn = popup.getByText(/^(get started|skip)$/i).first();
    if (await btn.count()) { await btn.click().catch(() => {}); await sleep(1500); continue; }
    await popup.locator(".power-button").first().click().catch(() => {}); await sleep(7000);
  }
  await sleep(8000);
  await report(s, "first launch");
  // Close like a user (the X button), not a kill.
  const cdp = await s.b.newBrowserCDPSession(); await cdp.send("Browser.close").catch(() => {});
  await sleep(5000);
  s = await launch();
  await sleep(15000);
  await report(s, "after reopen, 15 s");
  await sleep(20000);
  const pop = await report(s, "after reopen, 40 s");
  if (/Something went wrong|Receiving end/.test(await pop.locator("body").innerText().catch(() => ""))) {
    const sw = s.ctx.serviceWorkers().map((w) => w.url().split("/")[2].slice(0, 6)).join(",");
    console.log("service workers running:", sw);
  }
  try { cp.execSync(`taskkill /PID ${s.child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  app.quit();
});
