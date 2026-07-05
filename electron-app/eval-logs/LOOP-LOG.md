# Privacy Shield — Leak-Fix Loop Log

Goal: no profile detectable/linkable to another; Chromium engine mimics Chrome; Stealthfox (Camoufox) wired. Fix one thing at a time, evaluate on a real domain, compare before/after.

## Method
`electron eval-harness.js <profileId|first> <url>` launches the Chromium engine (profile session + preload-fingerprint.js), loads a real fingerprinting domain, extracts raw signals. Two profiles run to check linkability (hashes must DIFFER) and coherence (reported GPU vs real GL capabilities).

## Iteration 1 — FIX: uncaught `enabledPlugin` TypeError aborted the whole preload (HIGH impact) ✅
**Symptom:** On a real domain (browserleaks.com/webgl), a fresh profile leaked the REAL GPU via WEBGL_debug_renderer_info (`ANGLE (Intel, Intel(R) UHD Graphics 620 …)`) and reported the REAL machine timezone (Africa/Lagos) despite config having blockWebGL:true + spoofed GPU (AMD RX 580) + spoofTimezone. Every profile showed the same real hardware → fully linkable.
**Root cause:** `preload-fingerprint.js` plugins block defined `enabledPlugin` non-configurable (line 605), then redefined it (line 623) → `TypeError: Cannot redefine property: enabledPlugin`. Uncaught, inside the top-level preload IIFE → aborted execution from the plugins block onward, so Screen/Timezone/Canvas/WebGL/Audio spoofing NEVER ran (only nav/UA/hardware, which come before plugins).
**Fix:** made `enabledPlugin` `configurable: true`.
**Eval (before → after), fresh profiles:**
- debug WEBGL renderer: `Intel UHD 620` (real) → `null` (hidden) ✅
- timezone: `Africa/Lagos` (real machine) → per-profile (`America/Denver`, `America/Chicago`) ✅
- canvas hash across 2 profiles: identical-real → DIFFER (49ba9101 vs a2173c7f) ✅ not linkable
- audio hash across 2 profiles: → DIFFER (d78fb609 vs 86c6ba81) ✅ not linkable
- WebGL supported-extensions: 35 (real) → 28 (normalized) ✅
**Residual (next iterations):** glMaxTexture (16384) + screen (1536x864) + hwConcurrency (4) came out SAME across the 2 fresh profiles — real-GPU cap leak + possible screen/cores randomization collision. Investigate next.

## Iteration 2 — CHECK: fingerprint stability across sessions ✅ (no fix needed)
Ran the same profile (EVAL Profile 2) twice on browserleaks.com/webgl. ALL signals identical: timezone, tzOffset, screen, hwConcurrency, deviceMemory, canvasHash (49ba9101), audioHash (d78fb609), webglHash, UA. Requirement "fingerprint identical across sessions" is MET (canvas/audio noise seeded by fingerprintSeed||profile.id → deterministic).

## Iteration 3 — CHECK: per-profile storage isolation ✅ (no fix needed)
Session-level test: profiles use distinct `persist:privacy-shield-profile-<id>` partitions (separate storagePath, different session objects). Cookie set in profile A: A=1 (SECRET_A), B=0. ISOLATION_OK=true. Cookies/localStorage/cache/IndexedDB isolated by Electron partition. Requirement met.

## Iteration 4 — CHECK: per-profile hardware randomization ✅ (no fix needed)
5 fresh profiles → screen {1536x864,1366x768,1440x900,1440x900,1366x768}, cores {12,16,4,16,12}, ram {32,32,8,16,32}, gpu {AMD RX580 x2, GTX1060, RTX30, RTX20}: all varied. Earlier P2/P3 collision was chance in a small realistic-resolution pool, not a bug.

## Iteration 5 — CHECK: Chromium automation/bot signals ✅ (no fix needed, benefits from iter1)
bot.sannysoft.com: webdriver=false, chrome.runtime=present, plugins=5 (instanceof PluginArray/Plugin/MimeType all true — restored by iter1), uaData=Chrome 150 brands, Function.toString cloak=native-ok, WebGL getParameter cloak=native-ok. Core bot checks pass.

