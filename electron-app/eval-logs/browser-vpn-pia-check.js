"use strict";
// Real PIA "Proxy for Chrome" + VPN Guard on the patched engine: log in, connect,
// then print what the guard sees. Credentials come from PIA_USER / PIA_PASS env
// vars only (never written anywhere).
// Run: PIA_USER=.. PIA_PASS=.. electron eval-logs/browser-vpn-pia-check.js <pia-extension-dir>
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), os = require("os"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const rb = require(path.join(__dirname, "..", "src", "real-browser-manager"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x");
app.whenReady().then(async () => {
  const src = process.argv.find((a) => a.includes("jplnlifepflhkbkgonidnobkakhmpnmh"));
  const pia = fs.mkdtempSync(path.join(os.tmpdir(), "pia-"));
  fs.cpSync(src, pia, { recursive: true });
  const real = await vpn.realIp();
  const page = await vpn.connectionPage({ extension: "PIA", realIp: real, next: [], onConnected: async () => ({ country: "?" }) });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "piau-"));
  const exe = process.argv.includes("brave") ? "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" : rb.patchedChromiumBinary();
  const child = cp.spawn(exe, [`--user-data-dir=${udd}`, "--no-first-run", "--remote-debugging-port=9451",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${vpn.writeGuard("pia-test", real, page)},${pia}`, "--fingerprint=7", page], { stdio: "ignore" });
  await sleep(4000);
  const b = await chromium.connectOverCDP("http://127.0.0.1:9451");
  const ctx = b.contexts()[0];
  const popup = await ctx.newPage();
  await popup.goto("chrome-extension://jplnlifepflhkbkgonidnobkakhmpnmh/src/popup.html");
  await sleep(2500);
  // Walk PIA's first-run screens, log in, connect.
  for (let step = 0; step < 8; step++) {
    const t = (await popup.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    console.log("screen", step, ":", mask(t).slice(0, 110));
    if (/CONNECTED/.test(t) && !/DISCONNECTED/i.test(t)) break;
    const pw = popup.locator("input[type=password]");
    if (await pw.count()) {
      await popup.locator("input").first().fill(process.env.PIA_USER);
      await pw.first().fill(process.env.PIA_PASS);
      await popup.getByText(/^\s*log ?in\s*$/i).last().click().catch(() => {});
      await sleep(5000); continue;
    }
    const btn = popup.getByText(/^(get started|skip|next|accept|agree|done|ok|got it|continue)$/i).first();
    if (await btn.count()) { await btn.click().catch(() => {}); await sleep(1500); continue; }
    // Main screen: the power button toggles the connection.
    const power = popup.locator(".power-button").first();
    await power.click().catch(() => {}); await sleep(6000);
  }
  console.log("CLICKABLES:", JSON.stringify(await popup.evaluate(() => [...document.querySelectorAll("button, [role=button], a, div[class], svg")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 60; })
    .slice(0, 25).map((e) => e.tagName + "." + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).slice(0, 60) + " " + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height)))));
  console.log("popup now:", mask((await popup.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)));
  await sleep(6000);
  const guard = ctx.serviceWorkers().find((w) => w.url().includes("background.js") && !w.url().includes("jplnli"));
  const g = guard ? await guard.evaluate(async () => {
    const out = { proxy: await chrome.proxy.settings.get({}), state: await chrome.storage.session.get(null), cfg: await (await fetch(chrome.runtime.getURL("config.json"))).json() };
    for (const u of ["https://api.ipify.org/?format=json", "https://icanhazip.com", "https://www.cloudflare.com/cdn-cgi/trace"]) {
      try { const r = await fetch(u, { cache: "no-store" }); out[u] = r.status + " " + (await r.text()).slice(0, 80).replace(/\s+/g, " "); } catch (e) { out[u] = "ERR " + e.message; }
    }
    return out;
  }).catch((e) => "guard eval error " + e) : "guard not found";
  const out = typeof g === "string" ? g : JSON.stringify({ ...g, proxy: { levelOfControl: g.proxy.levelOfControl, mode: g.proxy.value && g.proxy.value.mode } }, null, 1);
  console.log("GUARD:", mask(out).slice(0, 1500));
  const conn = ctx.pages().find((p) => p.url().startsWith("http://127.0.0.1"));
  console.log("CONNECTION PAGE:", conn ? mask((await conn.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")).slice(0, 400) : "(moved on)");
  const p2 = await ctx.newPage();
  console.log("example.com:", await p2.goto("https://example.com/", { timeout: 15000 }).then(() => "loads", (e) => "blocked: " + String(e.message).split("\n")[0].slice(0, 60)));
  console.log("page fetch ipify:", mask(await p2.evaluate(async () => { try { return (await (await fetch("https://api.ipify.org/?format=json")).text()); } catch (e) { return "ERR " + e.message; } }).catch((e) => String(e))));
  try { cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
  app.quit();
});
