# Privacy Shield Browser — Work Session State

Last updated: 2026-05-16

## Current version
**1.9.7** (in package.json, just built)

## What is working
- Profile manager UI loads
- Login / Create Account flow loads
- Supabase auth fetch (via Electron `net.fetch`) bypasses TLS inspection
- Registration email confirmation flow detects and shows correct UI message
- Builds clean (`npm run build:win` auto-deletes old dist files)
- GitHub release creation via API works

## What was broken & how we fixed each version

| Version | Symptom | Fix |
|---|---|---|
| 1.9.2 | Browser window never opened. Error: `ERR_FAILED (-2) loading file:///C:\...\app.asar\renderer\tab-strip.html` | Tried switching `loadFile` -> `loadURL` with forward slashes |
| 1.9.3 | Same error, backslashes in URL | Forward slashes via `replace(/\\/g, "/")` |
| 1.9.4 | Same error, path was now `app.asar.unpacked/...` | Added `asarUnpack: ["renderer/**"]` to package.json |
| 1.9.5 | Same `ERR_FAILED` because `app.asar.unpacked` still contains `.asar` which trips Electron 31's file:// ASAR check | Auto mode UI labels, geo/lat-lng persistence on VPN capture |
| 1.9.6 | Custom `psapp://` protocol bypasses file:// entirely | Loads HTML via `protocol.handle("psapp")` that reads via `fs.readFileSync` |
| 1.9.7 | App closes entirely when clicking Start | **Crash recovery limited to 1 attempt** to prevent infinite `addTab -> render-process-gone -> closeTab -> addTab` recursion that was killing the main process |

## Root cause of the original crash
Electron 31's `file://` protocol loader has an over-eager ASAR check: any URL containing the substring `.asar` (including `.asar.unpacked/`) is routed through archive-handling code, which then fails because `.asar.unpacked` is a directory, not an archive. Result: `ERR_FAILED (-2)` even though the file exists on disk.

**Real fix**: custom `psapp://` protocol that uses `fs.readFileSync` (Node.js handles ASAR transparently for fs APIs). No `.asar` ever appears in URLs Chromium sees.

## Outstanding issues
1. **VPN detection wrong location** — only fixable by user (use system-level VPN, not browser extension)
2. v1.9.7 EXEs not yet uploaded to GitHub (need hotspot to run `node upload-release.js`)

## GitHub
- Repo: `legacybuilder0011/fiverrblock`
- Branch: `claude/chrome-site-blocker-extension-4L7ft`
- Token: set `$env:GITHUB_TOKEN` from environment, not committed
- Release IDs:
  - v1.9.3: 323467304
  - v1.9.4: 323524829 (has EXEs uploaded via web UI: `Privacy.Shield.Browser.1.9.4.exe`)
  - v1.9.5: 323536815 (no EXEs uploaded)
  - v1.9.6: 323539275 (no EXEs uploaded)
  - v1.9.7: see upload-release.js after creating release

## Upload workflow (after build)
1. Switch laptop to phone hotspot (avoids TLS inspection breaking the upload)
2. `$env:GITHUB_TOKEN = "your-token"`
3. `node upload-release.js`

## Key files & what they do
- `src/main.js` — registers `psapp://` protocol, opens login/profile manager
- `src/ipc-handlers.js` — all IPC handlers, profile window creation, tab management, CDP emulation
- `src/cloud-sync.js` — Supabase client using Electron net.fetch
- `src/profile-store.js` — profile CRUD, auto-mode resolution from proxy.detected* fields
- `renderer/profiles.js` — profile UI, VPN/proxy capture
- `renderer/profiles.html` — profile editor form (timezone/lang/geo dropdowns)
- `renderer/tab-strip.html` — the in-profile tab strip UI
- `upload-release.js` — uploads built EXEs to GitHub release

## Build flow
```
npm run build:win
```
Output: `dist/Privacy Shield Browser Setup X.Y.Z.exe` (installer) and `dist/Privacy Shield Browser X.Y.Z.exe` (portable)

## Test plan for v1.9.7
1. Delete any old `Privacy.Shield.Browser.*.exe` from Downloads/Desktop
2. Clear `%TEMP%` folders starting with random hex chars (portable extraction caches)
3. Download fresh v1.9.7 EXE from GitHub release
4. Install or run portable
5. Sign in / create account -> expect either app to open OR an explicit error in red
6. Create a profile -> click Start -> **browser window should open with tab strip + start page**
7. If crash on first tab: recovery tab opens once. Second crash -> window closes (no infinite loop)
