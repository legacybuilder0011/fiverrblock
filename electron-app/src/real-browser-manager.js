"use strict";

const { app } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const proxyBridge = require("./local-proxy-bridge");
const fpExtension = require("./real-browser-fingerprint");

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
const PATCHED_DIRNAME = `ungoogled-chromium_${PATCHED_VERSION}_windows_x64`;
const PATCHED_ZIP = `ungoogled-chromium_${PATCHED_VERSION}_windows_x64.zip`;
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
  return path.join(patchedChromiumRoot(), PATCHED_DIRNAME, "chrome.exe");
}
function patchedChromiumReady() {
  try { return fs.existsSync(patchedChromiumBinary()); } catch (_) { return false; }
}

// Stable 32-bit fingerprint seed for a profile: same profile → same seed → same
// device every launch; different profiles → different devices.
function fingerprintSeedFor(profile) {
  const src = String((profile && profile.fingerprint && profile.fingerprint.fingerprintSeed) || (profile && profile.id) || "seed");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  // Keep in [1, 2^31-1] so it's a positive int the flag parser accepts.
  return (h % 2147483646) + 1;
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
  const px = (profile && profile.proxy) || {};
  const manual = fp.language === "manual" && fp.languageValue ? String(fp.languageValue).trim() : "";
  const auto = px.detectedCountryCode ? `${String(px.detectedCountryCode).toLowerCase()}-${String(px.detectedCountryCode).toUpperCase()}` : "";
  const lang = manual || auto;
  return lang && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(lang) ? lang : "";
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

function acceptLanguagesFromLang(lang) {
  if (!lang) return "en-US,en";
  const primary = lang.split("-")[0];
  return primary && primary !== lang ? `${lang},${primary},en-US,en` : `${lang},en-US,en`;
}

function writePrivacyPreferences(profile, dataDir) {
  const defaultDir = path.join(dataDir, "Default");
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefPath = path.join(defaultDir, "Preferences");
  const existing = readJsonFile(prefPath, {});
  const prefs = mergeDeep(existing, {
    browser: {
      check_default_browser: false
    },
    credentials_enable_service: false,
    profile: {
      password_manager_enabled: false,
      default_content_setting_values: {
        geolocation: 2
      }
    },
    intl: {
      accept_languages: acceptLanguages(profile)
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
// fingerprint layer). `--disable-extensions-except` must list every extension we
// intend to keep enabled, or Chrome disables the ones not named.
function combinedExtensionArgs(profile, extraDirs) {
  const paths = validExtensionPaths(profile);
  for (const dir of (Array.isArray(extraDirs) ? extraDirs : [])) {
    const resolved = path.resolve(String(dir || ""));
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  if (!paths.length) return [];
  const joined = paths.join(",");
  return [
    `--disable-extensions-except=${joined}`,
    `--load-extension=${joined}`
  ];
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

function cleanup(profileId, record) {
  running.delete(profileId);
  if (record && record.bridgeId) {
    try { proxyBridge.stopBridge(record.bridgeId); } catch (_) {}
  }
  notifyChanged();
}

// fingerprint-chromium flags that turn the resolved profile config into a per-seed
// device identity at the C++ level. The GPU renderer STRING and geolocation are
// layered on via the extension (patched-chromium supports --load-extension).
function patchedFingerprintArgs(profile, cfg) {
  const seed = fingerprintSeedFor(profile);
  const osMap = { windows: "windows", macos: "macos", linux: "linux", android: "windows", ios: "macos" };
  const platform = osMap[(profile && profile.os) || "windows"] || "windows";
  const args = [
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${platform}`
  ];
  // Browser brand/version from the resolved UA version (fingerprint-chromium only
  // brands Chrome/Edge/Opera/Vivaldi — Brave isn't available, so stay Chrome).
  const brand = "Chrome";
  args.push(`--fingerprint-brand=${brand}`);
  if (cfg && cfg._uaVersion) args.push(`--fingerprint-brand-version=${cfg._uaVersion}`);
  if (cfg && cfg._platformVersion) args.push(`--fingerprint-platform-version=${cfg._platformVersion}`);
  if (cfg && typeof cfg.hardwareConcurrency === "number") args.push(`--fingerprint-hardware-concurrency=${cfg.hardwareConcurrency}`);
  if (cfg && cfg.timezone && /^[A-Za-z]+\/[A-Za-z_+-]+/.test(cfg.timezone)) args.push(`--timezone=${cfg.timezone}`);
  return { args, seed };
}

async function launchProfile(profile, customUrl = "", options = {}) {
  if (!profile || !profile.id) return { ok: false, reason: "no-profile", detail: "Profile not found." };
  const engine = isRealBrowserEngine(profile.engine) ? profile.engine : "real-chrome";
  const channel = (profile.fingerprint && profile.fingerprint.browserChannel) || "stable";
  const existing = running.get(profile.id);
  if (isRunningRecord(existing)) {
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
  writePrivacyPreferences(profile, dir);

  const patched = isPatchedChromium(engine);

  // Generate the per-profile fingerprint extension. For patched-chromium the C++
  // engine already handles canvas/audio/font/navigator/timezone per seed, so the
  // extension only layers the WebGL renderer STRING + geolocation (gpuGeoOnly).
  // Failure is non-fatal: the browser still launches without the JS layer.
  const extraExtDirs = [];
  if (cfg && cfg.enabled !== false && engineSupportsExtensionSpoof(engine)) {
    const fpDir = fpExtension.writeExtension(profile.id, cfg, fingerprintExtDir(profile.id, engine), { gpuGeoOnly: patched });
    if (fpDir) extraExtDirs.push(fpDir);
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
    if (lang) { args.push(`--lang=${lang}`); args.push(`--accept-lang=${acceptLanguagesFromLang(lang)}`); }
  } else {
    // User-agent via flag (not JS): also fixes worker/header UA, which JS cannot.
    if (cfg && cfg.spoofUA !== false && cfg.userAgent) args.push(`--user-agent=${cfg.userAgent}`);
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
    out[id] = record ? `real:${record.pid}` : "real";
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
    if (process.platform !== "win32") {
      return { ok: false, error: "The patched-chromium engine currently ships a Windows build only." };
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

    // Extract with PowerShell Expand-Archive.
    const extracted = await new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${root}' -Force`],
        { windowsHide: true, timeout: 300000 }, (err) => resolve(!err));
    });
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
    patchedFetchPromise = null;
    if (!extracted || !patchedChromiumReady()) {
      return { ok: false, error: "Extraction failed or binary missing after unzip." };
    }
    return { ok: true, path: patchedChromiumBinary() };
  })();
  return patchedFetchPromise;
}

module.exports = {
  isRealBrowserEngine,
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
