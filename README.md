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

## Hiding your real IP / ISP / ASN / country

`navigator.geolocation` is a browser API — this extension spoofs it
successfully. But websites that read your **IP address** (and from it your
ISP, ASN, country, city via GeoIP databases) see that information from the
TCP/IP packets your OS sends. **JavaScript can't touch those packets**, so
no browser extension can change them on its own.

To change them, route Chrome's traffic through a proxy. This extension has
a built-in **proxy client** (`chrome.proxy`) that is safety-tested before
it actually takes effect:

### Step by step — hide your IP with Tor (free, easiest)

1. Download and install **Tor Browser** from <https://www.torproject.org>.
2. **Launch Tor Browser** and let it connect to the Tor network. Leave
   the window open. Tor Browser runs a local SOCKS5 proxy on
   `127.0.0.1:9150`.
3. Click the Privacy Shield icon → **"Hide real IP / ISP / ASN (proxy)"**.
4. Pick the **"Tor Browser (127.0.0.1:9150)"** preset.
5. Click **"Connect & test"**.
6. If your proxy is reachable you will see
   *"Proxy connected. Sites will see IP: …"* — that IP is what every site
   will see from now on. The toolbar badge becomes **VPN**.
7. If you see *"Proxy unreachable"* it means Tor Browser isn't running yet.
   **The extension automatically reverts to a direct connection** so you
   never get stuck with "No internet". Start Tor Browser and try again.

### Alternative proxy sources

- **Paid VPN with SOCKS5**:
  - Mullvad (while the Mullvad app is connected via WireGuard): SOCKS5
    `10.64.0.1:1080`.
  - ProtonVPN / IVPN / AirVPN: check your provider's dashboard for a
    SOCKS5 host and port, and (if required) username/password.
- **Your own SSH tunnel**: run `ssh -D 1080 -N user@yourserver` on your
  machine and point the extension to SOCKS5 `127.0.0.1:1080`.
- **Standalone Tor daemon** (without Tor Browser): the daemon listens on
  SOCKS5 `127.0.0.1:9050` once started.

No proxy is bundled with the extension — you bring your own trusted one.

### Recovering from "No internet" / `ERR_PROXY_CONNECTION_FAILED`

That error means Chrome is still pointed at a proxy that isn't answering.
Two one-click fixes:

1. **Open the Privacy Shield popup** (it loads from an extension URL, not
   through the proxy, so it always works) and click **"Disconnect"**.
2. Or toggle the master switch at the top of the popup off.

After either action, Chrome immediately goes back to a direct connection.

## What this still can NOT change

- **TLS / SSL fingerprint of your connection (JA3/JA4)** — built from
  ClientHello fields that Chrome chooses; no extension API can rewrite
  them. Use Tor or a proxy that re-terminates TLS.
- **Your ISP's DNS logs of raw destination IPs** — handled by using
  SOCKS5 (DNS is resolved by the proxy) or encrypted DNS (DoH/DoT).

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
