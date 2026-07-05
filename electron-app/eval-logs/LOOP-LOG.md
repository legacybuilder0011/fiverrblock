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
