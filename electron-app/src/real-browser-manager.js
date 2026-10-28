"use strict";

const { app } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const proxyBridge = require("./local-proxy-bridge");
const profileBackup = require("./profile-backup");
const fpExtension = require("./real-browser-fingerprint");
const browserStartup = require("./browser-startup");
const macChrome = require("./mac-browser-chrome");
const { acceptLanguagesFromLang } = require("./accept-languages");
const launches = new Map();

// "patched-chromium" = our bundled fingerprint-chromium (patched ungoogled-chromium).
// Per-profile device identity is driven by a --fingerprint seed at the C++ level
// (canvas/audio/font/clientrects noise + timezone + platform + brand/version + CPU
// cores), so two profiles = two different, seed-stable "physical PCs". It is NOT the
// user's installed Chrome/Brave. real-chrome/real-brave still launch the installed
// browser for users who want that.
const REAL_BROWSER_ENGINES = new Set(["real-chrome", "real-brave", "patched-chromium"]);
const running = new Map(); // profileId -> { child, pid, engine, dataDir, bridgeId, startedAt }
let changeHandler = null;

// Which fingerprint-chromium release we ship / fetch. Keep in sync with the seeded
// binary. Windows portable ZIP from the adryfish/fingerprint-chromium releases.
const PATCHED_VERSION = "148.0.7778.215-1.1";
// Macs get the same release's macOS .dmg (copied out as Chromium.app).
const IS_MAC = process.platform === "darwin";
const PATCHED_DIRNAME = `ungoogled-chromium_${PATCHED_VERSION}_${IS_MAC ? "macos" : "windows_x64"}`;
const PATCHED_ZIP = IS_MAC ? `ungoogled-chromium_${PATCHED_VERSION}_macos.dmg` : `ungoogled-chromium_${PATCHED_VERSION}_windows_x64.zip`;
const PATCHED_URL = `https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/${PATCHED_ZIP}`;

function isRealBrowserEngine(engine) {
  return REAL_BROWSER_ENGINES.has(String(engine || "").toLowerCase());
}

function isPatchedChromium(engine) {
  return String(engine || "").toLowerCase() === "patched-chromium";
}

// Whether this engine can load our per-profile fingerprint extension via
// --load-extension. Verified empirically: Brave and ungoogled-chromium
// (patched-chromium) load unpacked command-line extensions and run MAIN-world
// document_start scripts; Google Chrome stable (137+) has removed command-line
// extension loading, so it gets transport-only.
function engineSupportsExtensionSpoof(engine) {
  const e = String(engine || "").toLowerCase();
  return e === "real-brave" || e === "patched-chromium";
}

function browserNameForEngine(engine) {
  const e = String(engine || "").toLowerCase();
  if (e === "real-brave") return "brave";
  if (e === "patched-chromium") return "patched";
  return "chrome";
}

function labelForEngine(engine) {
  const e = String(engine || "").toLowerCase();
  if (e === "real-brave") return "Brave";
  if (e === "patched-chromium") return "Patched Chromium";
  return "Google Chrome";
}

// Location of the seeded patched-chromium binary under userData (fetched on first
// use, like the Camoufox engine — never bundled into the installer).
function patchedChromiumRoot() {
  return path.join(app.getPath("userData"), "fingerprint-chromium");
}
function patchedChromiumBinary() {
  if (!IS_MAC) return path.join(patchedChromiumRoot(), PATCHED_DIRNAME, "chrome.exe");
  const macos = path.join(patchedChromiumRoot(), PATCHED_DIRNAME, "Chromium.app", "Contents", "MacOS");
  let exe = "Chromium";
  try { exe = fs.readdirSync(macos).find((n) => !n.startsWith(".")) || exe; } catch (_) {}
  return path.join(macos, exe);
}
function patchedChromiumReady() {
  try { return fs.existsSync(patchedChromiumBinary()); } catch (_) { return false; }
}

// Stable 32-bit fingerprint seed for a profile: same profile → same seed → same
// device every launch; different profiles → different devices.
function fingerprintSeedFor(profile) {
  const src = String((profile && profile.fingerprint && profile.fingerprint.fingerprintSeed) || (profile && profile.id) || "seed");
  return require("./profile-store").fingerprintSeedInteger(src);
}

function setChangeHandler(fn) {
  changeHandler = typeof fn === "function" ? fn : null;
}

function notifyChanged() {
  try { if (changeHandler) changeHandler(); } catch (_) {}
}

