"use strict";
// Headless verification of the scalability fixes. Run:
//   node_modules/electron/dist/electron.exe eval-logs/scalability-verify.js --
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate to a throwaway userData dir so we never touch real profiles.
const tmpUser = path.join(os.tmpdir(), "ps-scale-verify-" + process.pid);
app.setPath("userData", tmpUser);

app.whenReady().then(() => {
  const store = require("../src/profile-store");

  // Count physical file replacements (renameSync = one atomic commit per write).
  let renameCount = 0;
  const realRename = fs.renameSync;
  fs.renameSync = function (...a) { renameCount++; return realRename.apply(fs, a); };

  const results = [];
  const assert = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); };

  // ── Test 1: batch create = ONE write for N profiles ──────────────────────────
  const N = 25;
  const list = Array.from({ length: N }, (_, i) => ({ name: "Batch " + (i + 1), os: "windows" }));
  renameCount = 0;
  const created = store.createProfilesBatch(list);
  assert("batch creates all N", created.length === N, `created=${created.length}`);
  assert("batch does ONE disk write for N profiles", renameCount === 1, `writes=${renameCount} (loop-createProfile would be ${N})`);
  assert("batch ids are unique", new Set(created.map((p) => p.id)).size === N, "");

  // ── Test 2: profiles persisted + file is valid JSON ──────────────────────────
  const all = store.getProfiles();
  assert("all N persisted + readable", all.length >= N, `count=${all.length}`);

  // ── Test 3: atomic write leaves a .bak recovery copy ─────────────────────────
  const dataDir = path.dirname(all.length ? store.getProfiles.__file || "" : "");
  // Find the profiles.json we just wrote under the temp userData tree.
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "profiles.json") found.push(full);
    }
  })(tmpUser);
  const pf = found[0];
  assert("profiles.json exists", !!pf, pf || "none");
  if (pf) {
    // second write should create .bak from the first
    store.createProfile({ name: "trigger-bak", os: "windows" });
    assert(".bak recovery copy created on rewrite", fs.existsSync(pf + ".bak"), pf + ".bak");
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(pf, "utf8")); } catch (_) {}
    assert("live file is valid JSON after writes", Array.isArray(parsed), typeof parsed);
    assert("no leftover .tmp file", !fs.existsSync(pf + ".tmp"), "");
  }

  // ── Report ───────────────────────────────────────────────────────────────────
  console.log("\n=== SCALABILITY FIX VERIFICATION ===");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
    if (r.ok) pass++;
  }
  console.log(`\n${pass}/${results.length} checks passed`);

  try { fs.rmSync(tmpUser, { recursive: true, force: true }); } catch (_) {}
  app.exit(pass === results.length ? 0 : 1);
});
