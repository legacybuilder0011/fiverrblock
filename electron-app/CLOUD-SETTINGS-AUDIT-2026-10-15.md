# Cloud settings audit — 15 October 2026

## Conclusion

The current cloud implementation does **not** reproduce every saved desktop profile setting. It has no complete saved-configuration-to-runtime verification step before opening the viewer. The previous isolation tests did not establish full configuration parity or that websites cannot correlate profiles.

This was a read-only audit of application behavior and the active cloud container. No profile settings, cookies, browser processes, or deployed application code were changed in this audit.

## Live observations

The active cloud profile (`mtc6cckuvliq7y`) reports Debian GNU/Linux 13 (trixie) and Chromium 148.0.7778.215. Its configured display is 1440 × 900, with America/New_York and en-US language flags. The language flag includes repeated entries. Its startup script selects SwiftShader software rendering.

The container has its own profile data mount and one Docker network. Only one cloud profile was running; cross-container connectivity was not experimentally tested. Separate storage and networks do not establish immunity from correlation through shared public IPs, account information, or common browser characteristics.

These are OS, executable, container configuration and startup-script observations. They are not a measurement of every value visible to JavaScript in every open page.

## Saved settings and cloud behavior

| Setting | What the inspected implementation does |
|---|---|
| Profile name | Sends a sanitized name as a Docker label. |
| Proxy / PC VPN routing | Sends a proxy specification or creates a PC tunnel. A PC tunnel shares the PC's network exit. |
| Browser engine | Uses the cloud image's fixed Chromium binary; it does not launch the locally selected Chrome, Brave, Firefox, or Safari engine. |
| User agent / browser / OS | Sends a subset of identity flags. It does not send the full custom UA string. The launch builder hardcodes Chrome branding. An OS setting does not change the real Linux OS. |
| CPU | Includes a resolved CPU-count flag; that is not allocation of physical CPU cores. |
| RAM | Does not send the selected manual RAM value in the cloud launch configuration. |
| Screen | Sends width and height with limits. This alone does not verify viewport, DPR, available screen size, or all screen API values. |
| Timezone | Sends a resolved timezone identifier. Manual mode takes precedence over Auto. The separate manual offset is not included in the cloud payload. |
| Language | Sends language flags. These do not establish that every locale API or HTTP header matches. |
| Geolocation | Does not send the selected latitude, longitude or accuracy through this cloud launch path. |
| GPU / WebGL vendor and renderer | Does not send the selected manual GPU strings. Cloud startup selects software rendering. |
| Canvas, audio, WebGPU, client rectangles | Does not send these individual form controls. The cloud engine may have its own defaults or seed-dependent behavior; those are not proof that the user's selections were honored. |
| Fonts, media devices, device name | Does not send the selected per-profile values through this cloud launch path. |
| Cookie/storage blocking, DNT, blocked ports | Does not carry these individual privacy settings into the cloud startup configuration. Native defaults are not equivalent to enforcing the requested switches. |
| WebRTC | Uses a fixed non-proxied-UDP restriction, not the full selected per-profile WebRTC mode. |
| TLS / HTTP2 | Uses native cloud Chromium transport; does not carry a desktop JA3-bridge preference into the cloud setup. |
| Full/Stealth and per-site exclusions | Does not send those individual controls through the cloud launch payload. |
| ISP, ASN, organization | Reference metadata does not change the public IP's actual network ownership. |
| Engine & Identity Audit | Checks a candidate/saved configuration using `validateProfileConsistency`; it does not query and verify the running cloud browser. |

## Existing containers and stale settings

The desktop `PROFILE_START_CLOUD` handler opens the viewer immediately when the profile is already marked as running. The runner also returns `already: true` for an existing running container. Neither path reconciles the complete saved profile with that container before opening it.

Therefore saving a setting and opening an already-running cloud profile does not prove that the new setting was applied. Recreating a container would still only apply the supported subset, not the missing fields.

## Conflicts in the supplied form

- Timezone, language and geolocation are set to Manual, not Auto.
- The explicit UTC offset of 480 minutes conflicts with America/New_York. Local ICU timezone data reports UTC−04:00 on 15 October 2026 and UTC−05:00 on 15 January 2026, corresponding to 240 and 300 minutes behind UTC.
- A selected NVIDIA/Direct3D renderer does not mean the Linux cloud instance has that hardware or graphics backend.
- The claim that settings “can never mismatch” is unsupported. Auto depends on lookup results and when settings are resolved; it is not a continuous guarantee.

## Source locations

- `src/real-browser-manager.js`: `patchedFingerprintArgs`, `cloudLaunchSpec`.
- `src/ipc-handlers.js`: `PROFILE_START_CLOUD`, `PROFILE_AUDIT`.
- `src/profile-store.js`: `buildConfigFromProfile`, `validateProfileConsistency`.
- `cloud-runner/runner/server.js`: allowed arguments, `start`, existing-container handling.
- `cloud-runner/image-rtc/run-browser.sh` and `cloud-runner/image/entrypoint.sh`: cloud launch configuration and fixed defaults.
- `renderer/profiles.html`: the overly absolute identity-generation claims.

## Scope

Session isolation, access controls and truthful reporting of supported privacy settings can be strengthened. This audit does not certify unlinkable profiles or provide changes to optimize fabricated identities against anti-bot or multi-account detection.
