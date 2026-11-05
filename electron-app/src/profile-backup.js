"use strict";
// Browser data (logins, saved passwords, history) follows the account to any PC.
//
// Chromium encrypts cookies + saved passwords with ONE AES key kept in
// "Local State", and only that key is locked to this Windows user (DPAPI). So on
// close we unlock the key, pack the profile folder (minus caches) together with
// it, encrypt everything with the account key (cloud-sync sealBuffer) and upload
// to Supabase Storage. On open, if the cloud copy is newer than what this PC last
// uploaded/restored, it is downloaded and the key is re-locked to THIS Windows
// user, so Chromium opens with the same logins.
//
// Real Google Chrome is skipped: it adds app-bound encryption tied to the PC.
// One PC at a time is enforced by profile-lock.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");
const cloud = require("./cloud-sync");
const tar = require("./tar-pack");

const MAX_RAW = 300 * 1048576;
// Supabase free plan allows 50 MB per file, so bigger backups go up in parts.
const PART_SIZE = 45 * 1048576;
const PARTS_MAGIC = Buffer.from("PSPARTS1");
// "File busy" (browser still exiting) and dropped connections were most failures.
const RETRY_WAITS = [3000, 10000, 30000, 60000];
const SKIP_IN_DEFAULT = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "JumpListIconsMostVisited", "JumpListIconsRecentClosed", "Service Worker/CacheStorage", "Service Worker/ScriptCache"]);

const pending = new Map(); // profileId -> promise of the running backup

// macOS: only Patched Chromium (runs with --use-mock-keychain, so its cookie key
// is the same on every Mac). Brave/Chrome there lock cookies to the Mac Keychain.
const IS_WIN = process.platform === "win32";
function supported(dir) {
  const engine = path.basename(dir);
  return IS_WIN ? engine !== "chrome" : engine === "patched";
}
function stampFile(dir) { return dir + ".backup.json"; }
function readStampFull(dir) { try { return JSON.parse(fs.readFileSync(stampFile(dir), "utf8")) || {}; } catch (_) { return {}; } }
function readStamp(dir) { return readStampFull(dir).remoteAt || ""; }
function writeStamp(dir, remoteAt) { try { fs.writeFileSync(stampFile(dir), JSON.stringify({ remoteAt }) + "\n"); } catch (_) {} }
// Set before every upload and cleared by writeStamp on success, so an upload cut
// off by a failure, a crash or a power cut is retried later (retryPending).
function markPending(dir) {
  try { fs.writeFileSync(stampFile(dir), JSON.stringify({ remoteAt: readStamp(dir), pending: cloud.getCurrentUserId() }) + "\n"); } catch (_) {}
}

async function uploadSealed(profileId, sealed) {
  if (sealed.length <= PART_SIZE) return cloud.uploadBackup(profileId, sealed);
  const parts = Math.ceil(sealed.length / PART_SIZE);
  for (let i = 0; i < parts; i++) await cloud.uploadBackup(profileId, sealed.subarray(i * PART_SIZE, (i + 1) * PART_SIZE), `.part${i + 1}`);
  const sha = crypto.createHash("sha256").update(sealed).digest("hex");
  // The index goes up last, so the cloud copy only switches once every part is there.
  await cloud.uploadBackup(profileId, Buffer.concat([PARTS_MAGIC, Buffer.from(JSON.stringify({ parts, sha }))]));
}

async function downloadSealed(profileId) {
  const head = await cloud.downloadBackup(profileId);
  if (!head.subarray(0, PARTS_MAGIC.length).equals(PARTS_MAGIC)) return head;
  const index = JSON.parse(head.subarray(PARTS_MAGIC.length).toString("utf8"));
  const parts = [];
  for (let i = 1; i <= index.parts; i++) parts.push(await cloud.downloadBackup(profileId, `.part${i}`));
  const sealed = Buffer.concat(parts);
  if (crypto.createHash("sha256").update(sealed).digest("hex") !== index.sha) throw new Error("backup parts do not match");
  return sealed;
}

// Keep "<top>/Local State", "<top>/First Run" and "<top>/Default" minus caches.
function skip(rel) {
  const parts = rel.split("/");
  if (parts.length < 2) return false;
  if (parts.length === 2) return !["Local State", "First Run", "Default"].includes(parts[1]);
  const inDefault = parts.slice(2).join("/");
  return SKIP_IN_DEFAULT.has(inDefault);
}

function dpapi(op, b64) {
  const script = "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String(" +
    `[Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($env:PS_DPAPI_IN), $null, 'CurrentUser'))`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, PS_DPAPI_IN: b64 }, windowsHide: true, encoding: "utf8" },
      (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

function readLocalState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8")); } catch (_) { return null; }
}

// Raw AES key (base64) that encrypts this profile's cookies + passwords.
async function unlockKey(dir) {
  if (!IS_WIN) return "";
  const enc = readLocalState(dir)?.os_crypt?.encrypted_key;
  if (!enc) return "";
  const blob = Buffer.from(enc, "base64");
  if (blob.subarray(0, 5).toString() !== "DPAPI") return "";
  return dpapi("Unprotect", blob.subarray(5).toString("base64"));
}

