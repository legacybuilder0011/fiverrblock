# Privacy Shield Browser Build Notes

Privacy Shield Browser is a branded Electron browser shell built on Chromium. It keeps automation-visible browser behavior intact and focuses on legitimate profile isolation, proxy/VPN routing, and coherent test identities.

## What This Build Customizes

- App identity: product name, window titles, start page, and tab strip branding.
- Profile identity: each started profile opens in Privacy Shield's own bundled Chromium runtime, with a profile-specific window title and generated taskbar icon.
- Session isolation: every profile uses its own persistent Electron session partition.
- Storage isolation: cookies, cache, service workers, localStorage, IndexedDB, and auth cache can be cleared per profile.
- Network routing: each profile can use direct routing, the computer's current VPN, or a saved VPS/proxy route.
- Leak reduction: Chromium is started with WebRTC non-proxied UDP disabled and local IP hiding enabled.
- Coherent identities: generated desktop and Android browser profiles keep user agent, UA client hints, OS, screen, DPR, touch points, GPU, font profile, CPU/RAM, timezone, language, and geolocation internally consistent.
- Mobile browser emulation: Android profiles enable mobile viewport metrics, touch emulation, coarse-pointer media queries, Android UA client hints, vibration API, and motion/orientation sensor events.
- Android Cloud Phones manager: provider-hosted Android devices can be registered with Android version, model, IMEI or hardware fingerprint, status, notes, and a remote console URL.
- Fingerprint consistency audit: the manager can check selected profile settings for OS, browser template, device class, screen, DPR, fonts, touch, language, timezone, geolocation, WebGL/GPU, and runtime consistency.

## What This Build Does Not Customize

- It does not hide automation controls.
- It does not patch Chromium/Blink to falsify `navigator.webdriver`.
- It does not remove headless or automation command-line switches.
- It does not include C++-level Chromium engine patches or an AI-generated daily fingerprint service.
- It does not ship a Firefox/Gecko engine. Firefox and Safari profile choices are browser identity templates only; active profile windows run on Electron's bundled Chromium.
- It does not provide residential proxies.
- It does not create or host real Android cloud phones by itself. Real phones must come from an external provider; Privacy Shield stores the records and opens the provider console.

## Build

```powershell
npm install
npm run build:win
```

The Windows installer and portable build are written to `dist/`.

## Development

```powershell
npm start
```

Restart the app after changing Chromium command-line switches in `src/main.js`.