function safeProfileId(profileId) {
  return String(profileId || "profile").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function dataRoot() {
  const dir = path.join(app.getPath("userData"), "real-browser-profiles");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function profileDataDir(profileId, engine) {
  const dir = path.join(dataRoot(), safeProfileId(profileId), browserNameForEngine(engine));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Remember that this profile needed software GL to show a window. The spoofed
// graphics name is not turned off. Clear-data removes the folder, so the next
// launch tries the normal path again.
function launchCompatPath(profileId) {
  return path.join(dataRoot(), safeProfileId(profileId), "patched-launch.json");
}

function gpuSpoofDisabled(profileId) {
  try {
    const data = JSON.parse(fs.readFileSync(launchCompatPath(profileId), "utf8"));
    return Boolean(data && data.disableGpuSpoof);
  } catch (_) {
    return false;
  }
}

function rememberGpuSpoofDisabled(profileId) {
  const file = launchCompatPath(profileId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ disableGpuSpoof: true }) + "\n", "utf8");
}

// The per-profile fingerprint extension lives beside (not inside) the user-data
// dir so Chrome never treats it as browsing data and a "clear data" wipe of the
// user-data dir doesn't delete it.
function fingerprintExtDir(profileId, engine) {
  const dir = path.join(dataRoot(), safeProfileId(profileId), browserNameForEngine(engine) + "-ps-fp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve the profile's full spoof config the same way the Electron engine does,
// so both engines stay coherent. Lazy require avoids any load-order coupling.
function resolveConfig(profile) {
  try {
    const store = require("./profile-store");
    if (typeof store.buildConfigFromProfile === "function") return store.buildConfigFromProfile(profile) || {};
  } catch (_) {}
  return {};
}

// Per-channel install locations. `channel` is "stable" | "beta" | "dev" | "canary"
// for Chrome, or "stable" | "beta" | "nightly" for Brave. Unknown → stable.
function chromeDirForChannel(channel) {
  switch (String(channel || "").toLowerCase()) {
    case "beta": return { win: ["Google", "Chrome Beta"], exe: "chrome.exe", mac: "Google Chrome Beta", nix: ["google-chrome-beta"] };
    case "dev": return { win: ["Google", "Chrome Dev"], exe: "chrome.exe", mac: "Google Chrome Dev", nix: ["google-chrome-unstable"] };
    case "canary": return { win: ["Google", "Chrome SxS"], exe: "chrome.exe", mac: "Google Chrome Canary", nix: ["google-chrome-canary"] };
    default: return { win: ["Google", "Chrome"], exe: "chrome.exe", mac: "Google Chrome", nix: ["google-chrome", "google-chrome-stable"] };
  }
}
function braveDirForChannel(channel) {
  switch (String(channel || "").toLowerCase()) {
    case "beta": return { win: ["BraveSoftware", "Brave-Browser-Beta"], exe: "brave.exe", mac: "Brave Browser Beta", nix: ["brave-browser-beta"] };
    case "nightly": return { win: ["BraveSoftware", "Brave-Browser-Nightly"], exe: "brave.exe", mac: "Brave Browser Nightly", nix: ["brave-browser-nightly"] };
    default: return { win: ["BraveSoftware", "Brave-Browser"], exe: "brave.exe", mac: "Brave Browser", nix: ["brave-browser", "brave"] };
  }
}

function candidatePaths(engine, channel) {
  const browser = browserNameForEngine(engine);
  const env = process.env;
  const pf = env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const spec = browser === "brave" ? braveDirForChannel(channel) : chromeDirForChannel(channel);
  const paths = [];

  if (process.platform === "win32") {
    for (const root of [pf, pf86, local]) {
      paths.push(path.join(root, ...spec.win, "Application", spec.exe));
    }
  } else if (process.platform === "darwin") {
    paths.push(`/Applications/${spec.mac}.app/Contents/MacOS/${spec.mac}`);
  } else {
    for (const name of spec.nix) { paths.push(name); paths.push(path.join("/usr/bin", name)); }
  }
  return paths;
}

function findExecutable(engine, channel) {
  if (isPatchedChromium(engine)) {
    const bin = patchedChromiumBinary();
    return { ok: patchedChromiumReady(), path: bin, channel: "patched", candidates: [bin] };
  }
  const candidates = candidatePaths(engine, channel);
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate)) {
        if (fs.existsSync(candidate)) return { ok: true, path: candidate, channel: channel || "stable", candidates };
      } else {
        return { ok: true, path: candidate, channel: channel || "stable", candidates };
      }
    } catch (_) {}
  }
  return { ok: false, channel: channel || "stable", candidates };
}

// Probe `<exe> --version` → "Google Chrome 131.0.6778.86" → "131.0.6778.86".
function getVersion(exePath) {
  return new Promise((resolve) => {
    if (!exePath) return resolve("");
    try {
      execFile(exePath, ["--version"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err) return resolve("");
        const m = String(stdout || "").match(/(\d+\.\d+\.\d+\.\d+)/);
        resolve(m ? m[1] : String(stdout || "").trim());
      });
    } catch (_) { resolve(""); }
  });
}

// Which channels of this engine are installed (for a UI picker). Sync existence
// check only — version is probed lazily via getVersion to keep this cheap.
function detectChannels(engine) {
  const browser = browserNameForEngine(engine);
  const channels = browser === "brave" ? ["stable", "beta", "nightly"] : ["stable", "beta", "dev", "canary"];
  const found = [];
  for (const channel of channels) {
    const exe = findExecutable(engine, channel);
    if (exe.ok && path.isAbsolute(exe.path) && fs.existsSync(exe.path)) found.push({ channel, path: exe.path });
    else if (exe.ok && !path.isAbsolute(exe.path)) found.push({ channel, path: exe.path, onPath: true });
  }
  return found;
}