async function lockKey(dir, keyB64) {
  const state = readLocalState(dir);
  if (!state || !keyB64 || !IS_WIN) return;
  const locked = Buffer.from(await dpapi("Protect", keyB64), "base64");
  state.os_crypt = { ...(state.os_crypt || {}), encrypted_key: Buffer.concat([Buffer.from("DPAPI"), locked]).toString("base64") };
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify(state));
}

// payload = gzip( u32 manifestLen | manifest JSON | tar ), then sealed.
async function backup(profileId, dir) {
  if (!supported(dir) || !cloud.getCurrentUserId() || !fs.existsSync(path.join(dir, "Default"))) return;
  const manifest = Buffer.from(JSON.stringify({ v: 1, platform: process.platform, key: await unlockKey(dir) }), "utf8");
  const len = Buffer.alloc(4); len.writeUInt32BE(manifest.length);
  const sealed = cloud.sealBuffer(zlib.gzipSync(Buffer.concat([len, manifest, tar.packFolder(dir, MAX_RAW, skip)])));
  if (!sealed) return cloud.logLine(`backup ${profileId}: no account key — log out and in once`);
  await uploadSealed(profileId, sealed);
  const info = await cloud.backupInfo(profileId);
  writeStamp(dir, info ? info.updatedAt : "");
  cloud.logLine(`backup ${profileId}: uploaded ${Math.round(sealed.length / 1024)} KB`);
}

// Page caches grew to GBs per PC (8.8 of 12.2 GB measured). Logins/cookies stay.
function trimCaches(dir) {
  for (const name of SKIP_IN_DEFAULT) {
    try { fs.rmSync(path.join(dir, "Default", name), { recursive: true, force: true }); } catch (_) {}
  }
}

// Called when the browser exits. Never throws; resolves when the upload is done.
async function backupWithRetry(profileId, dir) {
  for (let i = 0; ; i++) {
    try { return await backup(profileId, dir); } catch (err) {
      if (i >= RETRY_WAITS.length) throw err;
      cloud.logLine(`backup ${profileId} attempt ${i + 1} failed (${err.message || err}), retrying`);
      await new Promise((r) => setTimeout(r, RETRY_WAITS[i]));
    }
  }
}

function backupInBackground(profileId, dir) {
  const prev = pending.get(profileId) || Promise.resolve();
  if (supported(dir) && cloud.getCurrentUserId()) markPending(dir);
  const job = prev.then(() => backupWithRetry(profileId, dir))
    .catch((err) => {
      cloud.logLine(`backup ${profileId} failed, will retry later: ${err.message || err}`);
      cloud.reportFailure({ kind: "backup", profile: { id: profileId }, reason: String(err.message || err) });
    })
    .then(() => trimCaches(dir))
    .finally(() => { if (pending.get(profileId) === job) pending.delete(profileId); });
  pending.set(profileId, job);
  return job;
}

// Called before launch. Falls back to the local copy on any error.
async function restoreIfNewer(profileId, dir) {
  if (!supported(dir) || !cloud.getCurrentUserId()) return;
  if (pending.has(profileId)) return; // this PC is still uploading its own newer copy
  try {
    const info = await cloud.backupInfo(profileId);
    if (!info || !info.updatedAt || info.updatedAt === readStamp(dir)) return;
    const raw = zlib.gunzipSync(cloud.openBuffer(await downloadSealed(profileId)));
    const mlen = raw.readUInt32BE(0);
    const manifest = JSON.parse(raw.subarray(4, 4 + mlen).toString("utf8"));
    // Cookie encryption differs between Windows and macOS, so never cross over.
    if ((manifest.platform || "win32") !== process.platform) throw new Error(`backup was made on ${manifest.platform || "win32"}`);
    const old = dir + ".old";
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, old);
    try {
      tar.unpackTo(raw.subarray(4 + mlen), path.dirname(dir));
      await lockKey(dir, manifest.key);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (fs.existsSync(old)) fs.renameSync(old, dir);
      throw err;
    }
    fs.rmSync(old, { recursive: true, force: true });
    writeStamp(dir, info.updatedAt);
    cloud.logLine(`restore ${profileId}: browser data restored from account backup`);
  } catch (err) {
    cloud.logLine(`restore ${profileId} skipped: ${err.message || err}`);
  }
}

// Re-sends backups that failed or were cut off. root = real-browser-profiles,
// one folder per profile id with one folder per engine inside.
async function retryPending(root, isRunning) {
  const userId = cloud.getCurrentUserId();
  if (!userId) return;
  let ids = [];
  try { ids = fs.readdirSync(root); } catch (_) { return; }
  for (const id of ids) {
    let engines = [];
    try { engines = fs.readdirSync(path.join(root, id)); } catch (_) { continue; }
    for (const engine of engines) {
      const dir = path.join(root, id, engine);
      const stamp = readStampFull(dir);
      // Only this account's profiles, never one that is open or already uploading.
      if (stamp.pending !== userId || !supported(dir) || isRunning(id) || pending.has(id)) continue;
      let info;
      try { info = await cloud.backupInfo(id); } catch (_) { return; } // offline: next round
      // Another PC uploaded since this one last synced: its copy is newer, keep it.
      if (info && info.updatedAt !== (stamp.remoteAt || "")) { writeStamp(dir, stamp.remoteAt || ""); continue; }
      await backupInBackground(id, dir);
    }
  }
}

module.exports = { backupInBackground, restoreIfNewer, retryPending, skip };