## Iteration 6 — FIX: WEBGL_debug_renderer_info nulled (tell + identical across profiles) ✅
**Symptom:** getExtension('WEBGL_debug_renderer_info') returned null → every profile showed "(no debug ext)". Real Chrome EXPOSES this extension, so nulling it is unusual (a tell) AND identical across profiles (weakly linkable / non-coherent with the profile's assigned GPU).
**Fix:** getExtension now returns the real ext on desktop (iOS still null, matching Safari); getParameter already maps 37445/37446 to the per-profile spoofed GPU; added WEBGL_debug_renderer_info to the normalized getSupportedExtensions list for coherence.
**Eval:** P2 → "ANGLE (AMD, AMD Radeon RX 580 …)", P3 → "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 …)": DIFFER across profiles, EXISTS like Chrome, listed in extensions (count 29). 
**Note:** real GPU rendering pixels + ANGLE-normalized caps (MAX_TEXTURE_SIZE 16384 etc.) are still the machine's — but on Windows ANGLE/D3D11 these are normalized/common across most Chrome users (low linkability); the strong per-GPU signal (debug renderer string) is now per-profile. The Firefox Stealthfox (Camoufox) engine solves render-level GPU spoofing for the hardest cases.

## Iteration 7 — FIX (partial): font fingerprint linkable across profiles
**Symptom:** Two profiles detected the IDENTICAL 13 real Windows fonts (fontsHash ff9c2301 both) — the width-measurement method bypasses blockFonts (which only patches document.fonts.check/FontFace). All profiles on one machine = same real fonts = linkable.
**Fix applied (SAFE, verified):** per-profile deterministic sub-pixel noise on `CanvasRenderingContext2D.measureText().width` (keyed to fingerprintSeed + text + font). Defeats the canvas/measureText-based font+text fingerprint used by fingerprintjs-canvas/browserleaks.
- P2 measureTextHash=259222b2, P3=3ac99a3a → DIFFER (not linkable) ✅
- P2 vs P2 = stable ✅ ; deltas sub-pixel (175.12769 vs 175.13049) → layout-safe.
**Residual (honest):** the `offsetWidth`-of-span method (fingerprintjs2) still returns identical integer widths → the detected-font SET is still linkable. Fixing it needs integer-level offsetWidth/getBoundingClientRect perturbation on EVERY element → real layout-break risk; deferred (Stealthfox/Camoufox spoofs fonts at engine level for the hard cases). Will attempt a bounded version next.

## Iteration A — FIX: getBoundingClientRect width/height not noised (font/geometry linkable) ✅
**Symptom:** old ClientRects noise only moved position (kept width/height), and was off by default (clientRects:"real"). So getBoundingClientRect-based geometry/font fingerprint was identical across profiles.
**Fix:** perturb width/height (and position) with per-profile deterministic sub-pixel noise; enable it for full-spoof profiles (gated on blockCanvas → OFF in stealth). 
**Eval on en.wikipedia.org (real layout):** gbcr hash P2=bc6bf3c7 vs P3=eb5db899 DIFFER ✅; P2==P2-again STABLE ✅; render sanity OK (bodyWidth 1250.7 identical, 11 children, title correct) → sub-pixel noise is layout-safe. offsetWidth stays consistent (round unchanged).
**Residual (honest, deferred to Stealthfox):** offsetWidth-integer font-SET (fingerprintjs2) — a bounded integer perturbation either preserves the set (size-keyed delta) or risks layout; engine-level territory. Camoufox spoofs fonts natively.

## Iteration B1 — CHECK: proxy↔geo auto-alignment ✅ (no fix needed)
buildConfigFromProfile with fp.timezone/language/geolocation="auto": Germany proxy → tz=Europe/Berlin, lang=de-DE, geo=52.52,13.4; Japan proxy → tz=Asia/Tokyo, lang=ja-JP, geo=35.71,139.67. Works with full detection AND country-code-only (country→tz/geo fallback present). "Location mismatch" prevention requirement met.

## Iteration B2 — CHECK: WebRTC leak guard ✅ (no fix needed)
Baseline (no hardening): 3 ICE candidates leaking REAL local 192.168.18.7 + REAL public 105.127.6.226. With app hardening (force-webrtc-ip-handling-policy=disable_non_proxied_udp + preload candidate-drop + mDNS): 0 candidates, no IPs. Real IP does NOT leak. Requirement met.

## Iteration C — FIX: Stealthfox (Camoufox) fingerprint DRIFTED every launch ✅
**Symptom:** launching the SAME profile twice in Camoufox gave a different canvas AND WebGL GPU each time (e.g. AMD HD 3200 → Intel HD 400; canvas a7953d25 → 90d15cf). Camoufox generates a fresh random fingerprint per launch when none is passed → a returning account looks like a different device each session (detection red flag). Violates "fingerprint identical across sessions".
**Root cause:** camoufox-manager passed no fingerprint; and even a persisted `fingerprint` object doesn't pin WebGL (sampleWebGL random per launch), canvas AA (`canvas:aaOffset`=Math.random) or text (`fonts:spacing_seed`=Math.random) — those are set separately in camoufox-js/utils.js.
**Fix:** (1) generate ONE Firefox fingerprint per profile via fingerprint-generator (same config Camoufox uses) and persist it (`<userData>/camoufox-profiles/<id>-fingerprint.json`), pass on every launch; (2) pass `webgl_config=[videoCard.vendor,renderer]` from that fingerprint → stable GPU; (3) patch-package camoufox-js so `canvas:aaOffset` and `fonts:spacing_seed` respect caller-provided values, and pass per-profile deterministic values in `config`.
**Eval (3 Camoufox launches):** A vs A-again → canvas 450ede67==450ede67, GPU GTX980==GTX980 STABLE ✅; A vs B → canvas 450ede67 != 46133e4b DIFFER (not linkable) ✅. Applied to src/camoufox-manager.js so the app benefits.

## Iteration A (completed) — FIX: offsetWidth/offsetHeight font-width-hash linkable ✅
Extended iter A: the dominant font fingerprint (fingerprintjs) hashes a probe span's INTEGER offsetWidth/offsetHeight, which was identical across profiles. Added a per-profile deterministic ±1px delta (shared dimDelta, keyed to the rounded value), and applied the SAME integer delta to getBoundingClientRect width/height so offsetWidth == round(gbcr.width) stays coherent (no new tell).
**Eval on en.wikipedia.org:** fontWidthHash P2=df66cc63 vs P3=7ce28e25 DIFFER ✅; P2==P2-again STABLE ✅; coherence offsetWidth==round(gbcr.width) = 40/40 elements ✅; bodyWidth ~1251 layout intact ✅. The offsetWidth font vector previously deferred is now safely + coherently fixed.

## Iteration D — HYPOTHESIS DISPROVEN by measurement: WebGL numeric caps not a leak (NO FIX)
**Hypothesis:** getParameter passes real-GPU numeric caps (MAX_TEXTURE_SIZE etc.) through → identical across profiles → linkable + incoherent with the per-profile claimed GPU string.
**Measured** (webgl-param-probe.js, 3 profiles on example.com): all numeric caps IDENTICAL across profiles — MAX_TEXTURE_SIZE 16384, CUBE/RENDERBUFFER 16384, VIEWPORT_DIMS 32767, TEX_IMAGE_UNITS 16, VERTEX_ATTRIBS 16, VERTEX_UNIFORM 4096, FRAG_UNIFORM 1024, VARYING 30, COMBINED 32, ALIASED_POINT 1..1024, DEPTH 24, FRAG_HIGH_FLOAT 127/127/23, MAX_ANISOTROPY 16.
**Conclusion: NOT a leak, DO NOT fix.** On Windows, Chrome runs WebGL through ANGLE→D3D11 which NORMALIZES these caps to hardware-independent values. A real RX 580 machine and a real RTX 2080 machine report the exact same numbers as this Intel UHD 620 box. So: (a) identical-across-profiles ≠ linkable (a value ~all Windows Chrome users share can't distinguish/link); (b) each profile's caps ARE coherent with its claimed GPU (an RTX 3060 on Win Chrome genuinely reports these). Spoofing them would make profiles INCOHERENT (values no real Chrome reports) and risk breaking WebGL allocation. Correct behavior = pass-through. (Caveat: a profile claiming macOS/Linux while these D3D11-shaped caps + renderer string are reported WOULD be incoherent — separate cross-OS concern; all test profiles are Windows.)

## Iteration E1 — FIX: navigator.deviceMemory reported impossible values 16/32 (bot tell + incoherent) ✅
**Symptom** (residual-probe.js, 3 profiles): deviceMemory = 32, 32, 16. Real Chrome CLAMPS navigator.deviceMemory (and Sec-CH-Device-Memory) to {0.25,0.5,1,2,4,8} — round down to a power of two, capped at 8 — to limit fingerprinting. 16/32 are IMPOSSIBLE in real Chrome → instant automated bot tell, and incoherent.
**Root cause:** coherent-identity generator + defaults set `fp.ramValue` to real physical RAM via randomChoice([...,16,32]); buildConfigFromProfile line ~1759 copied that raw into cfg.deviceMemory when fp.ram==="manual". That raw value flowed to the preload (main frame), cdp-stealth (worker scope), AND the device-memory client hint.
**Fix:** added `clampDeviceMemory(gb)` in profile-store; applied at the config source (`cfg.deviceMemory = clampDeviceMemory(...)`, both the manual override and a final pass) so all 3 scopes get a valid value; plus defense-in-depth clamp at the preload exposure point (`_validDeviceMemory`). Stored profile keeps real RAM for display.
**Eval:** deviceMemory now 8/8/8 (8 = most common Chrome value → coherent AND non-linkable). cores still vary 8/8/4. No page-load regression on Fiverr.

## Iteration E2 — FIX: mediaDevices leaked the machine's real device layout, identical across profiles ✅
**Symptom** (residual-probe.js): every profile returned the SAME 7-device topology — audioinput x3, audiooutput x3, videoinput x1 (the real hardware). Same-machine linkage signal + non-diverse.
**Root cause:** cfg `_mediaDevices` defaulted to "real"; the preload's per-profile enumerateDevices spoof was gated on `=== "manual"` so it never ran for normal profiles → real device list passed through.
**Fix:** in buildConfigFromProfile, when mediaDevices isn't an explicit "manual" pick, derive per-profile deterministic counts from the profile seed (mics 1-2, speakers 1-2, cameras 0-1 via pickWeighted/profileSeededInt) and route through the existing cloaked enumerateDevices spoof.
**Eval:** topology now differs — P1: 3 (1/1/1), P2: 5 (2/2/1), P3: 5 (2/2/1); real 3/3/1 layout no longer exposed. Seed-derived → stable across sessions. (P2/P3 collision = small-distribution chance, spreads with more profiles.)

## Harness fix (tooling)
concurrent-harness.js / probes: Electron parses a bare `about:blank`/URL positional arg as a switch and exits 127 with no output. Pass app args after a `--` separator; harness now filters out the leading `--` from argv (`process.argv.slice(2).filter(a=>a!=="--")`). Run pattern: `node_modules/electron/dist/electron.exe <harness> -- <url> <ids>`.

## Real-world linkage caveat (must state honestly)
The fingerprint layer is well-diversified and unlinkable across profiles on all 6 target domains (fiverr/instagram/facebook/tiktok/twitch/upwork): canvas/audio/gpu-string/fontWidth/deviceId all DIFFER, webdriver=false, no real-GPU/timezone/canvas leak, no bot wall on homepages. BUT the leak-test profiles ran with NO proxy → all share ONE real IP. Sites correlate accounts by IP regardless of fingerprint, so "not linked when run together" REQUIRES a distinct per-profile (static residential) proxy — the app supports this (networkMode:proxy + proxy library), it just wasn't exercised here. Passing an actual "I'm not a robot"/press-and-hold challenge on signup depends primarily on IP reputation + warmed accounts, not fingerprint, and can't be asserted from these tests.

## Iteration F — VERIFY: VPN-connected → fingerprint auto-alignment (tz/lang/geo) + IP/WebRTC monitor ✅
User requirement: when the connected VPN is (say) Germany, the profile's timezone/language/geolocation must auto-adjust to Germany (no "location mismatch"), derived from the VPN country when those fields = "auto"; plus monitor for IP changes / WebRTC leaks.

**How the chain works (traced in ipc-handlers.openProfileWindow):** for networkMode vpn|direct, launch calls `captureCurrentNetwork()` (ip-api→ipwho.is→ipapi.co, returns country/tz/lat/lon/isp + proxy/hosting/mobile flags), then `updateProfile` persists the LIVE exit into `proxy.detected*` and reuses the fresh profile object for this launch's config (line ~1444). `buildConfigFromProfile` seeds its DEFAULT tz/lang/geo from `_ccDef = proxy.detectedCountryCode` (via pickTimezoneForCountry/pickLanguageForCountry/geoForCountry), and the "auto" block refines tz with `detectedTimezone` and geo with `detectedLatitude/Longitude` when present. So even a COUNTRY-ONLY capture aligns (defaults are country-seeded) — the partial-capture mismatch I hypothesized does NOT exist (proven, no fix needed).

**Eval 1 — config level (vpn-align-test.js), 5 simulated exits:** DE full, DE country-only, JP full, JP country-only, GB country-only → ALL aligned (tz region matches country, language matches, geo not stuck at the NY default). Country-only cases align because the config defaults are country-seeded.

**Eval 2 — browser level (vpn-browser-test.js), real Chromium tabs, machine's real zone = Africa/Lagos:**
- VPN-DE: Intl tz = Europe/Berlin; getTimezoneOffset Jan -60 / Jul -120 (DST-correct); navigator.language de-DE, languages de-DE,de; geolocation 52.52,13.405 (Berlin); WebRTC candidate = 91.10.20.30 (the DE exit IP) — real Lagos IP/timezone NEVER appears.
- VPN-JP: Intl tz = Asia/Tokyo; offset Jan -540 / Jul -540 (Japan has NO DST — correct); language ja-JP; geolocation 35.68,139.76 (Tokyo); WebRTC = 126.10.20.30 (JP exit IP).
The DE-with-DST vs JP-without-DST difference proves the offset is a genuine per-IANA-zone calc, not a faked static number. WebRTC shows only the VPN exit IP (coherent with country), real IP does not leak.

**Eval 3 — IP-change / leak monitor (code-traced, wired & live):** launch registers vpn/direct profiles in `profileNetworkMeta` + calls `startVpnWatch()` → `setInterval(runVpnWatchTick, VPN_WATCH_TICK_MS)`. Each tick: on network-interface change or heartbeat it re-probes the exit IP; if the exit COUNTRY differs from the profile's anchor, or the network is unreachable for VPN_WATCH_FAIL_LIMIT probes (VPN dropped / kill-switch cut), it `killWatchedProfiles` → closes the window + notifies the manager (VPN_DROPPED). Self-baselines country on first good probe. (WebRTC guard + auto-align verified live above; the drop-close path is verified by code path, not by simulating a live VPN drop.)

**Result:** VPN→fingerprint auto-alignment is IMPLEMENTED and VERIFIED end-to-end (config + real browser). The connected-VPN country drives timezone (DST-correct), language, geolocation, and even the WebRTC exit IP; the real machine location never leaks; an IP/country change or VPN drop closes the profile.

## Iteration G — LIVE VPN test on the user's real connection (US/Miami) across all 6 domains ✅
User connected their real system VPN (ip-api: US/Miami/Florida, America/New_York, proxy:true, exit rotating in 193.36.224.x / 104.234.19.x). live-vpn-test.js: for each profile set tz/lang/geo=auto, captured the LIVE exit into proxy.detected* (as openProfileWindow does), rebuilt config, opened all 3 concurrently on each domain.
Domains: fiverr, instagram, facebook, tiktok, twitch, upwork. For ALL profiles on ALL domains:
- Timezone = America/New_York (VPN-aligned), offset Jan 300 / Jul 240 = EST→EDT DST-correct. Real machine zone Africa/Lagos NEVER appeared.
- Language en-US; geolocation 25.77,-80.19 = Miami. All aligned to the live VPN.
- WebRTC candidate = the VPN exit IP only (193.36.224.191/184/165/195/193, 104.234.19.62) — no real ISP IP, no local 192.168.x leak.
- Real Intel UHD 620 GPU never leaked; each profile shows its own GPU (RX580/RTX2080/RTX3060) + canvas.
- deviceId STABLE per profile across every domain (LEAKTEST1 94625e40, LEAKTEST2 ba66dc8c, LEAKTEST3 881f96a4) and DIFFERENT between profiles → each profile is a consistent, distinct device; not linkable by device.
- botWall=false on every domain homepage.
**Honest caveat (confirmed live):** all 3 profiles exit the ONE system VPN so they SHARE the public IP within a run — a site can correlate them by IP regardless of fingerprint. Device layer is fully distinct + leak-free; IP isolation needs a per-profile proxy (networkMode:proxy + proxy library). Passing an actual not-a-robot/press-and-hold on signup remains IP-reputation-bound.

## Iteration H — VERIFY: "one VPN, switch location per profile, one at a time" workflow
User's plan: use one system VPN, but change its location per profile, opening one profile at a time (close A, switch VPN, open B). This AVOIDS the shared-IP linkage from concurrent use (each profile only ever touches its own country's IP, never overlapping).
The load-bearing guard = per-profile location LOCK (openProfileWindow: locationsMatch(profileAnchor(profile), liveExit)). lock-test.js proves: anchor-US + VPN-US → ALLOW; anchor-US + VPN-DE → BLOCK (needsLocationConfirm); anchor-DE + VPN-DE → ALLOW; anchor-DE + VPN-US → BLOCK. So a profile can't be silently opened on the wrong country (which would flag the account as an IP-country jump / takeover). Plus: no-VPN guard blocks launching a VPN-bound profile on the real ISP; kill-switch closes a profile if the exit country changes or the network drops while open; per-profile fingerprint is stable+distinct (iter G). Anchor is set on FIRST launch → connect the intended country before first opening each profile. Requirement met; workflow is leak-safe if: one profile open at a time, each profile kept to a consistent country, VPN fully connected before opening.

## Iteration I — PER-PROFILE PROXY test with REAL proxies (proxifly free list), concurrent ✅ (the shared-IP fix)
Assigned 3 different-country free HTTP proxies (proxifly/free-proxy-list) to the 3 profiles via networkMode:proxy and the app's own sessionMgr.configureSessionProxy (native setProxy `http://host:port`, no auth). Set tz/lang/geo=auto + proxy.detected* = each proxy's captured exit. Opened all 3 CONCURRENTLY, loaded ip-api THROUGH each proxy to read the IP the SITE actually sees. proxy-test.js:
- LEAKTEST1 → US proxy 174.137.134.182: site saw 174.137.134.182 (US), tz America/New_York, lang en-US, geo NYC, rtc=proxy IP, GPU AMD RX580, deviceId 999d0623.
- LEAKTEST2 → JP proxy 124.156.230.244: site saw 124.156.230.244 (JP), tz Asia/Tokyo, lang ja-JP, geo Tokyo, rtc=proxy IP, deviceId dffa2c1c.
- LEAKTEST3 → GB proxy 104.194.148.188: site saw 104.194.148.188 (GB), tz Europe/London, lang en-GB, geo London, rtc=proxy IP, deviceId b33773b3.
ALL: siteSeesIp == assigned proxy IP (ipMatchesProxy true) → 3 DIFFERENT IPs in 3 countries running at once = NOT IP-linkable. tz/lang/geo auto-aligned to each proxy country. WebRTC = proxy IP only, real IP never leaks. Real Intel GPU never leaks; canvas/gpu/deviceId all distinct. **This closes the shared-IP linkage: per-profile proxy makes concurrent profiles look like separate devices in separate countries with separate IPs.**
CAVEAT: free proxies = unreliable + bad IP reputation (die in minutes, often blacklisted). This PROVES THE MECHANISM; real farming needs paid static residential proxies (same app path, just better IPs). NOTE: LEAKTEST profiles now hold these (soon-dead) proxy configs — reset to direct or reassign before reuse.

## Iteration J - FIX: cloud sync leaked local-only profile state and proxy credentials
**Symptom:** The manual login/cloud sync path pushed `store.getProfiles()` and `store.getProxyLibrary()` directly to Supabase. Those runtime objects can include cookies, localStorageData, session payloads, proxy username/password, and rotation URLs. That violated the dashboard requirement: cloud may sync settings, but must not expose raw credentials or cookies.
**Root cause:** Background sync used `sanitizeProfileForSync` / `sanitizeProxyForSync`, but those helpers only removed proxy password fields, and `postLoginSync()` bypassed them entirely by calling `cloud.pushAllProfiles(localProfiles)` and `cloud.pushAllProxies(localProxies)`. `cloud-sync.js` also trusted incoming/outgoing records without sanitizing at the cloud boundary.
**Fix:** Added cloud-boundary sanitizers in `cloud-sync.js` that strip profile cookies, localStorageData, session data, and proxy credential fields before every push and after every pull. Added sync merge helpers in `profile-store.js` so remote settings updates do not overwrite local-only cookies, localStorage, sessions, or proxy credentials. Updated `postLoginSync()` to use the preserving merge helpers.
**Eval:** `node --check` passed for `cloud-sync.js`, `profile-store.js`, and `ipc-handlers.js`. Local fixture 1 proved remote settings update while local cookies/localStorage/session/proxy credentials are preserved and unsafe remote local-state is ignored. Local fixture 2 mocked Supabase upsert payloads and proved profile/proxy cloud rows omit cookies, localStorageData, session, username, password, passwordEnc, and rotationUrl.
**Result:** Cloud dashboard sync no longer uploads raw cookies/session data or proxy credentials, and pulling sanitized cloud settings no longer destroys local-only browser/profile state.