function isRunningRecord(record) {
  return Boolean(record && record.child && record.child.exitCode == null && !record.child.killed);
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value === "about:blank") return value;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value)) return "https://" + value;
  return "";
}

function startUrls(profile, customUrl) {
  const urls = [];
  const first = normalizeUrl(customUrl);
  if (first) urls.push(first);
  if (!urls.length && profile && profile.session && Array.isArray(profile.session.tabs)) {
    for (const tab of profile.session.tabs) {
      const url = normalizeUrl(tab && tab.url);
      if (url) urls.push(url);
    }
  }
  if (!urls.length) urls.push("about:blank");
  return [...new Set(urls)].slice(0, 12);
}

function languageArg(profile) {
  const fp = (profile && profile.fingerprint) || {};
  // Auto language is resolved in buildConfigFromProfile (en-US, en-GB, …).
  // Do not invent "us-US" from the country code; that string is not a language.
  const manual = fp.language === "manual" && fp.languageValue ? String(fp.languageValue).trim() : "";
  return manual && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(manual) ? manual : "";
}

function sizeArgs(profile) {
  const fp = (profile && profile.fingerprint) || {};
  const width = Math.max(800, Math.min(3840, Number(fp.screenWidth) || 1280));
  const height = Math.max(600, Math.min(2160, Number(fp.screenHeight) || 800));
  return [`--window-size=${width},${height}`];
}

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeDeep(target, patch) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value);
    else out[key] = value;
  }
  return out;
}

function acceptLanguages(profile) {
  return acceptLanguagesFromLang(languageArg(profile));
}



function purgeCookieStore(dataDir) {
  const files = [
    ["Default", "Cookies"],
    ["Default", "Cookies-journal"],
    ["Default", "Network", "Cookies"],
    ["Default", "Network", "Cookies-journal"]
  ];
  for (const parts of files) {
    try { fs.rmSync(path.join(dataDir, ...parts), { force: true }); } catch (_) {}
  }
}

function writePrivacyPreferences(profile, dataDir) {
  const fp = (profile && profile.fingerprint) || {};
  const blockCookies = Boolean(fp.blockCookies);
  const defaultDir = path.join(dataDir, "Default");
  fs.mkdirSync(defaultDir, { recursive: true });
  if (blockCookies) purgeCookieStore(dataDir);
  const prefPath = path.join(defaultDir, "Preferences");
  const existing = readJsonFile(prefPath, {});
  const prefs = mergeDeep(existing, {
    browser: {
      check_default_browser: false
    },
    // Written both ways so turning Do Not Track off replaces an old true.
    enable_do_not_track: Boolean(fp.doNotTrack),
    // Chrome's own password manager IS the login vault. Hard-disabling these meant
    // the "Save password?" bubble never appeared in any profile, so logins were
    // never stored and accounts were lost. Forced on (not merge-preserved) so the
    // profiles created while it was off get fixed on their next launch.
    credentials_enable_service: true,
    profile: {
      password_manager_enabled: true,
      // 1 allows cookies, 2 blocks them. An old 2 must be replaced when the
      // profile is set back to allow, because a deep merge will not delete it.
      block_third_party_cookies: blockCookies,
      default_content_setting_values: {
        geolocation: 2,
        cookies: blockCookies ? 2 : 1
      }
    },
    intl: {
      accept_languages: acceptLanguagesFromLang((resolveConfig(profile) || {}).language || languageArg(profile))
    },
    webrtc: {
      ip_handling_policy: "disable_non_proxied_udp",
      multiple_routes_enabled: false,
      nonproxied_udp_enabled: false
    },
    safebrowsing: {
      enabled: true
    },
    autofill: {
      profile_enabled: false,
      credit_card_enabled: false
    }
  });
  fs.writeFileSync(prefPath, JSON.stringify(prefs, null, 2), "utf8");
}

function validExtensionPaths(profile) {
  const items = Array.isArray(profile && profile.extensions) ? profile.extensions : [];
  const paths = [];
  for (const item of items) {
    const extPath = path.resolve(String((item && item.path) || item || ""));
    if (!extPath || paths.includes(extPath)) continue;
    try {
      const stat = fs.statSync(extPath);
      if (stat.isDirectory() && fs.existsSync(path.join(extPath, "manifest.json"))) paths.push(extPath);
    } catch (_) {}
  }
  return paths;
}

function extensionArgs(profile) {
  return combinedExtensionArgs(profile, []);
}

