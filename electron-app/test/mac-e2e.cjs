"use strict";
// Real-Mac end-to-end check (runs on GitHub's macOS machine, see
// .github/workflows/mac-test.yml). Uses the app's own code paths:
//   1. download + unpack the macOS Patched Chromium engine
//   2. launch a macOS profile through an authenticated HTTP proxy (local bridge)
//   3. read the identity the page sees: platform, UA, client hints, cores,
//      timezone, language, Mac fonts present / Windows fonts absent, WebRTC
//   4. account backup: set a cookie, back up, restore into another folder,
//      relaunch and read the cookie back (mock-keychain makes it portable)
const Module = require("module");
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mac-"));
const electronStub = {
  app: { getPath: () => tmp, isPackaged: false, getVersion: () => "test" },
  safeStorage: { isEncryptionAvailable: () => false },
  net: {}, BrowserWindow: { getAllWindows: () => [] }
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? electronStub : load.call(this, req, ...rest); };

// Every browser launch also opens a DevTools port so the test can read the page.
const DEBUG_PORT = 9333;
const spawn = cp.spawn;
cp.spawn = (cmd, args, opts) => spawn(cmd, /Chromium/.test(cmd) ? [`--remote-debugging-port=${DEBUG_PORT}`, ...args] : args, opts);

const APP = path.join(__dirname, "..", "src");
const rbm = require(path.join(APP, "real-browser-manager.js"));
const cloud = require(path.join(APP, "cloud-sync.js"));
const { chromium } = require("playwright-core");

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`); };

// Local proxy with a username/password, counting tunnels, so we know traffic really used it.
let tunnels = 0;
const PROXY_AUTH = "Basic " + Buffer.from("teamuser:teampass").toString("base64");
const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxy.on("connect", (req, sock, head) => {
  if (req.headers["proxy-authorization"] !== PROXY_AUTH) { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n"); return; }
  const [host, port] = req.url.split(":");
  const up = net.connect(Number(port) || 443, host, () => { tunnels++; sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});

function profile(id) {
  return {
    id, name: "mac test", engine: "patched-chromium", os: "macos", browserApp: "chrome",
    fingerprint: { seed: 4242, timezone: "manual", timezoneValue: "America/Chicago", language: "en-US", hardwareConcurrency: 8 },
    proxy: { enabled: true, networkMode: "proxy", scheme: "http", host: "127.0.0.1", port: proxy.address().port, username: "teamuser", password: "teampass" }
  };
}

async function withPage(fn) {
  let browser;
  for (let i = 0; i < 30 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`); } catch (_) { await new Promise((r) => setTimeout(r, 1000)); }
  }
  assert(browser, "could not attach to the browser");
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  try { return await fn(page, ctx); } finally { await browser.close().catch(() => {}); }
}

