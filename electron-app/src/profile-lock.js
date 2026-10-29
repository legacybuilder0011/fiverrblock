"use strict";
// One PC at a time per profile (same account logged in on several PCs).
// Opening a profile that is open elsewhere asks "Take over?": the other PC
// closes it, uploads its backup and releases, then this PC restores and opens.
// Any cloud error lets the profile open, so a Supabase outage never blocks work.
const cloud = require("./cloud-sync");

const BEAT_MS = 20000;
const WAIT_MS = 100000; // the lock goes stale after 90s if the other PC is gone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(name, holder) {
  const { dialog, BrowserWindow } = require("electron");
  const { response } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, {
    type: "question",
    buttons: ["Take over", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `"${name}" is open on ${holder || "another PC"}.`,
    detail: "Take over closes it there, saves its logins, and opens it here. This can take up to a minute."
  });
  return response === 0;
}

// → { ok: true } or { ok: false, reason, detail }
async function claim(profile) {
  try {
    let lock = await cloud.profileLock(profile.id, "open");
    if (!lock || lock.ok) return { ok: true };
    const holder = lock.device;
    if (!(await ask(profile.name || "This profile", holder))) {
      return { ok: false, reason: "in-use-elsewhere", detail: `Open on ${holder}. Close it there first, or choose Take over.` };
    }
    lock = await cloud.profileLock(profile.id, "force");
    for (const end = Date.now() + WAIT_MS; !lock.ok && Date.now() < end;) {
      await sleep(3000);
      lock = await cloud.profileLock(profile.id, "open");
    }
    if (lock.ok) return { ok: true };
    return { ok: false, reason: "in-use-elsewhere", detail: `${holder} did not let go of the profile. Try again in a minute.` };
  } catch (err) {
    cloud.logLine(`lock ${profile.id}: ${err.message || err} — opening anyway`);
    return { ok: true };
  }
}

// While open: refresh the lock; close here when another PC takes over.
function watch(profileId, close) {
  return setInterval(async () => {
    try {
      const r = await cloud.profileLock(profileId, "beat");
      if (r && (r.takeover || r.lost)) {
        cloud.logLine(`lock ${profileId}: taken over by another PC, closing here`);
        close();
      }
    } catch (_) {} // offline: keep running
  }, BEAT_MS);
}

function release(profileId) {
  cloud.profileLock(profileId, "release").catch(() => {});
}

module.exports = { claim, watch, release };
