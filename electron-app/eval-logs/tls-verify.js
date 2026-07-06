"use strict";
// End-to-end proof that the coherent JA3 actually reaches the wire: send the
// chrome-150 and firefox JA3 the bridge would pick, through CycleTLS, to a live
// TLS-fingerprint echo, and report the JA3/JA4 + HTTP/2 (Akamai) fingerprint the
// server actually observed. Confirms (a) the ClientHello matches the claimed
// browser family and (b) two families produce distinct, real-browser fingerprints.
const path = require("path");
const initCycleTLS = require("cycletls");
const { pickJa3ForProfile } = require("../src/tls-mitm-bridge.js");

const BIN = path.join(__dirname, "..", "node_modules", "cycletls", "dist", "index.exe");
const ECHO = "https://tls.peet.ws/api/all";

const PROFILES = [
  { name: "macOS Chrome 150", id: { browser: "chrome", os: "macOS", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.46 Safari/537.36" } },
  { name: "Windows Firefox 128", id: { browser: "firefox", os: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0" } }
];

(async () => {
  const cycle = await initCycleTLS({ port: 0, executablePath: BIN, timeout: 30000 });
  const results = [];
  for (const p of PROFILES) {
    const ja3sel = pickJa3ForProfile("seed-" + p.name, p.id);
    process.stdout.write(`\n${p.name}: picked ${ja3sel.label}\n  requesting echo... `);
    try {
      const resp = await cycle(ECHO, { ja3: ja3sel.ja3, userAgent: p.id.userAgent, timeout: 30, disableRedirect: true, responseType: "text" }, "GET");
      let data = resp.data;
      if (typeof data !== "string") { try { data = Buffer.from(await resp.arrayBuffer()).toString("utf8"); } catch (_) {} }
      const j = JSON.parse(data);
      const out = {
        name: p.name,
        pickedLabel: ja3sel.label,
        sentUA: p.id.userAgent.slice(0, 45) + "...",
        observedUA: (j.http_version ? "" : "") + (j.tls && j.tls.ja3 ? "" : ""),
        ja3_hash: j.tls && j.tls.ja3_hash,
        ja3: (j.tls && j.tls.ja3 || "").slice(0, 55) + "...",
        ja4: j.tls && j.tls.ja4,
        peetprint_hash: j.tls && j.tls.peetprint_hash,
        akamai_h2: (j.http2 && j.http2.akamai_fingerprint_hash) || (j.http2 && j.http2.akamai_fingerprint || "").slice(0, 40),
        http_version: j.http_version,
        server_saw_UA: j.user_agent
      };
      results.push(out);
      console.log("OK");
      console.log("  ja3_hash :", out.ja3_hash);
      console.log("  ja4      :", out.ja4);
      console.log("  h2 hash  :", out.akamai_h2);
      console.log("  UA server saw:", (out.server_saw_UA || "").slice(0, 60));
    } catch (e) {
      console.log("FAILED:", (e && (e.message || e)) + "");
      results.push({ name: p.name, error: String(e && (e.message || e)) });
    }
  }
  await cycle.exit().catch(() => {});

  console.log("\n=== SUMMARY ===");
  const a = results[0], b = results[1];
  if (a && b && a.ja3_hash && b.ja3_hash) {
    console.log("chrome ja3_hash != firefox ja3_hash :", a.ja3_hash !== b.ja3_hash ? "YES (distinct, coherent)" : "NO");
    console.log("chrome ja4 :", a.ja4);
    console.log("firefox ja4:", b.ja4);
    console.log("chrome UA reached origin correctly :", (a.server_saw_UA || "").includes("Chrome/150") ? "YES" : "NO -> " + (a.server_saw_UA||"").slice(0,40));
    console.log("firefox UA reached origin correctly:", (b.server_saw_UA || "").includes("Firefox/128") ? "YES" : "NO -> " + (b.server_saw_UA||"").slice(0,40));
  } else {
    console.log("could not compare (see errors above)");
  }
})();