// Merge the profile's user extensions with any manager-generated extensions (the
// fingerprint layer / Web Store helper). Only --load-extension: the old
// --disable-extensions-except switched OFF every extension the user installed
// from the Web Store inside the browser, on every launch.
function combinedExtensionArgs(profile, extraDirs) {
  const paths = validExtensionPaths(profile);
  for (const dir of (Array.isArray(extraDirs) ? extraDirs : [])) {
    const resolved = path.resolve(String(dir || ""));
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  if (!paths.length) return [];
  return [`--load-extension=${paths.join(",")}`];
}

// Bundled "Chromium Web Store" helper (vendor/, MIT). Ungoogled-chromium removes
// the Web Store install path; this extension restores the store's "Add" button
// and installs the CRX via the always-prompt-for-install flag. Its content
// scripts only match extension-store pages, so no other site sees it.
function webStoreHelperDir() {
  const dir = path.join(__dirname, "..", "vendor", "chromium-web-store").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : "";
}

function dnsLeakGuardArgs(px, proxyBridgeActive) {
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (mode !== "proxy" || !px.enabled) return [];
  const excludes = ["localhost", "127.0.0.1", "::1"];
  if (!proxyBridgeActive && px.host) excludes.push(String(px.host).trim());
  const unique = [...new Set(excludes.filter(Boolean))];
  return [`--host-resolver-rules=MAP * ~NOTFOUND, ${unique.map((host) => `EXCLUDE ${host}`).join(", ")}`];
}

async function proxyArgs(profile, options = {}) {
  const px = (profile && profile.proxy) || {};
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (mode !== "proxy" || !px.enabled) return { args: [], bridgeId: "" };
  if (!px.host || !px.port) {
    return { error: "Proxy is enabled but host/port are missing." };
  }

  const scheme = String(px.scheme || "http").toLowerCase();
  const port = Number(px.port) || 0;
  if (!port || port < 1 || port > 65535) return { error: "Proxy port is invalid." };

  const username = typeof options.expandProxyUsername === "function"
    ? options.expandProxyUsername(px.username || "")
    : (px.username || "");
  const password = px.password || "";
  const hasAuth = Boolean(username || password);
  let proxyServer = "";
  let bridgeId = "";

  if ((scheme === "http" || scheme === "https") && hasAuth) {
    bridgeId = "real-" + safeProfileId(profile.id);
    const local = await proxyBridge.getBridge(bridgeId, {
      scheme,
      host: px.host,
      port,
      username,
      password
    });
    if (!local) return { error: "Could not start local proxy bridge for authenticated proxy." };
    proxyServer = `http://127.0.0.1:${local.port}`;
  } else if (scheme === "http" || scheme === "https" || scheme === "socks4" || scheme === "socks5") {
    if (hasAuth && (scheme === "socks4" || scheme === "socks5")) {
      return { error: "Real Chrome/Brave mode does not support authenticated SOCKS proxies yet. Use an HTTP/HTTPS proxy for this mode." };
    }
    proxyServer = `${scheme}://${px.host}:${port}`;
  } else {
    return { error: `Unsupported proxy scheme for real browser mode: ${scheme}` };
  }

  const args = [`--proxy-server=${proxyServer}`, "--disable-quic"];
  const bypass = Array.isArray(px.bypassList) && px.bypassList.length
    ? px.bypassList.map((x) => String(x).trim()).filter(Boolean)
    : ["localhost", "127.0.0.1"];
  if (bypass.length) args.push(`--proxy-bypass-list=${bypass.join(";")}`);
  args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  args.push(...dnsLeakGuardArgs(px, Boolean(bridgeId)));
  return { args, bridgeId };
}

function showMacChrome(profile, pid) {
  try {
    if (!isPatchedChromium(profile && profile.engine)) return;
    if (!macChrome.wants(profile && profile.os) || !pid) return;
    macChrome.attach(pid).catch(() => {});
  } catch (_) {}
}

function cleanup(profileId, record) {
  if (running.get(profileId) !== record) return;
  running.delete(profileId);
  if (record && record.pid) {
    try { macChrome.detach(record.pid); } catch (_) {}
  }
  if (record && record.bridgeId) {
    try { proxyBridge.stopBridge(record.bridgeId); } catch (_) {}
  }
  if (record && record.ready && record.dataDir) profileBackup.backupInBackground(profileId, record.dataDir);
  notifyChanged();
}

// The brand flag was measured on this binary. Edge sends Chrome/148.0.0.0 plus
// Edg/148.0.7778.215. Brave sends a brave/ token that real Brave does not use,
// so Brave and Privacy Shield stay Chrome. A raw --user-agent blanks client-hint
// bitness, so a typed user-agent string is never passed.
function patchedBrowserBrand(profile) {
  const fp = (profile && profile.fingerprint) || {};
  const picked = String(fp.browser || (profile && profile.browserApp) || "chrome").toLowerCase();
  return picked === "edge" ? "Edge" : "Chrome";
}

function patchedPlatformVersion(profile, cfg) {
  const os = String((profile && profile.os) || "windows").toLowerCase();
  const family = os === "macos" || os === "ios" ? "macos" : os === "linux" ? "linux" : "windows";
  const version = cfg && cfg._platformVersion ? String(cfg._platformVersion) : "";
  if (!/^\d+\.\d+\.\d+$/.test(version) || family === "linux") return "";
  const windowsVersions = new Set(["10.0.0", "14.0.0", "15.0.0"]);
  const macVersions = new Set(["13.6.9", "14.5.0", "14.6.1", "15.1.1", "15.2.0"]);
  if (family === "windows" && !windowsVersions.has(version)) return "";
  if (family === "macos" && !macVersions.has(version)) return "";
  return version;
}

// fingerprint-chromium flags that turn the resolved profile config into a per-seed
// device identity at the C++ level. The fingerprint extension is not loaded:
// it made Google sign-in reject the browser. Geolocation stays blocked in prefs.
function patchedFingerprintArgs(profile, cfg) {
  const seed = fingerprintSeedFor(profile);
  const fp = (profile && profile.fingerprint) || {};
  const osMap = { windows: "windows", macos: "macos", linux: "linux", android: "windows", ios: "macos" };
  const platform = osMap[(profile && profile.os) || "windows"] || "windows";
  const args = [
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${platform}`
  ];
  args.push(`--fingerprint-brand=${patchedBrowserBrand(profile)}`);
  // This binary always reduces the User-Agent to Chrome/148.0.0.0. A stored
  // 146/150 pin, or a bare major, would make the client hint disagree with it.
  // The full build is the same for every profile on purpose: it is this binary.
  args.push(`--fingerprint-brand-version=${PATCHED_VERSION.split("-")[0]}`);
  const platformVersion = patchedPlatformVersion(profile, cfg);
  if (platformVersion) args.push(`--fingerprint-platform-version=${platformVersion}`);
  if (cfg && typeof cfg.hardwareConcurrency === "number") args.push(`--fingerprint-hardware-concurrency=${cfg.hardwareConcurrency}`);
  if (cfg && cfg.timezone && /^[A-Za-z]+\/[A-Za-z_+-]+/.test(cfg.timezone)) args.push(`--timezone=${cfg.timezone}`);
  // The engine's own font spoof hides the same faces on every seed. GPU spoof
  // stays on: disabling it shows this PC's graphics card. Stealth also turns
  // off canvas, audio, and client-rect noise, which is what that mode saves.
  const stealth = fp.spoofingLevel === "stealth" || Boolean(cfg && cfg._stealth);
  args.push(`--disable-spoofing=${stealth ? "font,canvas,audio,clientrects" : "font"}`);
  return { args, seed };
}

function launchProfile(profile, customUrl = "", options = {}) {
  const id = profile && profile.id;
  if (launches.has(id)) return launches.get(id);
  const launch = launchProfileOnce(profile, customUrl, options).finally(() => launches.delete(id));
  launches.set(id, launch);
  return launch;
}

function windowFailure(result) {
  return { ok: false, reason: result.reason || "window-missing", detail: result.detail ||
    (result.reason === "window-check-failed"
      ? "Windows could not verify the browser window. Check whether security software blocks PowerShell, then try Start again."
      : "Chromium started but did not open a visible window within 15 seconds. The stalled session was stopped. Try Start again; if it repeats, send support this message and your app version.") };
}

async function launchProfileOnce(profile, customUrl = "", options = {}) {
  if (!profile || !profile.id) return { ok: false, reason: "no-profile", detail: "Profile not found." };
  const engine = isRealBrowserEngine(profile.engine) ? profile.engine : "real-chrome";
  const channel = (profile.fingerprint && profile.fingerprint.browserChannel) || "stable";
  const existing = running.get(profile.id);
  if (isRunningRecord(existing)) {
    const restored = await browserStartup.restoreWindow(existing.pid);
    if (!restored.ok) {
      await closeProfile(profile.id);
      return windowFailure(restored);
    }
    showMacChrome(profile, existing.pid);
    return { ok: true, reused: true, pid: existing.pid, engine };
  }

  let exe = findExecutable(engine, channel);
  if (!exe.ok && channel !== "stable") exe = findExecutable(engine, "stable"); // fall back to stable
  if (!exe.ok) {
    if (isPatchedChromium(engine)) {
      return {
        ok: false,
        reason: "needs-engine-download",
        detail: "The Patched Chromium engine hasn't been downloaded yet (~190 MB). Download it, then click Start again.",
        engine
      };
    }
    return {
      ok: false,
      reason: "binary-missing",
      detail: `${labelForEngine(engine)} (${channel}) was not found on this PC.`,
      candidates: exe.candidates
    };
  }

  const proxy = await proxyArgs(profile, options);
  if (proxy.error) return { ok: false, reason: "proxy-unsupported", detail: proxy.error };

  // Resolve the full spoof config once (same resolver the Electron engine uses).
  const cfg = resolveConfig(profile);

  const dir = profileDataDir(profile.id, engine);
  await profileBackup.restoreIfNewer(profile.id, dir);
  writePrivacyPreferences(profile, dir);

  const patched = isPatchedChromium(engine);
  // GPU name spoofing stays on whenever --fingerprint is set. On a virtual
  // display the GPU process can still fail to show a window, so the retry uses
  // software GL only. A profile that already needed that skips the first start.
  const disableGpuSpoof = Boolean(options.disableGpuSpoof) || (patched && gpuSpoofDisabled(profile.id));

  // Generate the per-profile fingerprint extension. For patched-chromium the C++
  // engine already handles canvas/audio/font/navigator/timezone per seed, so the
  // extension only layers the WebGL renderer STRING + geolocation (gpuGeoOnly).
  // Failure is non-fatal: the browser still launches without the JS layer.
  const extraExtDirs = [];
  // The per-profile fingerprint extension (a MAIN-world, all_frames content script
  // loaded via --load-extension) makes Google sign-in reject the browser as "This
  // browser or app may not be secure". PROVEN by controlled A/B on the SAME clean
  // mobile IP: WITH the extension → rejected at Google's account-lookup step,
  // WITHOUT it → reached the password page. Google's browserinfo/integrity checks
  // run on mail.google.com + about:blank frames (where the auth-host exemption
  // can't match) and detect the injected overrides. For patched-chromium the C++
  // engine already noises canvas/audio/webgl-pixels/navigator/timezone/platform per
  // seed, so the extension only layered the WebGL renderer STRING + geolocation
  // (geolocation is blocked by prefs anyway) — not worth losing Google/Gmail over.
  // So the patched engine no longer loads it. real-brave, whose JS spoof depends on
  // the extension, still gets it (use patched-chromium for Google accounts).
  if (cfg && cfg.enabled !== false && engineSupportsExtensionSpoof(engine) && !patched) {
    const fpDir = fpExtension.writeExtension(profile.id, cfg, fingerprintExtDir(profile.id, engine), { gpuGeoOnly: patched, realBrowser: !patched });
    if (fpDir) extraExtDirs.push(fpDir);
  }

  if (patched) {
    const helper = webStoreHelperDir();
    if (helper) extraExtDirs.push(helper);
  }

  // Language: prefer the resolved config's coherent locale, fall back to the
  // profile's manual/auto language.
  const lang = (cfg && cfg.language) || languageArg(profile);

  const args = [
    `--user-data-dir=${dir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-sync",
    // Re-enable --load-extension: recent Chrome (137+) ships it disabled behind
    // DisableLoadExtensionCommandLineSwitch. Without this the fingerprint layer
    // silently never loads.
    "--disable-features=Translate,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--new-window",
    ...sizeArgs(profile),
    ...proxy.args,
    ...combinedExtensionArgs(profile, extraExtDirs)
  ];

  let patchedSeed = 0;
  if (patched) {
    // The C++ engine owns the device identity (seed) + UA brand/version. Do NOT
    // also pass --user-agent (that would desync the UA from the seeded platform).
    const fpArgs = patchedFingerprintArgs(profile, cfg);
    patchedSeed = fpArgs.seed;
    args.push(...fpArgs.args);
    args.push("--extension-mime-request-handling=always-prompt-for-install");
    // macOS: a fixed cookie key instead of the per-Mac Keychain one, so the
    // account backup restores logins on another Mac (and no Keychain prompt).
    if (IS_MAC) args.push("--use-mock-keychain");
    if (disableGpuSpoof) {
      // Software GL gets a window up on a virtual display. The spoofed graphics
      // name stays on: --fingerprint still supplies it, and --disable-spoofing=gpu
      // would show this PC's real graphics card.
      args.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
    }
    if (lang) { args.push(`--lang=${lang}`); args.push(`--accept-lang=${acceptLanguagesFromLang(lang)}`); }
  } else {
    // real-chrome / real-brave are GENUINE browsers: they derive User-Agent Client
    // Hints (Sec-CH-UA, Sec-CH-UA-Platform, full version list) and navigator.
    // userAgentData from the REAL OS + REAL browser version. A --user-agent flag
    // rewrites ONLY the UA string, so the Client Hints keep leaking the true OS and
    // version — e.g. UA says "Macintosh / Chrome 148" while Sec-CH-UA-Platform stays
    // "Windows" and Sec-CH-UA reports v150. Google's sign-in cross-checks the two
    // and rejects the contradiction as "this browser may not be secure"
    // (accounts.google.com/v3/signin/rejected). So we keep the browser's native,
    // fully-coherent UA/CH here and vary only the safely-spoofable signals
    // (canvas/WebGL/audio/timezone/geo/screen). Cross-OS or pinned-version identities
    // MUST use the patched-chromium engine, which sets platform + brand + version
    // coherently at the C++ level so UA, Client Hints, and navigator all agree.
    if (lang) { args.push(`--lang=${lang}`); args.push(`--accept-lang=${acceptLanguagesFromLang(lang)}`); }
  }
  args.push(...startUrls(profile, customUrl));

  // Timezone via the TZ env var: Chromium's ICU honors it on every platform,
  // giving a real zone with no detectable JS override.
  const spawnEnv = { ...process.env };
  const tz = cfg && cfg.timezone;
  if (tz && /^[A-Za-z]+\/[A-Za-z_+-]+/.test(tz)) spawnEnv.TZ = tz;

  let child;
  try {
    child = spawn(exe.path, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      env: spawnEnv
    });
  } catch (err) {
    if (proxy.bridgeId) {
      try { proxyBridge.stopBridge(proxy.bridgeId); } catch (_) {}
    }
    return { ok: false, reason: "launch-failed", detail: String(err && (err.message || err)) };
  }

  const record = { child, pid: child.pid, engine, channel: exe.channel, dataDir: dir, bridgeId: proxy.bridgeId, seed: patchedSeed, startedAt: Date.now() };
  running.set(profile.id, record);
  child.once("exit", () => cleanup(profile.id, record));
  child.once("error", () => cleanup(profile.id, record));
  const startup = await browserStartup.waitForWindow(child);
  if (!startup.ok) {
    if (running.get(profile.id) === record) await closeProfile(profile.id);
    // One retry, only when the process stayed up and never showed a window.
    // An early exit is a different failure and is not launched again.
    if (patched && !disableGpuSpoof && startup.reason === "window-missing") {
      return launchProfileOnce(profile, customUrl, Object.assign({}, options, { disableGpuSpoof: true }));
    }
    return windowFailure(startup);
  }
  if (!isRunningRecord(record)) return windowFailure({ reason: "launch-failed", detail: "Browser closed during startup. Try Start again." });
  if (disableGpuSpoof) {
    try { rememberGpuSpoofDisabled(profile.id); } catch (_) {}
  }
  record.ready = true;
  showMacChrome(profile, child.pid);
  notifyChanged();

  return { ok: true, pid: child.pid, engine, channel: exe.channel, dataDir: dir, browser: browserNameForEngine(engine), fingerprint: extraExtDirs.length > 0, seed: patchedSeed || undefined };
}

function taskkill(pid) {
  return new Promise((resolve) => {
    if (!pid || process.platform !== "win32") return resolve(false);
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve(true));
  });
}

