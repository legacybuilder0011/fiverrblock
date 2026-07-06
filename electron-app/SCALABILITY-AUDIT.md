# Privacy Shield — Scalability Audit & Fix Plan

**Date:** 2026-07-06
**Scope:** Will the app stay stable as a user grows to hundreds of profiles and opens many at once? Where does it freeze, corrupt data, or crash?
**Method:** Static read of the main-process hot paths — persistence (`profile-store.js`), profile/tab lifecycle and the VPN watcher (`ipc-handlers.js`), crash handling (`main.js`), and the renderer list (`renderer/profiles.js`).

---

## TL;DR

The app's crash *isolation* is already good (main-process guards + per-window crash recovery). The scalability problems are in the **data layer** and **resource limits**:

1. **Bulk-create is O(n²) synchronous disk I/O** — creating 100 profiles rewrites the entire file 100 times on the UI thread → hard freeze. **[FIXED]**
2. **Writes are not atomic** — a crash mid-write truncates `profiles.json` and loses *every* profile. The bigger the account, the more you lose. **[FIXED]**
3. **No ceiling on concurrently open profiles** — each is a ~200 MB Chromium renderer; opening too many silently OOM-crashes the whole app. **[FIXED]**
4. Cloud sync fans out one HTTP request per profile on bulk ops. **[FIXED — batched]**
5. Renderer builds one DOM card per profile with no virtualization. **[DEFERRED — see reasons]**

---

## What is already solid (not changed)

- **Main-process crash guards.** `main.js:58-66` handles `uncaughtException` + `unhandledRejection` — a stray throw won't kill the app.
- **Per-window crash recovery.** `ipc-handlers.js:1607, 1950` handle `render-process-gone`; a crashed tab is auto-recovered, and the recovery loop is guarded against infinite re-spawn (`:2026`).
- **VPN watcher scales.** `runVpnWatchTick` (`:2599`) does **one** shared network probe per tick and only when interfaces change or on a heartbeat — cost is O(1) in the number of open profiles, not O(n). Good design; left alone.
- **Map lifecycle.** `webContentsProfileMap`, `profileWindows`, `profileNetworkMeta`, `windowTabState` are all deleted on window/tab close (`:1730-1735, 2018-2019`). No obvious leak.

---

## Findings (ranked)

### 1. CRITICAL — O(n²) synchronous writes on bulk create
**Where:** `ipc-handlers.js:2131-2145` (`bulkCreateProfiles`) → `profile-store.js:459-490` (`createProfile`).
**Problem:** `bulkCreateProfiles` loops and calls `store.createProfile()` per profile. Each `createProfile` does a **full `getProfiles()` read** (parse the whole file) **and a full `saveProfiles()` write** (stringify the whole, ever-growing array) — synchronously, on the main thread. Creating N profiles = N reads + N writes of a file that keeps getting bigger.
**Impact at scale:** On an account that already holds hundreds of entries, "generate 100" rewrites a multi-hundred-entry file 100 times back-to-back. The main process blocks for seconds-to-minutes; every open browser window freezes; it also fires 100 individual Supabase requests. This is the single worst offender.
**Fix:** New `store.createProfilesBatch(list)` — one read, build all in memory, **one** write, **one** batched cloud push. `bulkCreateProfiles` now calls it. O(n²) → O(n).

### 2. CRITICAL — Non-atomic writes risk total data loss
**Where:** `profile-store.js:41-44` (`writeJson`).
**Problem:** `fs.writeFileSync(file, ...)` writes in place. If the process dies mid-write (crash, OOM, power loss), the file is left half-written → invalid JSON → on next load `readJson` falls back to `[]` and the user's profiles are **gone**. Larger files (more profiles) widen the corruption window.
**Impact at scale:** The more successful the user, the more they can lose in one bad write.
**Fix:** `writeJson` now writes to `<file>.tmp`, `fsync`s, then `fs.renameSync` over the target (atomic on the same volume), and keeps the last good copy as `<file>.bak`. A torn write can no longer destroy the live file, and `.bak` is a recovery point.

### 3. HIGH — No memory ceiling on open profiles
**Where:** `ipc-handlers.js:1353` (`openProfileWindow`).
**Problem:** Nothing limits how many profiles can be open at once. Each open profile is a full Chromium renderer (~150-250 MB) plus session and preload.
**Impact at scale:** A user opening 20-30 profiles on an 8 GB laptop exhausts RAM and the OS kills the app — losing *all* open sessions at once.
**Fix:** A soft guard in `openProfileWindow` computes a safe cap from available system memory (`os.freemem`) and the count already open. Past the cap it returns a friendly, actionable error (the renderer already surfaces `{ok:false,error}`) instead of letting the app OOM. Re-focusing an already-open profile is exempt.

### 4. MEDIUM — Cloud sync request fan-out
**Where:** `profile-store.js:444-449` (`syncProfileBg`) called per profile in bulk paths.
**Problem:** Bulk operations fire one `pushProfile` HTTP request per profile. 100 concurrent requests can rate-limit or fail.
**Fix:** The new batch path uses `cloud.pushAllProfiles()` (single upsert of the whole set) instead of N individual pushes.

### 5. MEDIUM — Renderer list has no virtualization *(DEFERRED)*
**Where:** `renderer/profiles.js:422-474`.
**Problem:** The list clears `innerHTML` and builds one card per live profile. At many hundreds of *live* profiles this is heavy DOM work on each refresh.
**Why deferred:** It causes jank, not a crash, and only for users with hundreds of *live* (non-trashed) profiles — most accounts keep a small live set (trashed profiles are already excluded). Virtualizing the list is a meaningful UI change with its own regression risk. Recommended as a follow-up if a power user reports list lag; not bundled with the data-integrity fixes.

---

## Fixes implemented in this pass

| # | Fix | File |
|---|-----|------|
| 1 | Atomic write + `.bak` rotation | `profile-store.js` `writeJson` |
| 2 | `createProfilesBatch()` — one read/write/push | `profile-store.js` |
| 3 | Bulk create uses the batch path | `ipc-handlers.js` `bulkCreateProfiles` |
| 4 | Open-profile memory guard | `ipc-handlers.js` `openProfileWindow` |

## Deferred (with reason)

- **Renderer list virtualization** — jank not crash; only affects hundreds-of-live-profiles users; separate UI change.
- **Async write queue / debounce** — deliberately *not* done. Debouncing risks losing the last write if the app quits before flush. Correctness (atomic writes) matters more than shaving the single-save block, and single saves are already small. Revisit only if profiling shows single-save jank on very large files.
