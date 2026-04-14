# Privacy Shield — Chrome Fingerprint & Cookie Blocker

A Manifest V3 Chrome extension that neutralises the most common browser-side
tracking surfaces. It runs across every site you visit and, while enabled:

- **Blocks cookies** at the `document.cookie` layer, strips `Cookie` /
  `Set-Cookie` headers via `declarativeNetRequest`, and purges the cookie jar
  in the background whenever Chrome tries to write one.
- **Spoofs geolocation** to any coordinates you choose (preset cities or
  custom lat/lon). `navigator.geolocation.getCurrentPosition` /
  `watchPosition` return the fake coordinates — the real location never
  leaves the browser.
- **Spoofs timezone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`,
  `Date.prototype.getTimezoneOffset`) and language.
- **Defeats browser / device fingerprinting** by normalising:
  - User-Agent, `userAgentData`, platform, vendor, app version
  - Screen resolution, color depth, available dimensions, `devicePixelRatio`
  - Installed fonts (`document.fonts`) and plugins / MIME types
  - Time zone settings (see above)
- **Hides hardware details**:
  - `hardwareConcurrency` (CPU core count)
  - `deviceMemory`
  - `navigator.connection` (NetworkInformation)
  - Graphics card / renderer (WebGL `UNMASKED_VENDOR_WEBGL` /
    `UNMASKED_RENDERER_WEBGL`) — `WEBGL_debug_renderer_info` is disabled
  - Battery status (`navigator.getBattery` returns a stubbed object)
- **Blocks canvas fingerprinting** by injecting per-frame noise into
  `toDataURL`, `toBlob`, and `getImageData`.
- **Blocks AudioContext fingerprinting** by noising
  `AnalyserNode.getFloatFrequencyData`, `getByteFrequencyData`,
  `getFloatTimeDomainData`, and `AudioBuffer.getChannelData`.
- **Blocks WebGL** renderer fingerprinting and mild rasterisation noise.
- **Blocks storage patterns** (`localStorage`, `sessionStorage`, `IndexedDB`,
  `caches`) when the option is enabled.
- **Kills Client Hints** (`sec-ch-ua*`, `device-memory`, `dpr`, `viewport-width`,
  `downlink`, `ect`, `rtt`, `save-data`, `x-client-data`, `referer`) at the
  network layer and rewrites `User-Agent` / `Accept-Language`.
- **Blocks common trackers** (Google Analytics, GTM, DoubleClick,
  Facebook Pixel, FingerprintJS, Hotjar, Mixpanel, Segment) via
  `declarativeNetRequest`.
- **Disables referrers, hyperlink auditing, network prediction, WebRTC IP
  leaks, and autofill** through `chrome.privacy` while the shield is on.

## What this can NOT block

- **DNS provider / AS number (ISP-level identification)** — DNS resolution
  happens in the OS network stack, below the browser. Pair this extension
  with an encrypted DNS resolver (DoH / DoT) or a VPN/Tor to change that.
- **TLS / SSL fingerprint of your connection (JA3/JA4)** — built from
  ClientHello fields that the browser chooses; no extension API can rewrite
  them. Use a VPN, Tor, or a separate proxy that re-terminates TLS.

The popup shows a note reminding you of this.

## Installing

1. Clone/download this repository.
2. In Chrome, go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Pin the Privacy Shield icon to your toolbar.

## Usage

- Click the toolbar icon to open the popup.
- The master switch toggles all protections.
- Flip each individual defense on/off as desired.
- Set your spoofed location (pick a preset or enter custom lat/lon).
- Set the timezone (e.g. `Europe/Paris`) and the **reverse-sign** offset in
  minutes — e.g. Paris (UTC+1) → `-60`, Tokyo (UTC+9) → `-540`.
- Click **Save & Reload tab** so the active page re-fingerprints with the
  new values.
- Use **Purge all cookies now** to clear the entire cookie jar immediately.

## File layout

```
manifest.json          MV3 manifest
background.js          service worker — cookies, privacy toggles, messaging
content-bridge.js      ISOLATED world bridge — pushes config into page
content-main.js        MAIN world script — overrides fingerprint APIs
rules.json             declarativeNetRequest rules (headers & tracker blocks)
popup.html/.css/.js    toolbar popup UI
icons/                 extension icons (16/48/128)
```

## Notes on accuracy

- Per-page canvas / audio noise is deliberately small so visual and audio
  output still look correct to humans while producing a different
  fingerprint each page load.
- Spoofed values are sent to every frame (including iframes) at
  `document_start` so fingerprint scripts see the fake values on first
  access.
- Some sites may break (captchas, anti-bot, WebRTC video, etc.). Toggle
  individual defenses off for those sites, or disable the master switch.