async function closeProfile(profileId) {
  const record = running.get(profileId);
  if (!isRunningRecord(record)) {
    cleanup(profileId, record);
    return { ok: false, reason: "not-running" };
  }
  try { record.child.kill(); } catch (_) {}
  await taskkill(record.pid);
  cleanup(profileId, record);
  return { ok: true };
}

function isProfileRunning(profileId) {
  return isRunningRecord(running.get(profileId));
}

function runningIds() {
  const ids = [];
  for (const [id, record] of running.entries()) {
    if (isRunningRecord(record)) ids.push(id);
    else cleanup(id, record);
  }
  return ids;
}

function runningMap() {
  const out = {};
  for (const id of runningIds()) {
    const record = running.get(id);
    if (record && record.ready) out[id] = `real:${record.pid}`;
  }
  return out;
}

async function status(profileId, engine = "real-chrome", channel) {
  const exe = findExecutable(engine, channel);
  let version = "";
  if (exe.ok && path.isAbsolute(exe.path) && fs.existsSync(exe.path)) version = await getVersion(exe.path);
  return {
    ok: true,
    ready: exe.ok,
    running: profileId ? isProfileRunning(profileId) : false,
    path: exe.ok ? exe.path : "",
    channel: exe.channel,
    version,
    channels: detectChannels(engine),
    candidates: exe.candidates
  };
}

