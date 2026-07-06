"use strict";
// Verify the psapp:// path-traversal fix. Run:
//   node_modules/electron/dist/electron.exe eval-logs/security-verify.js --
const { app } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
  const { ensureAppProtocol } = require("../src/app-protocol");
  // Reach the internal handler by registering against a fake protocol object
  // that just captures the handler function.
  let handler = null;
  const fakeProtocol = {
    handle: (_scheme, fn) => { handler = fn; },
    isProtocolHandled: async () => false
  };
  await ensureAppProtocol(fakeProtocol, () => {}, () => {});

  const appRoot = path.resolve(app.getAppPath());
  const results = [];
  const expect = async (name, url, expectStatus) => {
    const res = await handler({ url });
    results.push({ name, ok: res.status === expectStatus, got: res.status, want: expectStatus });
  };
  // Security property: a traversal attempt must NEVER return 200 (i.e. never
  // serve out-of-root content). 403 (blocked) or 404 (parser-collapsed, absent)
  // are both safe outcomes.
  const expectNot200 = async (name, url) => {
    const res = await handler({ url });
    results.push({ name, ok: res.status !== 200, got: res.status, want: "not 200" });
  };

  // Legit file that actually exists in the resolved app root → 200
  await expect("serves legit in-root file", "psapp://app/security-verify.js", 200);
  // Encoded traversal (decoded AFTER url parse) → must be 403
  await expect("blocks encoded ..%2f traversal", "psapp://app/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret", 403);
  await expect("blocks encoded traversal to user data", "psapp://app/..%2f..%2fprivacy-shield%2fsession.json", 403);
  // Non-encoded traversal is collapsed by the URL parser → never serves outside content
  await expectNot200("non-encoded ../ never serves outside file", "psapp://app/../../../../../../Windows/win.ini");
  // Missing in-root file → 404 (absent, not a security failure)
  await expect("missing in-root file is 404", "psapp://app/does-not-exist-xyz.html", 404);

  console.log("\n=== SECURITY FIX VERIFICATION (psapp traversal) ===");
  console.log("appRoot:", appRoot);
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  [got ${r.got}, want ${r.want}]`);
    if (r.ok) pass++;
  }
  console.log(`\n${pass}/${results.length} checks passed`);
  app.exit(pass === results.length ? 0 : 1);
});
