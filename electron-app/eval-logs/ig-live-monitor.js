"use strict";
// Connect to the RUNNING Privacy Shield app over CDP (app must be launched with
// --remote-debugging-port=9222), find the Profile 5 browsing tab, open the
// Instagram signup in it, and log every frame URL / console error / pageerror /
// failed request while the USER fills the form and clicks Submit. This observes
// the REAL profile (real spoof, real WebContentsView) — not standalone Chrome.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const OUT = path.join(__dirname, "ig-repro-out");
fs.mkdirSync(OUT, { recursive: true });
const LOGF = path.join(OUT, "live-log.txt");
const lines = [];
function ts() { return new Date().toISOString().slice(11, 23); }
function L(...a) { const s = ts() + " " + a.join(" "); lines.push(s); console.log(s); try { fs.writeFileSync(LOGF, lines.join("\n")); } catch (_) {} }

const SIGNUP = "https://www.instagram.com/accounts/emailsignup/";
const attached = new Set();
const navigated = new Set();

function isBrowsingTab(url) {
  if (!url) return false;
  if (url.startsWith("psapp://")) return false;        // app chrome (tab-strip / profiles manager)
  if (url.startsWith("devtools://")) return false;
  if (url.startsWith("http://") || url.startsWith("https://")) return true;
  if (url.includes("browser-start.html")) return true; // fresh tab
  if (url === "about:blank") return true;
  return false;
}

function attachToPage(page) {
  let key;
  try { key = page._guid || page.url() + "#" + Math.random(); } catch (_) { key = String(Math.random()); }
  if (attached.has(page)) return;
  attached.add(page);
  L("PAGE seen:", (() => { try { return page.url(); } catch (_) { return "?"; } })());

  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error" || t === "warning" || /captcha|arkose|funcaptcha|hcaptcha|challenge|uncaught|denied|refused|blocked|csp|redefine|not a function|undefined is not/i.test(txt)) {
      let loc = ""; try { loc = (m.location() && m.location().url) || ""; } catch (_) {}
      L(`CONSOLE[${t}] ${loc} :: ${txt.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => L("PAGEERROR:", (e && (e.stack || e.message)) ? String(e.stack || e.message).slice(0, 400) : String(e)));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/captcha|arkose|funcaptcha|hcaptcha|fbsbx|challenge|two_factor|risk|akamai|perimeterx|datadome|geetest|recaptcha/i.test(u)) {
      L("REQFAIL:", u.slice(0, 160), "::", r.failure() && r.failure().errorText);
    }
  });
  page.on("frameattached", (f) => { try { L("FRAME+", f.url() || "(blank)"); } catch (_) {} });
  page.on("framenavigated", (f) => { try { const u = f.url(); if (u && u !== "about:blank") L("FRAMEnav", u); } catch (_) {} });
}

async function dumpChallenge(page) {
  try {
    const info = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll("iframe")).map((f) => {
        const r = f.getBoundingClientRect();
        return { src: f.src || f.getAttribute("data-src") || f.getAttribute("title") || "(no-src)", w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 };
      });
      const txt = (document.body && document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300);
      const hasConfirm = /confirm it'?s you|help us confirm|security|not a robot|puzzle/i.test(txt);
      return { frames, txt, hasConfirm };
    });
    return info;
  } catch (e) { return { err: e.message }; }
}

(async () => {
  let browser = null;
  for (let i = 0; i < 20; i++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9222"); break; }
    catch (e) { L("connect retry", i, e.message.slice(0, 80)); await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!browser) { L("COULD NOT CONNECT to CDP 9222 — is the app launched with --remote-debugging-port=9222 ?"); return; }
  L("connected to app over CDP");

  browser.on("disconnected", () => L("CDP disconnected"));
  for (const ctx of browser.contexts()) {
    ctx.on("page", (p) => attachToPage(p));
  }

  let lastConfirmState = "";
  const started = Date.now();
  const RUN_MS = 6 * 60 * 1000; // watch for 6 minutes

  while (Date.now() - started < RUN_MS) {
    for (const ctx of browser.contexts()) {
      let pages = [];
      try { pages = ctx.pages(); } catch (_) {}
      for (const page of pages) {
        attachToPage(page);
        let url = ""; try { url = page.url(); } catch (_) {}
        // Open the signup in the first real browsing tab, once.
        if (isBrowsingTab(url) && !navigated.has(page) && !url.includes("instagram.com")) {
          navigated.add(page);
          L("navigating profile tab to IG signup:", url, "->", SIGNUP);
          try { await page.goto(SIGNUP, { waitUntil: "domcontentloaded", timeout: 45000 }); L("signup opened — FILL THE FORM NOW and click Submit"); }
          catch (e) { L("nav fail:", e.message.slice(0, 120)); }
        }
        // Continuously report challenge state on instagram tabs.
        if (url.includes("instagram.com")) {
          const info = await dumpChallenge(page);
          const sig = JSON.stringify(info && info.frames) + "|" + (info && info.hasConfirm);
          if (sig !== lastConfirmState) {
            lastConfirmState = sig;
            L("IG STATE:", JSON.stringify(info));
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  L("monitor window ended.");
  try { await browser.close(); } catch (_) {}
})();
