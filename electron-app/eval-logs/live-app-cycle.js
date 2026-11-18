"use strict";
// The live profile, launched like the fixed app does (writeGuard from current code,
// the app's saved arguments), force-closed like the app's Close, N times.
const { app } = require("electron");
const cp = require("child_process"), fs = require("fs"), path = require("path");
const vpn = require(path.join(__dirname, "..", "src", "browser-vpn"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.x.x");
const ID = "jplnlifepflhkbkgonidnobkakhmpnmh";
// Write the guard where the real app does (its folder decides the guard extension ID).
app.setPath("userData", path.join(process.env.APPDATA, "privacy-shield"));
app.whenReady().then(async () => {
  const [cmdFile, profileId, rounds = "2"] = process.argv.slice(-3);
  const line = fs.readFileSync(cmdFile, "utf8").replace(/^﻿/, "").trim();
  const args = line.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ""));
  const exe = args.shift(); args.pop(); // drop the old connection page URL
  const real = await vpn.realIp();
  for (let round = 1; round <= Number(rounds); round++) {
    const states = [];
    const page = await vpn.connectionPage({ extension: "Private Internet Access", realIp: real, next: [], onConnected: async () => ({}),
      onGuardState: (g) => states.push(g), onGuardMissing: (w) => states.push({ missing: w }) });
    const guard = vpn.writeGuard(profileId, real, page);
    const version = JSON.parse(fs.readFileSync(path.join(guard, "manifest.json"), "utf8")).version;
    const a = args.map((x) => x.startsWith("--load-extension=") ? x : x);
    const child = cp.spawn(exe, [...a, "--remote-debugging-port=9555", page], { stdio: "ignore" });
    await sleep(35000);
    const b = await chromium.connectOverCDP("http://127.0.0.1:9555"); const ctx = b.contexts()[0];
    const conn = ctx.pages().find((p) => p.url().startsWith(page));
    const pageText = conn ? mask((await conn.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")).slice(0, 160) : "(moved on)";
    if (process.env.DEBUG_GUARD) {
      const gw = ctx.serviceWorkers().find((w) => /vpn|background\.js$/.test(w.url()) && !w.url().includes(ID) && !w.url().includes("maegh"));
      console.log("  workers:", ctx.serviceWorkers().map((w) => w.url().split("/")[2].slice(0, 8)).join(","));
      if (gw) console.log("  guard:", mask(JSON.stringify(await gw.evaluate(async () => { const cfg = await (await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" })).json();
        let post; try { post = (await fetch(cfg.statusUrl + "guard-state", { method: "POST", body: "{}" })).status; } catch (e) { post = "ERR " + e.message; }
        return { v: chrome.runtime.getManifest().version, cfg, post, session: await chrome.storage.session.get(null) }; }).catch((e) => String(e)))));
      console.log("  harness page:", page);
    }
    const p2 = await ctx.newPage();
    const site = await p2.goto("https://www.fiverr.com/", { timeout: 25000 }).then((r) => "LOADS " + (r && r.status()), () => "blocked");
    const ip = mask(await p2.evaluate(async () => { try { return (await (await fetch("https://api.ipify.org/?format=json")).json()).ip; } catch (e) { return "-"; } }).catch(() => "-"));
    await p2.close();
    const last = states.filter((g) => g.at).pop() || {};
    console.log(`round ${round}: guard v${version} reported ${states.length}x, last safe=${last.safe} | page: ${pageText.slice(0, 90)} | fiverr: ${site} | IP: ${ip}${states.some((g) => g.missing) ? " | GUARD MISSING" : ""}`);
    // Close like the app's Close button (force).
    try { child.kill(); cp.execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
    await sleep(4000);
  }
  app.quit();
});
