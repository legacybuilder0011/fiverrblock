"use strict";
// Open on another PC: Cancel refuses, Take over waits for release, cloud errors open anyway.
const assert = require("assert/strict");
const Module = require("module");

let answer = 1;
const original = Module._load;
Module._load = function (req, ...rest) {
  if (req === "electron") return { dialog: { showMessageBox: async () => ({ response: answer }) }, BrowserWindow: { getFocusedWindow: () => null } };
  if (req === "./cloud-sync") return cloud;
  return original.call(this, req, ...rest);
};
let replies = [];
const calls = [];
const cloud = {
  logLine() {},
  async profileLock(id, mode) {
    calls.push(mode);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  }
};
const lock = require("../src/profile-lock");
const p = { id: "p1", name: "IG 1" };

(async () => {
  replies = [{ ok: true }];
  assert.deepEqual(await lock.claim(p), { ok: true });

  answer = 1;
  replies = [{ ok: false, device: "PC-A" }];
  const refused = await lock.claim(p);
  assert.equal(refused.reason, "in-use-elsewhere");
  assert.match(refused.detail, /PC-A/);

  answer = 0;
  calls.length = 0;
  replies = [{ ok: false, device: "PC-A" }, { ok: false, device: "PC-A" }, { ok: true }];
  assert.deepEqual(await lock.claim(p), { ok: true });
  assert.deepEqual(calls, ["open", "force", "open"]);

  replies = [new Error("offline")];
  assert.deepEqual(await lock.claim(p), { ok: true });

  replies = [null]; // logged out
  assert.deepEqual(await lock.claim(p), { ok: true });
  console.log("profile-lock ok");
})().catch((err) => { console.error(err); process.exit(1); });
