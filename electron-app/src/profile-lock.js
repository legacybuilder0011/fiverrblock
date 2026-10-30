"use strict";
// One PC at a time per profile (same account logged in on several PCs).
// Opening a profile that is open elsewhere asks "Take over?": the other PC
// closes it, uploads its backup and releases, then this PC restores and opens.
// If the check can't reach the cloud (internet drop), the user chooses whether to open.
const cloud = require("./cloud-sync");

const BEAT_MS = 20000;
const WAIT_MS = 100000; // the lock goes stale after 90s if the other PC is gone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(buttons, message, detail) {
  const { dialog, BrowserWindow } = require("electron");
  const { response } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, {
    type: "question", buttons, defaultId: 0, cancelId: 1, message, detail
  });
  return response === 0;
}

// Wi-Fi blips (QUIC, DNS, network changed) are common: retry before giving up.
async function call(profileId, mode) {
  for (let i = 1; ; i++) {
    try { return await cloud.profileLock(profileId, mode); } catch (err) {
      if (i >= 4) throw err;
      await sleep(1500 * i);
    }
  }
}

// → { ok: true } or { ok: false, reason, detail }
async function claim(profile) {
  try {
    const name = profile.name || "This profile";
    let lock = await call(profile.id, "open");
    if (!lock || lock.ok) return { ok: true };
    const holder = lock.device || "another PC";
    if (!(await ask(["Take over", "Cancel"], `"${name}" is open on ${holder}.`,
      "Take over closes it there, saves its logins, and opens it here. This can take up to a minute."))) {
      return { ok: false, reason: "in-use-elsewhere", detail: `Open on ${holder}. Close it there first, or choose Take over.` };
    }
    lock = await call(profile.id, "force");
    for (const end = Date.now() + WAIT_MS; !lock.ok && Date.now() < end;) {
      await sleep(2000);
      lock = await call(profile.id, "open").catch(() => lock);
    }
    if (lock.ok) return { ok: true };
    return { ok: false, reason: "in-use-elsewhere", detail: `${holder} did not let go of the profile. Try again in a minute.` };
  } catch (err) {
    cloud.logLine(`lock ${profile.id}: ${err.message || err}`);
    const cancel = await ask(["Cancel", "Open anyway"], "Can't check if this profile is open on another PC.",
      "Your internet or the cloud is not reachable. Opening it on two PCs at once can log the account out. Check your internet and try again.");
    return cancel ? { ok: false, reason: "in-use-elsewhere", detail: "Not opened: no internet to check the other PCs." } : { ok: true };
  }
}

// While open: refresh the lock; close here when another PC takes over.
function watch(profileId, close) {
  return setInterval(async () => {
    try {
      const r = await cloud.profileLock(profileId, "beat");
      if (r && (r.takeover || r.lost)) {
        cloud.logLine(`lock ${profileId}: ${r.takeover ? "another PC chose Take over" : "another PC has this profile"}, closing here`);
        close();
      }
    } catch (_) {} // offline: keep running
  }, BEAT_MS);
}

function release(profileId) {
  cloud.profileLock(profileId, "release").catch(() => {});
}

module.exports = { claim, watch, release };
