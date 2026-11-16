"use strict";
// Reopens a real profile (its own data dir, its installed VPN extension) with the
// current VPN Guard and a debug port, then prints what the guard and the
// connection page see. Run: electron eval-logs/p55-live-check.js <profileId>
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x");
app.whenReady().then(async () => {
  const id = process.argv[process.argv.length - 1];
  const root = path.join(process.env.APPDATA, "privacy-shield");
  const dir = path.join(root, "real-browser-profiles", id, "brave");
  const pia = path.join(root, "profile-extensions", id, "jplnlifepflhkbkgonidnobkakhmpnmh");
  const fp = path.join(root, "real-browser-profiles", id, "brave-ps-fp");
  const sr = path.join(__dirname, "..", "vendor", "scroll-and-refresh");
  const real = await vpn.realIp();
  const page = await vpn.connectionPage({ extension: "Private Internet Access", realIp: real, next: [],
    onConnected: async () => ({}), onGuardState: (g) => console.log("GUARD REPORT:", mask(JSON.stringify(g))) });
  const guard = vpn.writeGuard(id + "-test", real, page);
  const exts = [fp, sr, pia, guard].filter((d) => fs.existsSync(path.join(d, "manifest.json")));
  const child = cp.spawn("C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", [`--user-data-dir=${dir}`, "--profile-directory=Default",
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--remote-debugging-port=9461", `--load-extension=${exts.join(",")}`, page], { stdio: "ignore", detached: true });
  child.unref();
  console.log("opened profile with", exts.length, "extensions; waiting 25 s for PIA to reconnect…");
  await sleep(25000);
  const b = await chromium.connectOverCDP("http://127.0.0.1:9461");
  const ctx = b.contexts()[0];
  const sws = ctx.serviceWorkers();
  const g = sws.find((w) => w.url().includes("background.js") && !w.url().includes("jplnli") && !w.url().includes("maegh"));
  const st = g ? await g.evaluate(async () => ({ proxy: await chrome.proxy.settings.get({}), state: await chrome.storage.session.get(null) })).catch((e) => String(e)) : "guard worker not found (" + sws.map((w) => w.url()).join(" ") + ")";
  console.log("GUARD SEES:", mask(JSON.stringify(st)).slice(0, 700));
  const piaSw = sws.find((w) => w.url().includes("jplnli"));
  console.log("PIA worker running:", Boolean(piaSw));
  const conn = ctx.pages().find((p) => p.url().startsWith("http://127.0.0.1"));
  console.log("CONNECTION PAGE:", conn ? mask((await conn.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")).slice(0, 500) : "(moved on)");
  const p2 = await ctx.newPage();
  console.log("example.com:", await p2.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", (e) => "blocked: " + String(e.message).split("\n")[0].slice(0, 60)));
  await p2.close();
  app.quit();
});
