"use strict";
// Opens a COPY of a real profile with the app's launch arguments + a debug port,
// logs PIA in if needed, connects, reports PIA's worker / popup / whether sites
// load; with --reopen, closes the browser like a user and reopens it.
// Run: PIA_USER=.. PIA_PASS=.. electron eval-logs/profile-copy-check.js [--reopen] <copyDir> <profileId>
const { app } = require("electron");
const cp = require("child_process"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x");
const ID = "jplnlifepflhkbkgonidnobkakhmpnmh";
const BRAVE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const text = async (p) => mask((await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")).slice(0, 120);

async function check(ctx, label) {
  const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/src/popup.html`); await sleep(5000);
  let t = await text(pop);
  for (let step = 0; step < 6 && !/^\s*CONNECTED/.test(t); step++) {
    const pw = pop.locator("input[type=password]");
    if (await pw.count()) {
      await pop.locator("input").first().fill(process.env.PIA_USER); await pw.first().fill(process.env.PIA_PASS);
      await pop.getByText(/^\s*log ?in\s*$/i).last().click().catch(() => {}); await sleep(5000);
    } else if (await pop.getByText(/^(get started|skip)$/i).count()) {
      await pop.getByText(/^(get started|skip)$/i).first().click().catch(() => {}); await sleep(1500);
    } else if (await pop.locator(".power-button").count()) {
      await pop.locator(".power-button").first().click().catch(() => {}); await sleep(12000);
    } else break;
    t = await text(pop);
  }
  await sleep(6000);
  const p2 = await ctx.newPage();
  const ex = await p2.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", (e) => "fails " + String(e.message).split("\n")[0].slice(0, 60));
  console.log(`[${label}] PIA worker: ${ctx.serviceWorkers().some((w) => w.url().includes(ID))} | popup: ${await text(pop)} | example.com: ${ex}`);
}

app.whenReady().then(async () => {
  const [copyDir, id] = process.argv.slice(-2);
  const root = path.join(process.env.APPDATA, "privacy-shield");
  const real = await vpn.realIp();
  const page = await vpn.connectionPage({ extension: "PIA", realIp: real, next: [], onConnected: async () => ({}),
    onGuardState: (g) => console.log("  guard:", mask(`vpnOn=${g.vpnOn} mode=${g.mode} ip=${g.ip || "-"} err=${(g.ipError || "-").slice(0, 80)} safe=${g.safe}`)) });
  const exts = [path.join(root, "profile-extensions", id, ID), path.join(root, "real-browser-profiles", id, "brave-ps-fp"),
    path.join(__dirname, "..", "vendor", "scroll-and-refresh"), vpn.writeGuard(id + "-copytest", real, page)];
  const args = [`--user-data-dir=${copyDir}`, "--profile-directory=Default", "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
    "--disable-sync", "--disable-features=Translate,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--remote-debugging-port=9481", `--load-extension=${exts.join(",")}`, page];
  let child = cp.spawn(BRAVE, args, { stdio: "ignore" });
  await sleep(6000);
  let b = await chromium.connectOverCDP("http://127.0.0.1:9481");
  await check(b.contexts()[0], "first open");
  if (process.argv.includes("--toggle")) {
    // Same call the guard makes (the guard's worker may be asleep, so from the extensions page).
    const ep = await b.contexts()[0].newPage(); await ep.goto("chrome://extensions/"); await sleep(1500);
    console.log("toggle:", await ep.evaluate(async (id) => { await chrome.management.setEnabled(id, false); await chrome.management.setEnabled(id, true); return "ok"; }, ID).catch((e) => String(e).slice(0, 100)));
    console.log("(PIA turned off and on by the guard)");
    await sleep(15000);
    const ctx = b.contexts()[0];
    const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/src/popup.html`); await sleep(5000);
    const p2 = await ctx.newPage();
    const ex = await p2.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", (e) => "fails " + String(e.message).slice(0, 60));
    console.log(`[after restart, no clicks] PIA worker: ${ctx.serviceWorkers().some((w) => w.url().includes(ID))} | popup: ${await text(pop)} | example.com: ${ex}`);
  }
  if (process.argv.includes("--reopen")) {
    if (process.argv.includes("--kill")) { child.kill(); try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {} console.log("(force-killed, like the app's Close)"); }
    else { const cdp = await b.newBrowserCDPSession(); await cdp.send("Browser.close").catch(() => {}); }
    await sleep(6000);
    child = cp.spawn(BRAVE, args, { stdio: "ignore" });
    await sleep(8000);
    b = await chromium.connectOverCDP("http://127.0.0.1:9481");
    await check(b.contexts()[0], "after reopen");
  }
  // Only this test's browser (its own pid tree), never the user's windows.
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  app.quit();
});