async function clearProfileData(profileId) {
  if (isProfileRunning(profileId)) return { ok: false, error: "Close the real browser for this profile first." };
  const root = dataRoot();
  const target = path.resolve(path.join(root, safeProfileId(profileId)));
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(resolvedRoot + path.sep)) return { ok: false, error: "Refused to clear data outside profile root." };
  await fs.promises.rm(target, { recursive: true, force: true });
  return { ok: true };
}

// ── Patched-chromium engine binary management (fetch-on-first-run) ───────────

function patchedStatus() {
  return {
    ok: true,
    ready: patchedChromiumReady(),
    version: PATCHED_VERSION,
    path: patchedChromiumBinary(),
    root: patchedChromiumRoot(),
    downloadUrl: PATCHED_URL
  };
}

let patchedFetchPromise = null;

// Download + extract the patched-chromium ZIP into userData. Idempotent and
// single-flight. Uses PowerShell Expand-Archive (Windows) so no zip dependency is
// bundled. onProgress(receivedBytes, totalBytes) is optional.
function fetchPatchedChromium(onProgress) {
  if (patchedChromiumReady()) return Promise.resolve({ ok: true, already: true, path: patchedChromiumBinary() });
  if (patchedFetchPromise) return patchedFetchPromise;
  patchedFetchPromise = (async () => {
    if (process.platform !== "win32" && !IS_MAC) {
      return { ok: false, error: "The patched-chromium engine ships Windows and macOS builds only." };
    }
    const https = require("https");
    const root = patchedChromiumRoot();
    fs.mkdirSync(root, { recursive: true });
    const zipPath = path.join(root, PATCHED_ZIP);

    const download = (url) => new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      const req = https.get(url, { headers: { "User-Agent": "PrivacyShield" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); file.close(); return download(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); file.close(); return reject(new Error("HTTP " + res.statusCode)); }
        const total = Number(res.headers["content-length"]) || 0;
        let got = 0;
        res.on("data", (c) => { got += c.length; if (typeof onProgress === "function") { try { onProgress(got, total); } catch (_) {} } });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      });
      req.on("error", (e) => { try { file.close(); } catch (_) {} reject(e); });
    });

    try {
      await download(PATCHED_URL);
    } catch (err) {
      try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
      patchedFetchPromise = null;
      return { ok: false, error: "Download failed: " + String(err && (err.message || err)) };
    }

    // Extract: PowerShell Expand-Archive on Windows, hdiutil + ditto on macOS.
    const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 300000 }, (err) => resolve(!err)));
    let extracted;
    if (IS_MAC) {
      const mnt = path.join(root, "mnt");
      fs.mkdirSync(mnt, { recursive: true });
      extracted = await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, zipPath]);
      if (extracted) {
        const appName = fs.readdirSync(mnt).find((n) => n.endsWith(".app")) || "";
        const dest = path.join(root, PATCHED_DIRNAME, "Chromium.app");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        extracted = Boolean(appName) && await run("ditto", [path.join(mnt, appName), dest]);
        await run("hdiutil", ["detach", mnt, "-force"]);
        if (extracted) await run("xattr", ["-dr", "com.apple.quarantine", dest]);
      }
    } else {
      extracted = await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${root}' -Force`]);
    }
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
    patchedFetchPromise = null;
    if (!extracted || !patchedChromiumReady()) {
      return { ok: false, error: "Extraction failed or binary missing after unzip." };
    }
    return { ok: true, path: patchedChromiumBinary() };
  })();
  return patchedFetchPromise;
}

