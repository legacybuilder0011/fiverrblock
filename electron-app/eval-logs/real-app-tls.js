"use strict";
// Measure what the REAL running app (Electron 43 / Chromium 150) actually sends on
// the wire for a normal VPN/direct profile WITHOUT the tlsSpoof bridge. Drives the
// live profile tab to a TLS-fingerprint echo and reports the JA3/JA4/HTTP2 the
// server observed + its browser guess. Answers: does the handshake look like
// Chrome, or like Electron/Node?
const { chromium } = require("playwright-core");
function L(...a){console.log(a.join(" "));}

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let page = null;
  for (const c of b.contexts()) for (const p of c.pages()) { let u=""; try{u=p.url();}catch(_){}
    if (u.startsWith("http")) { page = p; break; } }
  if (!page) { L("no browsing tab — open Profile 5"); await b.close(); return; }

  L("driving real profile tab to tls.peet.ws/api/all ...");
  await page.goto("https://tls.peet.ws/api/all", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e=>L("nav:",e.message));
  await page.waitForTimeout(2500);
  const txt = await page.evaluate(() => document.body.innerText).catch(()=> "");
  let j; try { j = JSON.parse(txt); } catch(e){ L("could not parse echo:", txt.slice(0,200)); await b.close(); return; }

  const tls = j.tls || {};
  const h2 = j.http2 || {};
  L("\n=== WHAT THE SERVER ACTUALLY SAW (your real app) ===");
  L("UA sent          :", (j.user_agent||"").slice(0,80));
  L("HTTP version     :", j.http_version);
  L("JA3 hash         :", tls.ja3_hash);
  L("JA3              :", (tls.ja3||"").slice(0,70)+"...");
  L("JA4              :", tls.ja4);
  L("PeetPrint hash   :", tls.peetprint_hash);
  L("Akamai H2 hash   :", h2.akamai_fingerprint_hash || (h2.akamai_fingerprint||"").slice(0,50));
  L("Cipher list len  :", (tls.ciphers||[]).length);
  // tls.peet.ws exposes a heuristic client guess in ja4 / user_agent cross-check via the "ja4" DB elsewhere;
  // print the negotiated details so we can eyeball Chrome-ness.
  L("Peetprint        :", (tls.peetprint||"").slice(0,80));
  await b.close();
})();
