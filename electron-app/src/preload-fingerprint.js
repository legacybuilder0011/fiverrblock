// preload-fingerprint.js
// Runs in the MAIN world (contextIsolation: false) before any page scripts.
// Fetches the profile config via synchronous IPC, then applies all fingerprint
// overrides — same logic as content-main.js from the extension.

"use strict";

(function () {
  const { ipcRenderer } = require("electron");

  // ── Default config ──────────────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    blockCookies: false,
    spoofGeo: true,
    geo: { latitude: 40.7128, longitude: -74.006, accuracy: 50, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    spoofTimezone: true,
    timezone: "America/New_York",
    localeOffsetMinutes: 300,
    blockWebGL: true,
    blockCanvas: true,
    blockAudio: true,
    blockBattery: true,
    blockPlugins: true,
    blockFonts: true,
    blockScreen: true,
    blockHardware: true,
    blockStorage: false,
    spoofUA: true,
    rotateFingerprint: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    platform: "Win32",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 4,
    deviceMemory: 8,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 }
  };

  // ── Load profile config from main process ────────────────────────────────────
  let config = { ...DEFAULTS };
  try {
    const profileConfig = ipcRenderer.sendSync("GET_PROFILE_CONFIG");
    if (profileConfig && typeof profileConfig === "object") {
      config = Object.assign({}, DEFAULTS, profileConfig);
    }
  } catch (_) {}

  try {
    Object.defineProperty(window, "__privacyShieldProfile", {
      value: Object.freeze({
        profileId: config._profileId || "",
        profileName: config._profileName || "Profile",
        browser: config._browserApp || "chrome",
        os: config._uaOS || "Windows",
        deviceClass: config._deviceClass || "desktop",
        mobileModel: config._mobileModel || "",
        screen: config.screen ? `${config.screen.width || ""}x${config.screen.height || ""}` : "",
        timezone: config.timezone || "",
        language: config.language || ""
      }),
      configurable: false,
      enumerable: false
    });
  } catch (_) {}

  if (!config.enabled) return;

  // ── Stealth / per-site allowlist softening ───────────────────────────────────
  // Two routes turn off the "noisy" hardware-fingerprint layers (canvas, WebGL,
  // audio, screen, fonts, plugins, hardware, WebRTC) while KEEPING the passive
  // identity layer (UA, timezone, language, geo) that has to match the proxy IP:
  //   1. config._stealth === true     → whole profile runs minimal-spoof.
  //   2. config._spoofSkipHosts list  → only the listed hostnames run minimal.
  // The point is to present a native-Chromium hardware signature on sites with
  // aggressive bot detection (Google, Fiverr/PerimeterX, Cloudflare Turnstile),
  // where any JS-injected canvas/WebGL override is itself the thing that flags us.
  (function applySoftening() {
    const hostMatches = (host, list) => {
      if (!host || !Array.isArray(list) || !list.length) return false;
      const h = String(host).toLowerCase().replace(/^www\./, "");
      for (const raw of list) {
        const entry = String(raw || "").toLowerCase().trim().replace(/^\*?\.?/, "").replace(/^www\./, "");
        if (!entry) continue;
        if (h === entry || h.endsWith("." + entry)) return true;
      }
      return false;
    };
    let soften = config._stealth === true;
    let reason = soften ? "stealth" : "";
    try {
      if (!soften && hostMatches(location.hostname, config._spoofSkipHosts)) {
        soften = true;
        reason = "allowlist";
      }
    } catch (_) {}
    if (!soften) return;
    // Drop the detectable hardware-fingerprint overrides → real Chromium values.
    config.blockCanvas = false;
    config.blockWebGL = false;
    config.blockAudio = false;
    config.blockScreen = false;
    config.blockHardware = false;
    config.blockPlugins = false;
    config.blockFonts = false;
    config.blockBattery = false;
    // NOTE: WebRTC guard stays ON deliberately — native WebRTC would leak the
    // real IP behind the proxy, the fastest way to get a proxied session flagged.
    config._clientRects = "real";
    config._webgpu = true; // let native WebGPU through rather than faking absence
    // Keep spoofUA / spoofTimezone / spoofGeo ON: those must match the proxy IP
    // and carry no detectable JS-execution footprint once toString is cloaked.
    try {
      Object.defineProperty(window, "__privacyShieldSoftened", {
        value: reason, configurable: false, enumerable: false
      });
    } catch (_) {}
  })();

  // ── Deterministic noise ──────────────────────────────────────────────────────
  function seedToInt(value) {
    const text = String(value || "");
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  const NOISE_SEED = config._fingerprintSeed
    ? seedToInt(config._fingerprintSeed)
    : ((Math.random() * 0x7FFFFFFF) >>> 0);
  function stableNoise(index) {
    let h = (index + NOISE_SEED) | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const fakeNative = (fn, name) => {
    try {
      const nativeStr = "function " + (name || fn.name || "") + "() { [native code] }";
      Object.defineProperty(fn, "toString", { value: function () { return nativeStr; }, configurable: true, writable: true });
      Object.defineProperty(fn, "name", { value: name || fn.name || "", configurable: true });
    } catch (_) {}
    return fn;
  };

  try {
    const origFnToString = Function.prototype.toString;
    const fakeMap = new WeakMap();
    Function.prototype.toString = fakeNative(function toString() {
      if (fakeMap.has(this)) return fakeMap.get(this);
      return origFnToString.call(this);
    }, "toString");
    const registerFake = (fn, str) => { try { fakeMap.set(fn, str); } catch (_) {} };
    const regKey = "_" + Math.random().toString(36).slice(2, 8);
    Object.defineProperty(window, regKey, { value: registerFake, writable: false, enumerable: false, configurable: false });
  } catch (_) {}

  const defineRO = (obj, prop, value) => {
    try {
      const getter = function () { return typeof value === "function" ? value() : value; };
      fakeNative(getter, "get " + prop);
      Object.defineProperty(obj, prop, { get: getter, configurable: true });
    } catch (_) {}
  };

  const wrap = (target, prop, replacement) => {
    try {
      const original = target[prop];
      const replaced = replacement(original);
      target[prop] = replaced;
      fakeNative(replaced, prop);
    } catch (_) {}
  };

  const browserMajor = () => String(config._uaVersion || ((config.userAgent || "").match(/(?:Chrome|Edg|Firefox|Version)\/(\d+)/) || [])[1] || "150");
  const browserName = () => config._browserApp || (/Edg\//.test(config.userAgent || "") ? "edge" : /Firefox\//.test(config.userAgent || "") ? "firefox" : /Safari\//.test(config.userAgent || "") && !/Chrome\//.test(config.userAgent || "") ? "safari" : "chrome");
  const platformName = () => config._uaOS || (config.platform === "MacIntel" ? "macOS" : config.platform === "Linux x86_64" ? "Linux" : "Windows");
  const brandName = () => browserName() === "edge" ? "Microsoft Edge" : browserName() === "brave" ? "Brave" : browserName() === "privacy" ? "Privacy Shield Browser" : "Google Chrome";
  const vendorName = () => browserName() === "safari" ? "Apple Computer, Inc." : browserName() === "firefox" ? "" : "Google Inc.";

  // ── Automation markers: webdriver, CDP, Selenium/Puppeteer fingerprints ─────
  // Pixelscan, fp-collect, CreepJS, fingerprintjs all check navigator.webdriver
  // and several window-level automation markers. We attach Chromium DevTools
  // Protocol for fingerprint emulation, which flips navigator.webdriver = true
  // — the single biggest "you are a bot" signal in the wild. Override it here.
  try {
    // Use Navigator.prototype so descriptor lookups (getOwnPropertyDescriptor)
    // see a real getter, not just an own value on the instance.
    const wdGetter = function () { return false; };
    fakeNative(wdGetter, "get webdriver");
    Object.defineProperty(Navigator.prototype, "webdriver", { get: wdGetter, configurable: true, enumerable: true });
  } catch (_) {}
  // Selenium/Puppeteer/Playwright drop these on window. Real browsers never have them.
  // CRITICAL: only delete — do NOT redefine as a getter. Detectors check
  // `'callPhantom' in window` and `Object.getOwnPropertyDescriptor(window, "callPhantom")`,
  // both of which return TRUE if we defineProperty (even returning undefined).
  // A real browser has these names absent entirely.
  const AUTOMATION_MARKERS = [
    "cdc_adoQpoasnfa76pfcZLmcfl_Array", "cdc_adoQpoasnfa76pfcZLmcfl_Promise", "cdc_adoQpoasnfa76pfcZLmcfl_Symbol", "cdc_adoQpoasnfa76pfcZLmcfl_JSON", "cdc_adoQpoasnfa76pfcZLmcfl_Object", "cdc_adoQpoasnfa76pfcZLmcfl_Proxy",
    "__webdriver_evaluate", "__selenium_evaluate", "__webdriver_script_function", "__webdriver_script_func", "__webdriver_script_fn",
    "__fxdriver_evaluate", "__driver_unwrapped", "__webdriver_unwrapped", "__driver_evaluate", "__selenium_unwrapped", "__fxdriver_unwrapped",
    "_Selenium_IDE_Recorder", "_selenium", "calledSelenium", "$cdc_asdjflasutopfhvcZLmcfl_", "$chrome_asyncScriptInfo", "__$webdriverAsyncExecutor",
    "__nightmare", "_phantomas", "callPhantom", "_phantom", "phantom", "domAutomation", "domAutomationController"
  ];
  for (const marker of AUTOMATION_MARKERS) {
    try { delete window[marker]; } catch (_) {}
  }
  // Real Chrome has window.chrome with chrome.runtime, chrome.loadTimes etc.
  // Headless / heavily-locked-down Chromium misses these. Restore a minimal shim
  // so the "missing window.chrome.runtime" check passes.
  try {
    if (!window.chrome || typeof window.chrome !== "object") {
      Object.defineProperty(window, "chrome", { value: {}, writable: true, configurable: true });
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
        RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
        connect: fakeNative(function connect() { return undefined; }, "connect"),
        sendMessage: fakeNative(function sendMessage() { return undefined; }, "sendMessage")
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = fakeNative(function loadTimes() {
        return { requestTime: Date.now() / 1000 - 1, startLoadTime: Date.now() / 1000 - 0.5, commitLoadTime: Date.now() / 1000 - 0.3, finishDocumentLoadTime: Date.now() / 1000 - 0.1, finishLoadTime: Date.now() / 1000, firstPaintTime: Date.now() / 1000 - 0.2, firstPaintAfterLoadTime: 0, navigationType: "Other", wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: "h3", wasAlternateProtocolAvailable: false, connectionInfo: "h3" };
      }, "loadTimes");
    }
    if (!window.chrome.csi) {
      window.chrome.csi = fakeNative(function csi() {
        return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000, tran: 15 };
      }, "csi");
    }
  } catch (_) {}
  // fp-collect's "HEADCHR_PERMISSIONS" check: it compares Notification.permission
  // against permissions.query({name:"notifications"}).state. Real Chrome has them
  // match (both "default" / "granted" / "denied"). Our env reports
  // Notification.permission === "denied" but permissions API returns "prompt" —
  // classic headless signature. Force both to "default" and have query match.
  try {
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, "permission", { get: () => "default", configurable: true });
    }
  } catch (_) {}
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      const patchedQuery = fakeNative(function query(parameters) {
        if (parameters && parameters.name === "notifications") {
          return Promise.resolve({ state: "prompt", onchange: null });
        }
        return origQuery(parameters);
      }, "query");
      navigator.permissions.query = patchedQuery;
    }
  } catch (_) {}

  // ── Navigator spoofing ───────────────────────────────────────────────────────
  if (config.spoofUA) {
    defineRO(Navigator.prototype, "userAgent", () => config.userAgent);
    defineRO(Navigator.prototype, "appVersion", () => config.userAgent.replace(/^Mozilla\//, ""));
    defineRO(Navigator.prototype, "platform", () => config.platform);
    defineRO(Navigator.prototype, "vendor", () => vendorName());
    defineRO(Navigator.prototype, "oscpu", undefined);
    defineRO(Navigator.prototype, "productSub", "20030107");
    defineRO(Navigator.prototype, "language", () => config.language);
    defineRO(Navigator.prototype, "languages", () => Object.freeze(config.languages.slice()));

    const major = browserMajor();
    const os = platformName();
    const fullVersion = `${major}.0.0.0`;
    const fakeBrands = [
      { brand: "Not_A Brand", version: "8" },
      { brand: "Chromium", version: major },
      { brand: brandName(), version: major }
    ];
    const fakeFullBrands = [
      { brand: "Not_A Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: fullVersion },
      { brand: brandName(), version: fullVersion }
    ];
    const isMobile = Boolean(config._mobile);
    const platformVersion = config._platformVersion || (os === "macOS" ? "14.2.1" : os === "Android" ? "14" : os === "Linux" ? "6.5.0" : "15.0.0");
    const architecture = config._architecture || (isMobile ? "arm" : "x86");
    const bitness = config._bitness || "64";
    const mobileModel = isMobile ? (config._mobileModel || "") : "";
    if (browserName() === "firefox" || browserName() === "safari" || config._uaOS === "iOS") {
      defineRO(Navigator.prototype, "userAgentData", undefined);
    } else try {
      const uaData = {
        brands: fakeBrands,
        mobile: isMobile,
        platform: os,
        getHighEntropyValues(hints) {
          const data = {
            architecture,
            bitness,
            brands: fakeBrands,
            fullVersionList: fakeFullBrands,
            mobile: isMobile,
            model: mobileModel,
            platform: os,
            platformVersion,
            uaFullVersion: fullVersion,
            wow64: false
          };
          if (!Array.isArray(hints) || !hints.length) return Promise.resolve(data);
          return Promise.resolve(hints.reduce((out, hint) => {
            if (hint in data) out[hint] = data[hint];
            return out;
          }, { brands: fakeBrands, mobile: isMobile, platform: os }));
        },
        toJSON() { return { brands: fakeBrands, mobile: isMobile, platform: os }; }
      };
      const uaDataGetter = function () { return uaData; };
      fakeNative(uaDataGetter, "get userAgentData");
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: uaDataGetter, configurable: true });
      Object.defineProperty(navigator, "userAgentData", { get: uaDataGetter, configurable: true });
    } catch (_) {}

    if (browserName() === "brave") {
      try {
        Object.defineProperty(navigator, "brave", {
          get: () => ({ isBrave: fakeNative(() => Promise.resolve(true), "isBrave") }),
          configurable: true
        });
      } catch (_) {}
    }
  }

  // ── navigator.brave shim for Brave-identified profiles ──────────────────────
  // Brave's official detection: `navigator.brave.isBrave()` returns Promise<true>.
  // Brave intentionally keeps the UA identical to Chrome; sites that need to detect
  // Brave call this API. Expose it whenever the profile identity is Brave.
  if (browserName() === "brave") {
    try {
      const braveShim = Object.freeze({ isBrave: () => Promise.resolve(true) });
      defineRO(Navigator.prototype, "brave", braveShim);
    } catch (_) {}
  }

  // ── Hardware ─────────────────────────────────────────────────────────────────
  if (config.blockHardware) {
    defineRO(Navigator.prototype, "hardwareConcurrency", () => config.hardwareConcurrency);
    defineRO(Navigator.prototype, "deviceMemory", () => config.deviceMemory);
    defineRO(Navigator.prototype, "maxTouchPoints", () => Number(config._maxTouchPoints) || 0);
    try {
      const fakeConn = {
        effectiveType: "4g",
        downlink: Number(config._downlink) || 10,
        rtt: Number(config._rtt) || 50,
        saveData: false,
        type: config._connectionType || "wifi",
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; }
      };
      defineRO(Navigator.prototype, "connection", fakeConn);
      defineRO(Navigator.prototype, "mozConnection", fakeConn);
      defineRO(Navigator.prototype, "webkitConnection", fakeConn);
    } catch (_) {}
  }

  // ── Battery ──────────────────────────────────────────────────────────────────
  // Mobile browser runtime surface: touch APIs, coarse pointer media queries,
  // vibration, and Android-style motion/orientation events for mobile profiles.
  if (config._mobile || config._touchEmulation) {
    const maxTouchPoints = Math.max(1, Number(config._maxTouchPoints) || 5);
    const pointerType = config._pointerType || "coarse";
    const hoverType = config._hoverType || "none";
    const orientation = config._screenOrientation || "portrait-primary";

    try {
      const setTouchHandler = (obj, prop) => {
        if (!(prop in obj)) Object.defineProperty(obj, prop, { value: null, writable: true, configurable: true });
      };
      ["ontouchstart", "ontouchmove", "ontouchend", "ontouchcancel"].forEach((prop) => {
        setTouchHandler(window, prop);
        if (typeof Document !== "undefined") setTouchHandler(Document.prototype, prop);
        if (typeof HTMLElement !== "undefined") setTouchHandler(HTMLElement.prototype, prop);
      });
    } catch (_) {}

    try {
      if (typeof window.Touch !== "function") {
        class FakeTouch {
          constructor(init = {}) {
            this.identifier = Number(init.identifier) || 0;
            this.target = init.target || document;
            this.clientX = Number(init.clientX) || 0;
            this.clientY = Number(init.clientY) || 0;
            this.screenX = Number(init.screenX) || this.clientX;
            this.screenY = Number(init.screenY) || this.clientY;
            this.pageX = Number(init.pageX) || this.clientX;
            this.pageY = Number(init.pageY) || this.clientY;
            this.radiusX = Number(init.radiusX) || 11;
            this.radiusY = Number(init.radiusY) || 11;
            this.rotationAngle = Number(init.rotationAngle) || 0;
            this.force = Number(init.force) || 0.5;
          }
        }
        Object.defineProperty(window, "Touch", { value: FakeTouch, configurable: true });
      }
      if (typeof window.TouchEvent !== "function") {
        class FakeTouchEvent extends UIEvent {
          constructor(type, init = {}) {
            super(type, init);
            const freezeList = (items) => Object.freeze(Array.from(items || []));
            Object.defineProperty(this, "touches", { value: freezeList(init.touches), enumerable: true });
            Object.defineProperty(this, "targetTouches", { value: freezeList(init.targetTouches), enumerable: true });
            Object.defineProperty(this, "changedTouches", { value: freezeList(init.changedTouches), enumerable: true });
            Object.defineProperty(this, "altKey", { value: Boolean(init.altKey), enumerable: true });
            Object.defineProperty(this, "metaKey", { value: Boolean(init.metaKey), enumerable: true });
            Object.defineProperty(this, "ctrlKey", { value: Boolean(init.ctrlKey), enumerable: true });
            Object.defineProperty(this, "shiftKey", { value: Boolean(init.shiftKey), enumerable: true });
          }
        }
        Object.defineProperty(window, "TouchEvent", { value: FakeTouchEvent, configurable: true });
      }
    } catch (_) {}

    try {
      const originalMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
      const makeMql = (query, matches) => ({
        matches,
        media: String(query),
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; }
      });
      if (originalMatchMedia) {
        window.matchMedia = fakeNative(function matchMedia(query) {
          const q = String(query || "").toLowerCase();
          if (q.includes("pointer")) {
            if (q.includes("coarse")) return makeMql(query, pointerType === "coarse");
            if (q.includes("fine")) return makeMql(query, pointerType === "fine");
            if (q.includes("none")) return makeMql(query, pointerType === "none");
          }
          if (q.includes("hover")) {
            if (q.includes("none")) return makeMql(query, hoverType === "none");
            if (q.includes("hover")) return makeMql(query, hoverType === "hover");
          }
          if (q.includes("orientation")) {
            if (q.includes("portrait")) return makeMql(query, orientation.startsWith("portrait"));
            if (q.includes("landscape")) return makeMql(query, orientation.startsWith("landscape"));
          }
          return originalMatchMedia(query);
        }, "matchMedia");
      }
    } catch (_) {}

    // Vibrate: Android supports it, iOS Safari does not
    if (config._uaOS !== "iOS") {
      try {
        Navigator.prototype.vibrate = fakeNative(function vibrate(pattern) {
          return Array.isArray(pattern) || typeof pattern === "number";
        }, "vibrate");
      } catch (_) {}
    }
  }

  // ── iOS Safari platform quirks ────────────────────────────────────────────────
  if (config._uaOS === "iOS") {
    try {
      // Real iOS Safari exposes window.safari
      Object.defineProperty(window, "safari", { get: () => ({ pushNotification: Object.freeze({}) }), configurable: true });
    } catch (_) {}
    try {
      // iOS Safari does not support vibration — remove it
      delete Navigator.prototype.vibrate;
      defineRO(Navigator.prototype, "vibrate", undefined);
    } catch (_) {}
    try {
      // webkitGetUserMedia removed in modern iOS Safari
      delete navigator.webkitGetUserMedia;
    } catch (_) {}
  }

  if (config._sensorEmulation) {
    try {
      const motionBase = config._deviceMotion || {};
      const orientationBase = config._deviceOrientation || {};
      const makeMotionEvent = () => {
        const ev = new Event("devicemotion");
        const accel = motionBase.acceleration || { x: 0, y: 0, z: 0 };
        const accelG = motionBase.accelerationIncludingGravity || { x: 0.01, y: 0.02, z: 9.81 };
        const rotation = motionBase.rotationRate || { alpha: 0.02, beta: 0.01, gamma: 0.01 };
        Object.defineProperty(ev, "acceleration", { value: accel, enumerable: true });
        Object.defineProperty(ev, "accelerationIncludingGravity", { value: accelG, enumerable: true });
        Object.defineProperty(ev, "rotationRate", { value: rotation, enumerable: true });
        Object.defineProperty(ev, "interval", { value: Number(motionBase.interval) || 16, enumerable: true });
        return ev;
      };
      const makeOrientationEvent = () => {
        const ev = new Event("deviceorientation");
        Object.defineProperty(ev, "alpha", { value: Number(orientationBase.alpha) || 0, enumerable: true });
        Object.defineProperty(ev, "beta", { value: Number(orientationBase.beta) || 0, enumerable: true });
        Object.defineProperty(ev, "gamma", { value: Number(orientationBase.gamma) || 0, enumerable: true });
        Object.defineProperty(ev, "absolute", { value: Boolean(orientationBase.absolute), enumerable: true });
        return ev;
      };
      const addPermission = (Ctor) => {
        try {
          Object.defineProperty(Ctor, "requestPermission", {
            value: fakeNative(() => Promise.resolve("granted"), "requestPermission"),
            configurable: true
          });
        } catch (_) {}
      };
      if (typeof window.DeviceMotionEvent !== "function") {
        class FakeDeviceMotionEvent extends Event {}
        Object.defineProperty(window, "DeviceMotionEvent", { value: FakeDeviceMotionEvent, configurable: true });
      }
      if (typeof window.DeviceOrientationEvent !== "function") {
        class FakeDeviceOrientationEvent extends Event {}
        Object.defineProperty(window, "DeviceOrientationEvent", { value: FakeDeviceOrientationEvent, configurable: true });
      }
      addPermission(window.DeviceMotionEvent);
      addPermission(window.DeviceOrientationEvent);

      const motionListeners = new Set();
      const orientationListeners = new Set();
      const originalAdd = window.addEventListener;
      const originalRemove = window.removeEventListener;
      let sensorTimer = null;
      const emitSensors = () => {
        try {
          if (motionListeners.size) window.dispatchEvent(makeMotionEvent());
          if (orientationListeners.size) window.dispatchEvent(makeOrientationEvent());
        } catch (_) {}
      };
      const ensureTimer = () => {
        if (!sensorTimer) {
          sensorTimer = setInterval(emitSensors, 1000);
          setTimeout(emitSensors, 25);
        }
      };
      window.addEventListener = fakeNative(function addEventListener(type, listener, options) {
        if (type === "devicemotion" && typeof listener === "function") { motionListeners.add(listener); ensureTimer(); }
        if (type === "deviceorientation" && typeof listener === "function") { orientationListeners.add(listener); ensureTimer(); }
        return originalAdd.call(this, type, listener, options);
      }, "addEventListener");
      window.removeEventListener = fakeNative(function removeEventListener(type, listener, options) {
        if (type === "devicemotion") motionListeners.delete(listener);
        if (type === "deviceorientation") orientationListeners.delete(listener);
        return originalRemove.call(this, type, listener, options);
      }, "removeEventListener");
    } catch (_) {}
  }

  if (config.blockBattery) {
    // Mobile: realistic battery state (30-90% charge, sometimes discharging with 4-6h remaining)
    // Desktop: always plugged in at 100% (typical workstation behaviour)
    const _isMobBat = Boolean(config._mobile);
    const _charging  = _isMobBat ? (stableNoise(88) > 0.45) : true;
    const _level     = _isMobBat ? Math.round((0.30 + stableNoise(89) * 0.60) * 100) / 100 : 1;
    const _chgTime   = _charging  ? (_isMobBat ? Math.round(1800 + stableNoise(90) * 5400) : Infinity) : Infinity;
    const _dischTime = !_charging ? Math.round(10800 + stableNoise(91) * 10800) : Infinity;
    const fakeBattery = { charging: _charging, chargingTime: _chgTime, dischargingTime: _dischTime, level: _level, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    try {
      const patchedGetBattery = fakeNative(function getBattery() { return Promise.resolve(fakeBattery); }, "getBattery");
      Navigator.prototype.getBattery = patchedGetBattery;
    } catch (_) {}
    try { delete navigator.battery; defineRO(Navigator.prototype, "battery", undefined); } catch (_) {}
  }

  // ── Plugins / MIME types ──────────────────────────────────────────────────────
  if (config.blockPlugins) {
    if (config._mobile) {
      // Mobile Chrome/Safari expose zero plugins, but the OBJECT must still be a
      // PluginArray / MimeTypeArray instance — fp-collect checks instanceof.
      const emptyPlugins = Object.create(window.PluginArray ? window.PluginArray.prototype : Object.prototype);
      Object.defineProperty(emptyPlugins, "length", { value: 0, enumerable: true });
      emptyPlugins.item = fakeNative(function item() { return null; }, "item");
      emptyPlugins.namedItem = fakeNative(function namedItem() { return null; }, "namedItem");
      emptyPlugins.refresh = fakeNative(function refresh() {}, "refresh");
      emptyPlugins[Symbol.iterator] = function* () {};
      const emptyMimes = Object.create(window.MimeTypeArray ? window.MimeTypeArray.prototype : Object.prototype);
      Object.defineProperty(emptyMimes, "length", { value: 0, enumerable: true });
      emptyMimes.item = fakeNative(function item() { return null; }, "item");
      emptyMimes.namedItem = fakeNative(function namedItem() { return null; }, "namedItem");
      emptyMimes[Symbol.iterator] = function* () {};
      defineRO(Navigator.prototype, "plugins", () => emptyPlugins);
      defineRO(Navigator.prototype, "mimeTypes", () => emptyMimes);
      defineRO(Navigator.prototype, "pdfViewerEnabled", false);
    } else {
      // navigator.plugins MUST be `instanceof PluginArray` and each item must be
      // `instanceof Plugin` for fp-collect/bot.sannysoft to recognize them as
      // real. Plain objects with the right shape FAIL the instanceof check.
      // Build with Object.create(PluginArray.prototype) + indexed properties.
      const pdfMime = Object.create(window.MimeType ? window.MimeType.prototype : Object.prototype);
      Object.defineProperties(pdfMime, {
        type: { value: "application/pdf", enumerable: true },
        suffixes: { value: "pdf", enumerable: true },
        description: { value: "Portable Document Format", enumerable: true },
        // MUST be configurable: it's redefined below to point back at each Plugin.
        // Without this the redefine threw "Cannot redefine property: enabledPlugin",
        // an uncaught error that aborted the ENTIRE preload — killing timezone,
        // screen, canvas, WebGL and audio spoofing (every hardware fingerprint).
        enabledPlugin: { value: null, enumerable: true, configurable: true }
      });
      const pluginNames = [
        "PDF Viewer",
        "Chrome PDF Viewer",
        "Chromium PDF Viewer",
        "Microsoft Edge PDF Viewer",
        "WebKit built-in PDF"
      ];
      const fakePluginList = pluginNames.map((name) => {
        const p = Object.create(window.Plugin ? window.Plugin.prototype : Object.prototype);
        Object.defineProperties(p, {
          name: { value: name, enumerable: true },
          filename: { value: "internal-pdf-viewer", enumerable: true },
          description: { value: "Portable Document Format", enumerable: true },
          length: { value: 1, enumerable: true }
        });
        p[0] = pdfMime;
        Object.defineProperty(pdfMime, "enabledPlugin", { value: p, configurable: true });
        p.item = fakeNative(function item(i) { return i === 0 ? pdfMime : null; }, "item");
        p.namedItem = fakeNative(function namedItem(n) { return n === "application/pdf" ? pdfMime : null; }, "namedItem");
        return p;
      });
      const pluginsObj = Object.create(window.PluginArray ? window.PluginArray.prototype : Object.prototype);
      Object.defineProperty(pluginsObj, "length", { value: fakePluginList.length, enumerable: true });
      fakePluginList.forEach((p, i) => {
        Object.defineProperty(pluginsObj, i, { value: p, enumerable: true });
        Object.defineProperty(pluginsObj, p.name, { value: p });
      });
      pluginsObj.item = fakeNative(function item(i) { return fakePluginList[i] || null; }, "item");
      pluginsObj.namedItem = fakeNative(function namedItem(n) { return fakePluginList.find((p) => p.name === n) || null; }, "namedItem");
      pluginsObj.refresh = fakeNative(function refresh() {}, "refresh");
      pluginsObj[Symbol.iterator] = function* () { for (const p of fakePluginList) yield p; };

      const mimesObj = Object.create(window.MimeTypeArray ? window.MimeTypeArray.prototype : Object.prototype);
      Object.defineProperty(mimesObj, "length", { value: 1, enumerable: true });
      Object.defineProperty(mimesObj, 0, { value: pdfMime, enumerable: true });
      Object.defineProperty(mimesObj, "application/pdf", { value: pdfMime });
      mimesObj.item = fakeNative(function item(i) { return i === 0 ? pdfMime : null; }, "item");
      mimesObj.namedItem = fakeNative(function namedItem(n) { return n === "application/pdf" ? pdfMime : null; }, "namedItem");
      mimesObj[Symbol.iterator] = function* () { yield pdfMime; };

      defineRO(Navigator.prototype, "plugins", () => pluginsObj);
      defineRO(Navigator.prototype, "mimeTypes", () => mimesObj);
      defineRO(Navigator.prototype, "pdfViewerEnabled", true);
    }
  }

  // ── Fonts ─────────────────────────────────────────────────────────────────────
  if (config.blockFonts) {
    const _fontSet = new Set((Array.isArray(config._fontList) ? config._fontList : []).map((f) => String(f).toLowerCase()));
    const _fontAllowed = (spec) => { const s = String(spec || "").toLowerCase(); for (const f of _fontSet) { if (f && s.includes(f)) return true; } return false; };
    try {
      if (document.fonts) {
        document.fonts.check = fakeNative(function check(fontSpec) { return _fontAllowed(fontSpec); }, "check");
        // Patch load() — sites call fonts.load("12px FontName") to probe availability
        document.fonts.load = fakeNative(function load() { return Promise.resolve([]); }, "load");
        document.fonts.ready = Promise.resolve(document.fonts);
        document.fonts.forEach = fakeNative(function forEach() {}, "forEach");
        document.fonts.values = fakeNative(function* values() {}, "values");
        document.fonts.keys = fakeNative(function* keys() {}, "keys");
        document.fonts.entries = fakeNative(function* entries() {}, "entries");
        try { document.fonts.has = fakeNative(function has() { return false; }, "has"); } catch (_) {}
        Object.defineProperty(document.fonts, "size", { get: () => 0, configurable: true });
      }
    } catch (_) {}
    // FontFace constructor — intercept load() so per-family probing respects the whitelist
    try {
      if (typeof window.FontFace === "function") {
        const OrigFF = window.FontFace;
        function SpoofedFontFace(family, source, descriptors) {
          const face = new OrigFF(family, source, descriptors);
          const ok = _fontAllowed(String(family || ""));
          Object.defineProperty(face, "load", { value: fakeNative(function load() { return ok ? Promise.resolve(face) : Promise.reject(new DOMException("Font not in profile", "NetworkError")); }, "load"), configurable: true, writable: true });
          return face;
        }
        SpoofedFontFace.prototype = OrigFF.prototype;
        fakeNative(SpoofedFontFace, "FontFace");
        window.FontFace = SpoofedFontFace;
      }
    } catch (_) {}
  }

  // ── Screen ───────────────────────────────────────────────────────────────────
  if (config.blockScreen) {
    const s = config.screen;
    defineRO(Screen.prototype, "width", () => s.width);
    defineRO(Screen.prototype, "height", () => s.height);
    defineRO(Screen.prototype, "availWidth", () => s.availWidth);
    defineRO(Screen.prototype, "availHeight", () => s.availHeight);
    defineRO(Screen.prototype, "colorDepth", () => Number(config._colorDepth) || s.colorDepth);
    defineRO(Screen.prototype, "pixelDepth", () => Number(config._pixelDepth) || s.pixelDepth);
    defineRO(Screen.prototype, "availLeft", 0);
    defineRO(Screen.prototype, "availTop", 0);
    try { defineRO(window, "devicePixelRatio", Number(config._devicePixelRatio) || 1); } catch (_) {}
    try {
      if (screen.orientation) {
        const orientation = config._screenOrientation || (config._mobile ? "portrait-primary" : "landscape-primary");
        defineRO(screen.orientation, "type", orientation);
        defineRO(screen.orientation, "angle", orientation.startsWith("portrait") ? 0 : 0);
      }
    } catch (_) {}
  }

  // ── Timezone ─────────────────────────────────────────────────────────────────
  // Multiple surfaces have to agree, or pixelscan/CreepJS flag "timezone spoofed":
  //   - Intl.DateTimeFormat().resolvedOptions().timeZone
  //   - Date.prototype.getTimezoneOffset()
  //   - Date.prototype.toString() (includes the GMT offset + tz name)
  //   - Date.prototype.toTimeString() (same)
  //   - Date.prototype.toLocaleString() (uses DTF under the hood, OK once DTF is fixed)
  if (config.spoofTimezone) {
    const fakeTZ = config.timezone || "UTC";
    const offsetMin = Number(config.localeOffsetMinutes) || 0;
    try {
      const OriginalDTF = Intl.DateTimeFormat;
      const OriginalResolved = OriginalDTF.prototype.resolvedOptions;
      const patchedResolved = fakeNative(function resolvedOptions() {
        const r = OriginalResolved.call(this);
        r.timeZone = fakeTZ;
        return r;
      }, "resolvedOptions");
      OriginalDTF.prototype.resolvedOptions = patchedResolved;
    } catch (_) {}
    // Derive the offset LIVE from the spoofed IANA zone, per-date, so it stays
    // DST-correct and always agrees with resolvedOptions().timeZone. A static
    // offset (the old behaviour) was wrong for non-Eastern zones and for half
    // the year on any DST zone — the single most reliable timezone-spoof tell.
    const offsetForDate = (function () {
      let probe;
      try {
        probe = new Intl.DateTimeFormat("en-US", { timeZone: fakeTZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch (_) { probe = null; }
      return function (date) {
        if (!probe) return offsetMin;
        try {
          const p = probe.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
          const asUTC = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
          return Math.round((date.getTime() - asUTC) / 60000);
        } catch (_) { return offsetMin; }
      };
    })();
    try {
      const patchedOffset = fakeNative(function getTimezoneOffset() {
        const d = this instanceof Date ? this : new Date();
        return offsetForDate(d);
      }, "getTimezoneOffset");
      Date.prototype.getTimezoneOffset = patchedOffset;
    } catch (_) {}
    // Rebuild Date.toString output using DateTimeFormat under the spoofed zone
    // so "Mon May 19 2026 23:30:00 GMT-0500 (Central Daylight Time)" stays consistent.
    try {
      const tzAbbrFromName = (name) => {
        try {
          const dtf = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "short" });
          const parts = dtf.formatToParts(new Date());
          const tzPart = parts.find((p) => p.type === "timeZoneName");
          return tzPart ? tzPart.value : "UTC";
        } catch (_) { return "UTC"; }
      };
      const tzLongFromName = (name) => {
        try {
          const dtf = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "long" });
          const parts = dtf.formatToParts(new Date());
          const tzPart = parts.find((p) => p.type === "timeZoneName");
          return tzPart ? tzPart.value : "Coordinated Universal Time";
        } catch (_) { return "Coordinated Universal Time"; }
      };
      // GMT offset string is per-date (DST-aware) and matches getTimezoneOffset.
      const offsetStrForDate = (date) => {
        const off = offsetForDate(date instanceof Date ? date : new Date());
        const sign = off <= 0 ? "+" : "-";
        const abs = Math.abs(off);
        const hh = String(Math.floor(abs / 60)).padStart(2, "0");
        const mm = String(abs % 60).padStart(2, "0");
        return `GMT${sign}${hh}${mm}`;
      };
      const tzAbbr = tzAbbrFromName(fakeTZ);
      const tzLong = tzLongFromName(fakeTZ);
      const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: fakeTZ, weekday: "short", month: "short", day: "2-digit", year: "numeric" });
      const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: fakeTZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const patchedToString = fakeNative(function toString() {
        try {
          const d = this;
          const dParts = fmtDate.formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
          const tParts = fmtTime.formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
          return `${dParts.weekday} ${dParts.month} ${dParts.day} ${dParts.year} ${tParts.hour}:${tParts.minute}:${tParts.second} ${offsetStrForDate(d)} (${tzLong})`;
        } catch (_) { return Date.prototype.toUTCString.call(this); }
      }, "toString");
      const patchedToTimeString = fakeNative(function toTimeString() {
        try {
          const tParts = fmtTime.formatToParts(this).reduce((a, p) => (a[p.type] = p.value, a), {});
          return `${tParts.hour}:${tParts.minute}:${tParts.second} ${offsetStrForDate(this)} (${tzLong})`;
        } catch (_) { return ""; }
      }, "toTimeString");
      const patchedToDateString = fakeNative(function toDateString() {
        try {
          const dParts = fmtDate.formatToParts(this).reduce((a, p) => (a[p.type] = p.value, a), {});
          return `${dParts.weekday} ${dParts.month} ${dParts.day} ${dParts.year}`;
        } catch (_) { return ""; }
      }, "toDateString");
      Date.prototype.toString = patchedToString;
      Date.prototype.toTimeString = patchedToTimeString;
      Date.prototype.toDateString = patchedToDateString;
    } catch (_) {}
  }

  // ── Geolocation ───────────────────────────────────────────────────────────────
  if (config.spoofGeo && navigator.geolocation) {
    const buildPosition = () => {
      const g = config.geo || DEFAULTS.geo;
      return { coords: { latitude: Number(g.latitude), longitude: Number(g.longitude), accuracy: Number(g.accuracy) || 50, altitude: g.altitude, altitudeAccuracy: g.altitudeAccuracy, heading: g.heading, speed: g.speed }, timestamp: Date.now() };
    };
    try {
      navigator.geolocation.getCurrentPosition = function (success, error, _opts) { try { if (typeof success === "function") success(buildPosition()); } catch (_) { if (typeof error === "function") error({ code: 2, message: "POSITION_UNAVAILABLE" }); } };
      let watchCount = 0;
      navigator.geolocation.watchPosition = function (success, _error, _opts) { const id = ++watchCount; setTimeout(() => { try { if (typeof success === "function") success(buildPosition()); } catch (_) {} }, 0); return id; };
      navigator.geolocation.clearWatch = function () {};
    } catch (_) {}
  }

  // ── Canvas ────────────────────────────────────────────────────────────────────
  if (config.blockCanvas) {
    const noiseAndRead = (canvas, ctx, origFn, args) => {
      const w = canvas.width, h = canvas.height;
      if (!w || !h || !ctx) return origFn.apply(canvas, args);
      const imgData = ctx.getImageData(0, 0, w, h);
      const backup = new Uint8ClampedArray(imgData.data);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) { if (stableNoise(i) < 0.01) d[i] ^= 1; if (stableNoise(i + 1) < 0.01) d[i + 1] ^= 1; if (stableNoise(i + 2) < 0.01) d[i + 2] ^= 1; }
      ctx.putImageData(imgData, 0, 0);
      const result = origFn.apply(canvas, args);
      const restore = ctx.createImageData(w, h); restore.data.set(backup); ctx.putImageData(restore, 0, 0);
      return result;
    };
    wrap(HTMLCanvasElement.prototype, "toDataURL", (orig) => function (...args) { try { const ctx = this.getContext("2d"); if (ctx) return noiseAndRead(this, ctx, orig, args); } catch (_) {} return orig.apply(this, args); });
    wrap(HTMLCanvasElement.prototype, "toBlob", (orig) => function (cb, ...rest) { try { const ctx = this.getContext("2d"); if (ctx) { const w = this.width, h = this.height; if (w && h) { const imgData = ctx.getImageData(0, 0, w, h); const backup = new Uint8ClampedArray(imgData.data); const d = imgData.data; for (let i = 0; i < d.length; i += 4) { if (stableNoise(i) < 0.01) d[i] ^= 1; if (stableNoise(i + 1) < 0.01) d[i + 1] ^= 1; if (stableNoise(i + 2) < 0.01) d[i + 2] ^= 1; } ctx.putImageData(imgData, 0, 0); const r = orig.call(this, cb, ...rest); const restore = ctx.createImageData(w, h); restore.data.set(backup); ctx.putImageData(restore, 0, 0); return r; } } } catch (_) {} return orig.call(this, cb, ...rest); });
    wrap(CanvasRenderingContext2D.prototype, "getImageData", (orig) => function (...args) { const imgData = orig.apply(this, args); try { const d = imgData.data; for (let i = 0; i < d.length; i += 4) { if (stableNoise(i) < 0.005) d[i] ^= 1; if (stableNoise(i + 1) < 0.005) d[i + 1] ^= 1; if (stableNoise(i + 2) < 0.005) d[i + 2] ^= 1; } } catch (_) {} return imgData; });
    // OffscreenCanvas — used by headless fingerprinting scripts; apply same noise
    try {
      if (typeof OffscreenCanvas !== "undefined" && OffscreenCanvas.prototype) {
        const _applyOffNoise = (ctx, w, h) => { if (!ctx || !w || !h) return null; try { const d = ctx.getImageData(0, 0, w, h); const bk = new Uint8ClampedArray(d.data); for (let i = 0; i < d.data.length; i += 4) { if (stableNoise(i) < 0.01) d.data[i] ^= 1; if (stableNoise(i + 1) < 0.01) d.data[i + 1] ^= 1; if (stableNoise(i + 2) < 0.01) d.data[i + 2] ^= 1; } ctx.putImageData(d, 0, 0); return bk; } catch (_) { return null; } };
        const _restoreOff = (ctx, w, h, bk) => { try { if (!bk || !ctx) return; const rr = ctx.createImageData(w, h); rr.data.set(bk); ctx.putImageData(rr, 0, 0); } catch (_) {} };
        wrap(OffscreenCanvas.prototype, "convertToBlob", (orig) => function (...args) { const ctx = this.getContext("2d"); const bk = _applyOffNoise(ctx, this.width, this.height); const r = orig.apply(this, args); _restoreOff(ctx, this.width, this.height, bk); return r; });
        wrap(OffscreenCanvas.prototype, "transferToImageBitmap", (orig) => function () { const ctx = this.getContext("2d"); const bk = _applyOffNoise(ctx, this.width, this.height); const r = orig.call(this); _restoreOff(ctx, this.width, this.height, bk); return r; });
      }
    } catch (_) {}
  }

  // ── WebGL ──────────────────────────────────────────────────────────────────────
  if (config.blockWebGL) {
    const NORMALIZED_EXTENSIONS = ["ANGLE_instanced_arrays","EXT_blend_minmax","EXT_color_buffer_half_float","EXT_disjoint_timer_query","EXT_float_blend","EXT_frag_depth","EXT_shader_texture_lod","EXT_texture_compression_bptc","EXT_texture_compression_rgtc","EXT_texture_filter_anisotropic","EXT_sRGB","KHR_parallel_shader_compile","OES_element_index_uint","OES_fbo_render_mipmap","OES_standard_derivatives","OES_texture_float","OES_texture_float_linear","OES_texture_half_float","OES_texture_half_float_linear","OES_vertex_array_object","WEBGL_color_buffer_float","WEBGL_compressed_texture_s3tc","WEBGL_compressed_texture_s3tc_srgb","WEBGL_debug_renderer_info","WEBGL_debug_shaders","WEBGL_depth_texture","WEBGL_draw_buffers","WEBGL_lose_context","WEBGL_multi_draw"];
    const neuter = (proto) => {
      if (!proto) return;
      wrap(proto, "getParameter", (orig) => function (p) {
        const _isIOS = config._uaOS === "iOS";
        // UNMASKED_VENDOR/RENDERER (37445/37446): iOS/WebKit never exposes these
        if (p === 37445) return _isIOS ? null : (config._gpuVendor || "Google Inc. (Intel)");
        if (p === 37446) return _isIOS ? null : (config._gpuRenderer || "ANGLE (Intel, Intel(R) UHD Graphics, OpenGL 4.1)");
        if (p === 7936) return "WebKit";
        if (p === 7937) return "WebKit WebGL";
        if (p === 7938) return "WebGL 1.0 (OpenGL ES 2.0 Chromium)";
        if (p === 35724) return "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)";
        return orig.call(this, p);
      });
      wrap(proto, "getExtension", (orig) => function (name) {
        // Desktop Chrome EXPOSES WEBGL_debug_renderer_info; returning the real ext
        // (whose UNMASKED_* constants 37445/37446 the getParameter override maps to
        // the per-profile spoofed GPU) mimics Chrome AND makes the reported GPU
        // differ across profiles. Only iOS/WebKit truly lacks it.
        if (name === "WEBGL_debug_renderer_info" && config._uaOS === "iOS") return null;
        return orig.call(this, name);
      });
      wrap(proto, "getSupportedExtensions", (orig) => function () { return NORMALIZED_EXTENSIONS.slice(); });
      wrap(proto, "readPixels", (orig) => function (...args) { const r = orig.apply(this, args); try { const buf = args[6]; if (buf && buf.length) for (let i = 0; i < buf.length; i += 4) if (stableNoise(i) < 0.002) buf[i] ^= 1; } catch (_) {} return r; });
    };
    if (typeof WebGLRenderingContext !== "undefined") neuter(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") neuter(WebGL2RenderingContext.prototype);
  }

  // ── Audio ──────────────────────────────────────────────────────────────────────
  if (config.blockAudio) {
    const noiseArr = (arr) => { try { for (let i = 0; i < arr.length; i++) arr[i] = arr[i] + (stableNoise(i) - 0.5) * 1e-7; } catch (_) {} };
    if (typeof AnalyserNode !== "undefined") {
      wrap(AnalyserNode.prototype, "getFloatFrequencyData", (orig) => function (arr) { orig.call(this, arr); noiseArr(arr); });
      wrap(AnalyserNode.prototype, "getByteFrequencyData", (orig) => function (arr) { orig.call(this, arr); for (let i = 0; i < arr.length; i++) if (stableNoise(i) < 0.01) arr[i] = (arr[i] ^ 1) & 0xff; });
      wrap(AnalyserNode.prototype, "getFloatTimeDomainData", (orig) => function (arr) { orig.call(this, arr); noiseArr(arr); });
    }
    if (typeof AudioBuffer !== "undefined") {
      wrap(AudioBuffer.prototype, "getChannelData", (orig) => function (...args) { const data = orig.apply(this, args); try { for (let i = 0; i < data.length; i += 500) data[i] = data[i] + (stableNoise(i) - 0.5) * 1e-7; } catch (_) {} return data; });
      wrap(AudioBuffer.prototype, "copyFromChannel", (orig) => function (dest, ...rest) { orig.call(this, dest, ...rest); try { for (let i = 0; i < dest.length; i += 500) dest[i] = dest[i] + (stableNoise(i) - 0.5) * 1e-7; } catch (_) {} });
    }
  }

  // ── Do Not Track ─────────────────────────────────────────────────────────────
  // â”€â”€ Speech voices / timing / storage / cookies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    if (window.speechSynthesis) {
      const winVoices = [
        { name: "Microsoft David - English (United States)", lang: config.language || "en-US", voiceURI: "Microsoft David - English (United States)", localService: true, default: true },
        { name: "Microsoft Zira - English (United States)", lang: config.language || "en-US", voiceURI: "Microsoft Zira - English (United States)", localService: true, default: false },
        { name: "Microsoft Mark - English (United States)", lang: config.language || "en-US", voiceURI: "Microsoft Mark - English (United States)", localService: true, default: false }
      ];
      const macVoices = [
        { name: "Alex", lang: config.language || "en-US", voiceURI: "com.apple.speech.synthesis.voice.Alex", localService: true, default: true },
        { name: "Samantha", lang: config.language || "en-US", voiceURI: "com.apple.speech.synthesis.voice.samantha", localService: true, default: false },
        { name: "Victoria", lang: config.language || "en-US", voiceURI: "com.apple.speech.synthesis.voice.victoria", localService: true, default: false }
      ];
      const linuxVoices = [
        { name: "English United States", lang: config.language || "en-US", voiceURI: "English United States", localService: true, default: true }
      ];
      window.speechSynthesis.getVoices = function () {
        const os = platformName();
        const voices = (os === "macOS" || os === "iOS") ? macVoices : os === "Linux" ? linuxVoices : winVoices;
        return voices.map((voice) => ({ ...voice }));
      };
      fakeNative(window.speechSynthesis.getVoices, "getVoices");
    }
  } catch (_) {}

  try {
    const origNow = performance.now.bind(performance);
    performance.now = function () { return Math.round(origNow() * 10) / 10; };
    fakeNative(performance.now, "now");
  } catch (_) {}

  if (config.blockStorage) {
    const blockStorage = (storage) => {
      try {
        const proto = Object.getPrototypeOf(storage);
        proto.setItem = fakeNative(function setItem() {}, "setItem");
        proto.getItem = fakeNative(function getItem() { return null; }, "getItem");
        proto.removeItem = fakeNative(function removeItem() {}, "removeItem");
        proto.clear = fakeNative(function clear() {}, "clear");
        proto.key = fakeNative(function key() { return null; }, "key");
        Object.defineProperty(proto, "length", { get: () => 0, configurable: true });
      } catch (_) {}
    };
    blockStorage(window.localStorage);
    blockStorage(window.sessionStorage);
    try {
      if (window.indexedDB) {
        window.indexedDB.open = fakeNative(function open() {
          const req = {};
          setTimeout(() => {
            try {
              req.error = new Error("indexedDB disabled");
              if (typeof req.onerror === "function") req.onerror({ target: req });
            } catch (_) {}
          }, 0);
          return req;
        }, "open");
      }
    } catch (_) {}
    try {
      if (window.caches) {
        window.caches.open = fakeNative(() => Promise.reject(new Error("caches disabled")), "open");
        window.caches.keys = fakeNative(() => Promise.resolve([]), "keys");
        window.caches.match = fakeNative(() => Promise.resolve(undefined), "match");
        window.caches.has = fakeNative(() => Promise.resolve(false), "has");
        window.caches.delete = fakeNative(() => Promise.resolve(false), "delete");
      }
    } catch (_) {}
  }

  if (config.blockCookies) {
    try {
      Object.defineProperty(Document.prototype, "cookie", {
        get: fakeNative(function getCookie() { return ""; }, "get cookie"),
        set: fakeNative(function setCookie() { return true; }, "set cookie"),
        configurable: true
      });
    } catch (_) {}
  }

  try { defineRO(Navigator.prototype, "doNotTrack", config._doNotTrack ? "1" : "0"); } catch (_) {}

  // ── ClientRects noise ─────────────────────────────────────────────────────────
  if (config._clientRects === "noise") {
    const noiseRect = (orig) => { const noise = (stableNoise(Math.round((orig.top + orig.left) * 100)) - 0.5) * 0.2; return { top: orig.top + noise, left: orig.left + noise, right: orig.right + noise, bottom: orig.bottom + noise, width: orig.width, height: orig.height, x: (orig.x != null ? orig.x : orig.left) + noise, y: (orig.y != null ? orig.y : orig.top) + noise, toJSON() { return { top: this.top, left: this.left, right: this.right, bottom: this.bottom, width: this.width, height: this.height, x: this.x, y: this.y }; } }; };
    try { wrap(Element.prototype, "getBoundingClientRect", (orig) => function () { return noiseRect(orig.call(this)); }); wrap(Range.prototype, "getBoundingClientRect", (orig) => function () { return noiseRect(orig.call(this)); }); wrap(Element.prototype, "getClientRects", (orig) => function () { return Array.from(orig.call(this)).map(noiseRect); }); wrap(Range.prototype, "getClientRects", (orig) => function () { return Array.from(orig.call(this)).map(noiseRect); }); } catch (_) {}
  }

  // ── WebGPU ────────────────────────────────────────────────────────────────────
  try { if (config._webgpu === false && typeof navigator.gpu !== "undefined") defineRO(Navigator.prototype, "gpu", undefined); } catch (_) {}

  // ── Media Devices (manual counts) ─────────────────────────────────────────────
  if (config._mediaDevices === "manual" && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const gs = NOISE_SEED.toString(16).padStart(16, "0");
      const devs = [];
      for (let i = 0; i < Math.max(0, Number(config._microphones) || 1); i++) devs.push({ deviceId: "default", kind: "audioinput", label: "", groupId: gs + "m" + i });
      for (let i = 0; i < Math.max(0, Number(config._speakers) || 1); i++) devs.push({ deviceId: "default", kind: "audiooutput", label: "", groupId: gs + "s" + i });
      for (let i = 0; i < Math.max(0, Number(config._cameras) || 1); i++) devs.push({ deviceId: (NOISE_SEED ^ (0xCAFE + i)).toString(16).padStart(16, "0"), kind: "videoinput", label: "", groupId: gs + "c" + i });
      navigator.mediaDevices.enumerateDevices = function () { return Promise.resolve(devs.map((d) => ({ ...d }))); };
      fakeNative(navigator.mediaDevices.enumerateDevices, "enumerateDevices");
    } catch (_) {}
  }

  // ── WebSocket port blocking ───────────────────────────────────────────────────
  if (config._ports === "block" && Array.isArray(config._blockedPorts) && config._blockedPorts.length) {
    try {
      const blockedPorts = new Set(config._blockedPorts.map(Number).filter(Boolean));
      const OrigWS = window.WebSocket;
      function BlockedWebSocket(url, ...rest) { try { const u = new URL(url); const port = Number(u.port) || (u.protocol === "wss:" ? 443 : 80); if (blockedPorts.has(port)) { const dummy = Object.create(OrigWS.prototype); Object.assign(dummy, { readyState: 3, url, bufferedAmount: 0, extensions: "", protocol: "", binaryType: "blob" }); setTimeout(() => { try { dummy.dispatchEvent(new Event("error")); } catch (_) {} try { dummy.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "blocked" })); } catch (_) {} }, 0); return dummy; } } catch (_) {} return new OrigWS(url, ...rest); }
      BlockedWebSocket.prototype = OrigWS.prototype;
      BlockedWebSocket.CONNECTING = 0; BlockedWebSocket.OPEN = 1; BlockedWebSocket.CLOSING = 2; BlockedWebSocket.CLOSED = 3;
      fakeNative(BlockedWebSocket, "WebSocket");
      window.WebSocket = BlockedWebSocket;
    } catch (_) {}
  }

  // ── WebRTC leak guard ─────────────────────────────────────────────────────────
  try {
    if (typeof RTCPeerConnection !== "undefined" && config._webrtcMode !== "real") {
      const OrigRTC = window.RTCPeerConnection;
      const isLeakyCandidate = (cand) => { if (!cand) return false; const c = typeof cand === "string" ? cand : cand.candidate; if (!c) return false; return /(\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b)|(\b(?:\d{1,3}\.){3}\d{1,3}\b(?!.*relay).*typ\s+srflx)/.test(c); };
      // Rewriting is active in manual mode, and in "altered" mode when we have an
      // exit IP to show (auto-filled from the VPN/proxy detection). When active,
      // leaky candidates are REWRITTEN to the exit IP (so WebRTC reports the same
      // public IP as the visible connection) instead of being dropped. It is
      // never the real IP. Without an exit IP, altered mode falls back to dropping.
      const _wrCanRewrite = (config._webrtcMode === "manual" || config._webrtcMode === "altered") && !!config._webrtcIP;
      const _wrShouldDrop = (cand) => isLeakyCandidate(cand) && config._webrtcMode !== "manual" && !_wrCanRewrite;
      const rewriteCandidate = (candidate) => {
        if (!_wrCanRewrite || !candidate) return candidate;
        const replace = (text) => String(text).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, config._webrtcIP);
        if (typeof candidate === "string") return replace(candidate);
        try { return new RTCIceCandidate({ ...candidate.toJSON(), candidate: replace(candidate.candidate) }); } catch (_) { return candidate; }
      };
      if (config._webrtcMode === "off") {
        const blockedRTC = function RTCPeerConnection() { throw new DOMException("WebRTC disabled", "NotSupportedError"); };
        fakeNative(blockedRTC, "RTCPeerConnection");
        window.RTCPeerConnection = blockedRTC;
        window.webkitRTCPeerConnection = blockedRTC;
        return;
      }
      const patchedRTC = function (cfg, ...rest) {
        if (cfg && (config._webrtcMode === "altered" || config._webrtcMode === "no-udp")) {
          cfg = { ...cfg, iceServers: config._webrtcMode === "no-udp" ? (cfg.iceServers || []) : [], iceTransportPolicy: config._webrtcMode === "no-udp" ? "relay" : cfg.iceTransportPolicy };
        }
        const pc = new OrigRTC(cfg, ...rest);
        const origAddEventListener = pc.addEventListener.bind(pc);
        pc.addEventListener = function (type, handler, ...opts) { if (type === "icecandidate") { return origAddEventListener(type, (ev) => { if (ev && ev.candidate && _wrShouldDrop(ev.candidate)) return; if (ev && ev.candidate) { try { Object.defineProperty(ev, "candidate", { value: rewriteCandidate(ev.candidate), configurable: true }); } catch (_) {} } handler(ev); }, ...opts); } return origAddEventListener(type, handler, ...opts); };
        const origSet = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "onicecandidate");
        if (origSet) { Object.defineProperty(pc, "onicecandidate", { set(fn) { origSet.set.call(pc, fn ? (ev) => { if (ev && ev.candidate && _wrShouldDrop(ev.candidate)) return; if (ev && ev.candidate) { try { Object.defineProperty(ev, "candidate", { value: rewriteCandidate(ev.candidate), configurable: true }); } catch (_) {} } fn(ev); } : fn); }, get() { return origSet.get.call(pc); }, configurable: true }); }
        return pc;
      };
      patchedRTC.prototype = OrigRTC.prototype;
      ["CONNECTING","OPEN","CLOSING","CLOSED","generateCertificate"].forEach((k) => { if (OrigRTC[k] !== undefined) patchedRTC[k] = OrigRTC[k]; });
      fakeNative(patchedRTC, "RTCPeerConnection");
      window.RTCPeerConnection = patchedRTC;
      window.webkitRTCPeerConnection = patchedRTC;
    }
  } catch (_) {}

  // ── Layer 4: Behavioral mimicry ───────────────────────────────────────────────

  // Reduce event.timeStamp precision to 1 ms — prevents sub-millisecond timing
  // fingerprinting used to distinguish machine-generated from human input.
  try {
    const _tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp");
    if (_tsDesc && _tsDesc.get) {
      Object.defineProperty(Event.prototype, "timeStamp", {
        get: fakeNative(function timeStamp() { return Math.round(_tsDesc.get.call(this)); }, "get timeStamp"),
        configurable: true
      });
    }
  } catch (_) {}

  // window.__humanize — automation API for human-like interaction.
  // Normal manual browsing is unaffected; scripts call these helpers to avoid
  // bot-detection on click/type/scroll patterns.
  try {
    const _hSleep  = (ms) => new Promise((r) => setTimeout(r, ms));
    const _hRand   = (lo, hi) => lo + Math.random() * (hi - lo);

    // Cubic Bezier path between two screen points with random control points
    const _hBezier = (x1, y1, x2, y2, steps) => {
      const cp1x = x1 + _hRand(0.2, 0.5) * (x2 - x1) + _hRand(-80, 80);
      const cp1y = y1 + _hRand(0.1, 0.4) * (y2 - y1) + _hRand(-80, 80);
      const cp2x = x1 + _hRand(0.5, 0.8) * (x2 - x1) + _hRand(-60, 60);
      const cp2y = y1 + _hRand(0.5, 0.9) * (y2 - y1) + _hRand(-60, 60);
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        pts.push({
          x: u*u*u*x1 + 3*u*u*t*cp1x + 3*u*t*t*cp2x + t*t*t*x2,
          y: u*u*u*y1 + 3*u*u*t*cp1y + 3*u*t*t*cp2y + t*t*t*y2
        });
      }
      return pts;
    };

    const _hMouse = (type, el, x, y, extra = {}) => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y,
        screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
        movementX: _hRand(-1, 1), movementY: _hRand(-1, 1),
        ...extra
      }));
    };

    // Simulate a human click: scroll into view → Bezier mouse path → mousedown/up/click
    const humanClick = async (el) => {
      if (!el) throw new Error("humanClick: element required");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await _hSleep(_hRand(250, 550));
      const r = el.getBoundingClientRect();
      const tx = r.left + r.width  / 2 + _hRand(-4, 4);
      const ty = r.top  + r.height / 2 + _hRand(-4, 4);
      const sx = _hRand(0, window.innerWidth);
      const sy = _hRand(0, window.innerHeight);
      for (const pt of _hBezier(sx, sy, tx, ty, Math.round(_hRand(10, 22)))) {
        _hMouse("mousemove", document.documentElement, pt.x, pt.y);
        await _hSleep(_hRand(8, 24));
      }
      _hMouse("mouseover",  el, tx, ty);
      _hMouse("mouseenter", el, tx, ty);
      await _hSleep(_hRand(40, 120));
      _hMouse("mousedown", el, tx, ty, { buttons: 1, button: 0 });
      await _hSleep(_hRand(30, 90));
      _hMouse("mouseup",   el, tx, ty, { buttons: 0, button: 0 });
      _hMouse("click",     el, tx, ty);
      await _hSleep(_hRand(50, 150));
    };

    // Simulate human typing: 60-180 ms per key, 8% chance of 400-900 ms pause
    const humanType = async (el, text, opts = {}) => {
      if (!el || text == null) throw new Error("humanType: element and text required");
      const lo = opts.minDelay ?? 60, hi = opts.maxDelay ?? 180;
      el.focus();
      await _hSleep(_hRand(120, 380));
      for (const ch of String(text)) {
        const kInit = { key: ch, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown",  kInit));
        el.dispatchEvent(new KeyboardEvent("keypress", kInit));
        if ("value" in el) {
          const s = el.selectionStart ?? el.value.length;
          const e2 = el.selectionEnd ?? s;
          el.value = el.value.slice(0, s) + ch + el.value.slice(e2);
          el.selectionStart = el.selectionEnd = s + 1;
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        el.dispatchEvent(new KeyboardEvent("keyup", kInit));
        await _hSleep(Math.random() < 0.08 ? _hRand(400, 900) : _hRand(lo, hi));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // Simulate human scroll with sine-eased deceleration
    const humanScroll = async (opts = {}) => {
      const dist  = opts.distance  ?? _hRand(200, 500);
      const dir   = opts.direction ?? "down";
      const steps = Math.round(_hRand(6, 14));
      for (let i = 0; i < steps; i++) {
        const ease = Math.sin((i / steps) * Math.PI);
        window.scrollBy({ top: (dir === "down" ? 1 : -1) * (dist / steps) * (0.4 + ease * 0.6), behavior: "auto" });
        await _hSleep(_hRand(20, 55));
      }
    };

    Object.defineProperty(window, "__humanize", {
      value: Object.freeze({ click: humanClick, type: humanType, scroll: humanScroll, sleep: _hSleep }),
      configurable: false, enumerable: false, writable: false
    });
  } catch (_) {}

})();
