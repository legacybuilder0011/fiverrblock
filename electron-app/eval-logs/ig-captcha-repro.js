"use strict";
// Reproduce the Instagram "confirm it's you" blank-captcha bug by injecting the
// app's EXACT fingerprint spoof payload (same transform cdp-stealth.js uses) into
// every frame via Playwright, then driving the email-signup flow and capturing:
//   - every frame URL (to learn the real challenge-frame origin)
//   - every console message + pageerror (to catch a thrown/aborted spoof)
//   - screenshots at each step
// Run: node eval-logs/ig-captcha-repro.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const OUT = path.join(__dirname, "ig-repro-out");
fs.mkdirSync(OUT, { recursive: true });
const logLines = [];
function L(...a) { const s = a.join(" "); logLines.push(s); console.log(s); }
function flush() { fs.writeFileSync(path.join(OUT, "log.txt"), logLines.join("\n")); }

// Profile-5-like config (macOS, Chrome 150, 1512x982@1.5, America/New_York, Apple M1)
const config = {
  enabled: true, spoofGeo: true,
  geo: { latitude: 40.7128, longitude: -74.006, accuracy: 50 },
  spoofTimezone: true, timezone: "America/New_York", localeOffsetMinutes: 300,
  blockWebGL: true, blockCanvas: true, blockAudio: true, blockBattery: true,
  blockPlugins: true, blockFonts: true, blockScreen: true, blockHardware: true,
  spoofUA: true,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.46 Safari/537.36",
  platform: "MacIntel", language: "en-US", languages: ["en-US", "en"],
  hardwareConcurrency: 8, deviceMemory: 8,
  screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 944, colorDepth: 24, pixelDepth: 24 },
  webglVendor: "Google Inc. (Apple)",
  webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
  fingerprintSeed: 987654321,
  _profileId: "mr97g7k2hyrets", _profileName: "New Profile 5",
  _browserApp: "chrome", _uaOS: "macOS", _deviceClass: "desktop"
};

function buildPayload(cfg) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "preload-fingerprint.js"), "utf8");
  const cfgJson = JSON.stringify(cfg || {});
  return src.replace(
    /const\s*\{\s*ipcRenderer\s*\}\s*=\s*require\(["']electron["']\)\s*;?/,
    `const ipcRenderer = { sendSync: function () { return ${cfgJson}; } };`
  );
}

const rnd = Math.floor(1e8 + (Date.now() % 8e8));
const EMAIL = `psqa${rnd}@mailinator.com`;
const NAME = "Jordan Miles";
const USER = `jm_${rnd}`;
const PASS = `Px${rnd}!qZ`;

(async () => {
  const payload = buildPayload(config);
  fs.writeFileSync(path.join(OUT, "payload.js"), payload);
  L("payload bytes:", payload.length);

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1512, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York"
  });
  // Inject the spoof into EVERY frame at document_start (mirrors CDP addScriptToEvaluateOnNewDocument)
  await context.addInitScript(payload);

  const page = await context.newPage();

  const seenFrames = new Set();
  page.on("frameattached", (f) => { const u = f.url() || "(about:blank)"; if (!seenFrames.has(u)) { seenFrames.add(u); L("FRAME attached:", u); } });
  page.on("framenavigated", (f) => { const u = f.url(); if (u && !seenFrames.has(u)) { seenFrames.add(u); L("FRAME nav:", u); } });
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning" || /captcha|arkose|funcaptcha|hcaptcha|uncaught|denied|refused|error/i.test(m.text())) {
      L(`CONSOLE[${t}] ${m.location().url || ""} :: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => L("PAGEERROR:", e && (e.stack || e.message || String(e))));
  page.on("requestfailed", (r) => { const u = r.url(); if (/captcha|arkose|funcaptcha|hcaptcha|fbsbx|challenge/i.test(u)) L("REQFAIL:", u, r.failure() && r.failure().errorText); });

  async function shot(name) { try { await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false }); L("shot:", name); } catch (e) { L("shot fail", name, e.message); } }

  try {
    L("goto signup...");
    await page.goto("https://www.instagram.com/accounts/emailsignup/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    await shot("01-signup");

    // Cookie banner (best-effort)
    for (const t of ["Allow all cookies", "Accept All", "Only allow essential cookies", "Decline optional cookies"]) {
      try { const b = page.getByRole("button", { name: t }); if (await b.count()) { await b.first().click({ timeout: 2000 }); L("cookie:", t); break; } } catch (_) {}
    }
    await page.waitForTimeout(1500);

    async function fill(sel, val) { try { const el = page.locator(sel).first(); await el.waitFor({ timeout: 8000 }); await el.click(); await el.fill(val); L("filled", sel); return true; } catch (e) { L("fill FAIL", sel, e.message); return false; } }
    await fill('input[name="emailOrPhone"]', EMAIL);
    await fill('input[name="fullName"]', NAME);
    await fill('input[name="username"]', USER);
    await fill('input[name="password"]', PASS);
    await shot("02-filled");

    // Submit
    try {
      const btn = page.locator('button[type="submit"]').first();
      await btn.click({ timeout: 8000 });
      L("clicked signup");
    } catch (e) { L("submit click fail", e.message); }
    await page.waitForTimeout(6000);
    await shot("03-after-submit");

    // Birthday step (selects), then Next
    try {
      const selects = page.locator("select");
      if (await selects.count() >= 3) {
        await selects.nth(0).selectOption({ index: 4 });
        await selects.nth(1).selectOption({ index: 4 });
        await selects.nth(2).selectOption({ index: 20 });
        L("birthday set");
        const next = page.getByRole("button", { name: /Next/i });
        if (await next.count()) { await next.first().click({ timeout: 5000 }); L("clicked Next (birthday)"); }
      }
    } catch (e) { L("birthday step:", e.message); }
    await page.waitForTimeout(8000);
    await shot("04-challenge");

    // Dump full frame tree + any iframe that looks like a challenge, with box size
    L("=== FINAL FRAME TREE ===");
    for (const f of page.frames()) L("frame:", f.url());
    const iframeInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("iframe")).map((f) => {
        const r = f.getBoundingClientRect();
        return { src: f.src || f.getAttribute("data-src") || "(none)", w: Math.round(r.width), h: Math.round(r.height), title: f.title || "" };
      });
    }).catch((e) => "eval fail: " + e.message);
    L("IFRAMES:", JSON.stringify(iframeInfo, null, 2));

    // Body text of challenge, to confirm it's the "confirm it's you" modal
    const bodyText = await page.evaluate(() => (document.body.innerText || "").slice(0, 400)).catch(() => "");
    L("PAGE TEXT SNIPPET:", JSON.stringify(bodyText));

    await page.waitForTimeout(3000);
    await shot("05-final");
  } catch (e) {
    L("FLOW ERROR:", e && (e.stack || e.message));
    await shot("99-error");
  } finally {
    flush();
    L("done. leaving browser open 20s for manual inspection...");
    await page.waitForTimeout(20000).catch(() => {});
    await browser.close().catch(() => {});
    flush();
  }
})();