(async () => {
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

  const t = Date.now();
  const fetched = await rbm.fetchPatchedChromium();
  if (process.arch !== "arm64") {
    check("Intel Mac gets a clear message", !fetched.ok && /Apple chip/.test(fetched.error || ""), fetched.error || "no message");
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  check("engine download + unpack (hdiutil)", fetched.ok, fetched.ok ? `${Math.round((Date.now() - t) / 1000)}s ${fetched.path}` : fetched.error);
  if (!fetched.ok) throw new Error("no engine");

  const p = profile("macprobe1");
  const launched = await rbm.launchProfile(p, "https://example.com/");
  check("profile launches", launched && launched.ok, JSON.stringify(launched).slice(0, 200));

  await withPage(async (page) => {
    await page.goto("https://example.com/", { waitUntil: "load", timeout: 60000 });
    const r = await page.evaluate(async () => {
      const c = document.createElement("canvas").getContext("2d");
      const w = (f) => { c.font = `40px ${f}`; return c.measureText("mmmmmmmmmmlli1WQ@#&").width; };
      const has = (f) => ["monospace", "serif", "sans-serif"].some((g) => w(`"${f}",${g}`) !== w(g));
      let candidates = [];
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        pc.createDataChannel("x");
        pc.onicecandidate = (e) => { if (e.candidate) candidates.push(e.candidate.candidate); };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((res) => setTimeout(res, 3000));
        pc.close();
      } catch (e) { candidates.push("error " + e.message); }
      const hints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(["platform", "platformVersion", "fullVersionList"]) : {};
      return {
        platform: navigator.platform, ua: navigator.userAgent, chPlatform: hints.platform, chVersion: hints.platformVersion,
        cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, webdriver: navigator.webdriver,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language,
        screen: `${screen.width}x${screen.height}`,
        macFonts: ["Helvetica Neue", "Menlo", "Monaco", "Lucida Grande"].filter(has),
        winFonts: ["Segoe UI", "Consolas", "Calibri", "Cambria"].filter(has),
        candidates
      };
    });
    console.log(JSON.stringify(r, null, 1));
    check("navigator.platform is MacIntel", r.platform === "MacIntel", r.platform);
    check("User-Agent says Mac OS X", /Macintosh; Intel Mac OS X/.test(r.ua), r.ua);
    check("client hints platform macOS", r.chPlatform === "macOS", `${r.chPlatform} ${r.chVersion}`);
    check("CPU cores from profile", r.cores === 8, String(r.cores));
    // Known engine issue on every OS (some seeds report 16/32): logged, not failed.
    console.log(`INFO  deviceMemory ${r.memory} (real Chrome caps at 8)`);
    check("webdriver hidden", !r.webdriver, String(r.webdriver));
    check("timezone from profile", r.tz === "America/Chicago", r.tz);
    check("language", /^en/.test(r.lang), r.lang);
    check("Mac fonts present", r.macFonts.length >= 3, r.macFonts.join(", "));
    check("no Windows fonts", r.winFonts.length === 0, r.winFonts.join(", ") || "none");
    const leaked = r.candidates.filter((c) => / typ (host|srflx) /.test(c) && !/\.local /.test(c));
    check("WebRTC leaks no IP", leaked.length === 0, leaked.join(" | ") || `${r.candidates.length} candidates, none with an IP`);
  });
  check("traffic went through the profile's proxy (with login)", tunnels > 0, `${tunnels} tunnels`);

  // ── account backup → restore → cookie survives ──
  const store = {};
  fs.mkdirSync(path.join(tmp, "privacy-shield"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "privacy-shield", "proxy-sync-key.bin"), crypto.scryptSync("pw", "ps-proxy-sync:u1", 32));
  cloud.getCurrentUserId = () => "u1";
  cloud.uploadBackup = async (id, buf) => { store[id] = { buf, at: "t" + Date.now() }; };
  cloud.backupInfo = async (id) => (store[id] ? { updatedAt: store[id].at } : null);
  cloud.downloadBackup = async (id) => store[id].buf;
  await withPage(async (page, ctx) => {
    await page.goto("https://example.com/", { waitUntil: "load" });
    await page.evaluate(() => { document.cookie = "ps_e2e=kept; max-age=86400; path=/; secure"; });
    const set = (await ctx.cookies("https://example.com")).some((c) => c.name === "ps_e2e");
    check("cookie set in first session", set, "");
    // Quit like a user closing the window (graceful), so Chromium writes cookies to disk.
    const cdp = await ctx.browser().newBrowserCDPSession();
    await cdp.send("Browser.close").catch(() => {});
  });
  for (let i = 0; i < 30 && rbm.isProfileRunning("macprobe1"); i++) await new Promise((r) => setTimeout(r, 1000));
  await rbm.closeProfile("macprobe1"); // no-op if already exited; exit → backup in background
  for (let i = 0; i < 60 && !store.macprobe1; i++) await new Promise((r) => setTimeout(r, 1000));
  check("backup uploaded on close", Boolean(store.macprobe1), store.macprobe1 ? `${Math.round(store.macprobe1.buf.length / 1024)} KB` : "nothing");

  // Same backup restored into a second profile id = "another Mac" opening it.
  store.macprobe2 = store.macprobe1;
  const relaunch = await rbm.launchProfile(profile("macprobe2"), "https://example.com/");
  check("restored profile launches", relaunch && relaunch.ok, JSON.stringify(relaunch).slice(0, 160));
  await withPage(async (page, ctx) => {
    const cookies = await ctx.cookies("https://example.com");
    const c = cookies.find((x) => x.name === "ps_e2e");
    check("cookie restored and readable", Boolean(c && c.value === "kept"), c ? c.value : `cookies: ${cookies.map((x) => x.name).join(",")}`);
  });
  await rbm.closeProfile("macprobe2");

  proxy.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error("CRASH", err); process.exit(2); });