// Read every cookie (logins) out of this profile's LOCAL native-browser data so
// they can be moved into its cloud copy. The engine itself is started headless on
// the profile's data dir and asked over DevTools — it decrypts its own cookie
// store, so this works for Brave/Chrome/Patched Chromium alike. The profile must
// not be open locally (Chromium locks its data dir).
async function exportProfileCookies(profile) {
  if (isProfileRunning(profile.id)) throw new Error("Close this profile's local browser first, then try again.");
  const engine = profile.engine;
  let exe = findExecutable(engine, (profile.fingerprint && profile.fingerprint.browserChannel) || "stable");
  if (!exe.ok) exe = findExecutable(engine, "stable");
  if (!exe.ok) throw new Error("The local browser for this profile isn't installed, so its logins can't be read.");
  const dir = profileDataDir(profile.id, engine);
  const portFile = path.join(dir, "DevToolsActivePort");
  try { fs.rmSync(portFile, { force: true }); } catch (_) {}
  const child = spawn(exe.path, [
    `--user-data-dir=${dir}`, "--profile-directory=Default", "--headless=new",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"
  ], { windowsHide: true, stdio: "ignore" });
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || 0; } catch (_) {}
    }
    if (!port) throw new Error("The local browser didn't start to read logins.");
    const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const cookies = await new Promise((resolve, reject) => {
      const ws = new WebSocket(ver.webSocketDebuggerUrl);
      const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("Reading cookies timed out.")); }, 20000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== 1) return;
        clearTimeout(t); try { ws.close(); } catch (_) {}
        m.error ? reject(new Error(m.error.message)) : resolve(m.result.cookies || []);
      };
      ws.onerror = () => { clearTimeout(t); reject(new Error("Couldn't talk to the local browser.")); };
    });
    return cookies;
  } finally {
    try { child.kill(); } catch (_) {}
  }
}

// What the cloud runner needs to launch this profile exactly like the local
// Patched Chromium: the same seeded fingerprint + locale flags and screen size.
// Storage, proxy, extensions and sandboxing are fixed by the cloud box itself.
function cloudLaunchSpec(profile, cfg) {
  // The live runner rejects any flag its allowlist does not name. Font control
  // is applied by the cloud image itself, so it is not sent from the PC.
  // The live runner rejects every --disable-spoofing value, including a combined
  // stealth list. Font control is applied by the cloud image itself.
  const args = patchedFingerprintArgs(profile, cfg).args.filter((arg) => !String(arg).startsWith("--disable-spoofing="));
  const lang = (cfg && cfg.language) || languageArg(profile);
  if (lang) args.push(`--lang=${lang}`, `--accept-lang=${acceptLanguagesFromLang(lang)}`);
  const fp = (profile && profile.fingerprint) || {};
  return {
    args,
    width: Math.max(800, Math.min(3840, Number(fp.screenWidth) || 1920)),
    height: Math.max(600, Math.min(2160, Number(fp.screenHeight) || 1080))
  };
}

module.exports = {
  patchedFingerprintArgs,
  cloudLaunchSpec,
  exportProfileCookies,
  isRealBrowserEngine,
  writePrivacyPreferences,
  isPatchedChromium,
  engineSupportsExtensionSpoof,
  browserNameForEngine,
  labelForEngine,
  setChangeHandler,
  launchProfile,
  closeProfile,
  isProfileRunning,
  runningIds,
  runningMap,
  status,
  detectChannels,
  getVersion,
  clearProfileData,
  fingerprintSeedFor,
  patchedChromiumReady,
  patchedChromiumBinary,
  patchedStatus,
  fetchPatchedChromium,
  PATCHED_VERSION
};
