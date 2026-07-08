"use strict";

// real-browser-fingerprint.js
// Generates a per-profile, unpacked MV3 extension that applies the profile's
// fingerprint spoof INSIDE real installed Chrome / Brave. Chrome is launched
// with `--load-extension=<dir>`; the extension declares a MAIN-world,
// document_start content script (`fp.js`) that overrides canvas / WebGL / audio /
// navigator / screen / geolocation before page scripts run.
//
// This is the real-browser counterpart to src/preload-fingerprint.js (which runs
// as an Electron preload). It consumes the SAME resolved config object produced by
// profile-store.buildConfigFromProfile(profile), so a profile behaves coherently
// whichever engine launches it.
//
// Deliberately NOT covered here (done natively at launch, which is stronger and
// undetectable): user-agent (`--user-agent` flag → also fixes workers + request
// headers), timezone (`TZ` env var → real ICU zone, no JS tell), WebRTC/DNS
// (Chrome flags). navigator.platform still needs a JS override because the UA flag
// does not set it.
//
// Injection ceiling (be honest): MAIN-world content scripts do not run inside Web
// Workers, and there is a sub-millisecond race vs. the first inline page script on
// some sites. There is NO CDP/debugger attach, so none of the automation tells the
// bundled Electron engine carries.

const fs = require("fs");
const path = require("path");

// MV3 declarative `world: "MAIN"` content scripts require Chrome/Brave 111+.
const MIN_CHROME_MAJOR = 111;

// The static spoof body. `__PS_CFG__` is replaced with the per-profile JSON at
// generation time so no config ever lives on `window` (nothing for a page to read
// back). Keep this string self-contained — it runs in the page's own world with no
// access to extension or Node APIs.
const SPOOF_BODY = String.raw`"use strict";
(function () {
  var CFG = __PS_CFG__;
  if (!CFG || CFG.enabled === false) return;

  // ── Captcha / bot-challenge frame exemption ───────────────────────────────
  // Arkose, hCaptcha, reCAPTCHA, Turnstile, DataDome, GeeTest, PerimeterX run
  // canvas/WebGL integrity checks and refuse to paint when they detect overrides
  // in their OWN frame. Leave those frames 100% native (the top page still spoofs).
  try {
    var host = (location && location.hostname || "").toLowerCase();
    var pathName = (location && location.pathname || "").toLowerCase();
    var CAPTCHA = ["arkoselabs.com","arkose.com","funcaptcha.com","hcaptcha.com","hcaptcha.net",
      "recaptcha.net","challenges.cloudflare.com","captcha-delivery.com","geetest.com","geetest.net",
      "px-cdn.net","px-cloud.net","perimeterx.net","pxchk.net","px-cloud.com"];
    for (var ci = 0; ci < CAPTCHA.length; ci++) {
      var d = CAPTCHA[ci];
      if (host === d || (host.length > d.length && host.slice(-(d.length + 1)) === "." + d)) return;
    }
    if (((/(^|\.)google\.com$/.test(host)) || (/(^|\.)gstatic\.com$/.test(host))) && pathName.indexOf("/recaptcha") !== -1) return;
    // Per-profile skip-host allowlist (visit these with a native signature).
    var skip = CFG.spoofSkipHosts || [];
    for (var si = 0; si < skip.length; si++) {
      var s = String(skip[si] || "").toLowerCase().replace(/^\*?\.?/, "");
      if (!s) continue;
      if (host === s || (host.length > s.length && host.slice(-(s.length + 1)) === "." + s)) return;
    }
  } catch (_) {}

  // ── Native-code cloak ─────────────────────────────────────────────────────
  var patched = new WeakSet();
  var natToString = Function.prototype.toString;
  function cloak(fn, name) {
    try { patched.add(fn); if (name) fn.__pn = name; } catch (_) {}
    return fn;
  }
  try {
    var tsOverride = function toString() {
      if (patched.has(this)) {
        var nm = this.__pn || (this.name || "");
        return "function " + nm + "() { [native code] }";
      }
      return natToString.call(this);
    };
    Object.defineProperty(tsOverride, "__pn", { value: "toString" });
    patched.add(tsOverride);
    Function.prototype.toString = tsOverride;
  } catch (_) {}

  function def(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { get: cloak(getter, "get " + prop), configurable: true, enumerable: true });
    } catch (_) {}
  }
  function wrap(obj, prop, factory) {
    try {
      var orig = obj[prop];
      if (typeof orig !== "function") return;
      var replacement = factory(orig);
      cloak(replacement, orig.name || prop);
      obj[prop] = replacement;
    } catch (_) {}
  }

  // ── Seeded noise (matches preload-fingerprint techniques) ─────────────────
  function seedToInt(v) {
    var str = String(v || "");
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  var NOISE_SEED = CFG._fingerprintSeed || CFG._profileId || "seed";
  var seedInt = seedToInt(NOISE_SEED);
  function stableNoise(i) {
    var x = Math.sin((seedInt % 100000) + i * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  // ── navigator ─────────────────────────────────────────────────────────────
  try {
    var nav = Navigator.prototype;
    if (typeof CFG.hardwareConcurrency === "number") def(nav, "hardwareConcurrency", function () { return CFG.hardwareConcurrency; });
    if (typeof CFG.deviceMemory === "number") def(nav, "deviceMemory", function () { return CFG.deviceMemory; });
    if (CFG.platform) def(nav, "platform", function () { return CFG.platform; });
    if (typeof CFG._maxTouchPoints === "number") def(nav, "maxTouchPoints", function () { return CFG._maxTouchPoints; });
    if (Array.isArray(CFG.languages) && CFG.languages.length) {
      var langs = CFG.languages.slice();
      def(nav, "languages", function () { return Object.freeze(langs.slice()); });
      if (CFG.language) def(nav, "language", function () { return CFG.language; });
    }
    // webdriver is already false in a normally-launched real browser; assert it.
    def(nav, "webdriver", function () { return false; });
  } catch (_) {}

  // ── screen ──────────────────────────────────────────────────────────────────
  try {
    if (CFG.screen && CFG.screen.width) {
      var sc = CFG.screen;
      def(Screen.prototype, "width", function () { return sc.width; });
      def(Screen.prototype, "height", function () { return sc.height; });
      def(Screen.prototype, "availWidth", function () { return sc.availWidth || sc.width; });
      def(Screen.prototype, "availHeight", function () { return sc.availHeight || sc.height; });
      if (sc.colorDepth) def(Screen.prototype, "colorDepth", function () { return sc.colorDepth; });
      if (sc.pixelDepth) def(Screen.prototype, "pixelDepth", function () { return sc.pixelDepth; });
    }
  } catch (_) {}

  // ── Canvas (per-seed LSB / text-metric noise) ─────────────────────────────
  if (CFG.blockCanvas !== false) {
    try {
      var applyLsb = function (data) {
        for (var i = 0; i < data.length; i += 4) {
          if (stableNoise(i) < 0.01) data[i] ^= 1;
          if (stableNoise(i + 1) < 0.01) data[i + 1] ^= 1;
          if (stableNoise(i + 2) < 0.01) data[i + 2] ^= 1;
        }
      };
      wrap(HTMLCanvasElement.prototype, "toDataURL", function (orig) {
        return function () {
          try {
            var ctx = this.getContext("2d");
            if (ctx && this.width && this.height) {
              var w = this.width, h = this.height;
              var img = ctx.getImageData(0, 0, w, h);
              var backup = new Uint8ClampedArray(img.data);
              applyLsb(img.data); ctx.putImageData(img, 0, 0);
              var r = orig.apply(this, arguments);
              var restore = ctx.createImageData(w, h); restore.data.set(backup); ctx.putImageData(restore, 0, 0);
              return r;
            }
          } catch (_) {}
          return orig.apply(this, arguments);
        };
      });
      wrap(HTMLCanvasElement.prototype, "toBlob", function (orig) {
        return function (cb) {
          var rest = Array.prototype.slice.call(arguments, 1);
          try {
            var ctx = this.getContext("2d");
            if (ctx && this.width && this.height) {
              var w = this.width, h = this.height;
              var img = ctx.getImageData(0, 0, w, h);
              var backup = new Uint8ClampedArray(img.data);
              applyLsb(img.data); ctx.putImageData(img, 0, 0);
              var r = orig.apply(this, [cb].concat(rest));
              var restore = ctx.createImageData(w, h); restore.data.set(backup); ctx.putImageData(restore, 0, 0);
              return r;
            }
          } catch (_) {}
          return orig.apply(this, arguments);
        };
      });
      wrap(CanvasRenderingContext2D.prototype, "getImageData", function (orig) {
        return function () {
          var img = orig.apply(this, arguments);
          try {
            var d = img.data;
            for (var i = 0; i < d.length; i += 4) {
              if (stableNoise(i) < 0.005) d[i] ^= 1;
              if (stableNoise(i + 1) < 0.005) d[i + 1] ^= 1;
              if (stableNoise(i + 2) < 0.005) d[i + 2] ^= 1;
            }
          } catch (_) {}
          return img;
        };
      });
      wrap(CanvasRenderingContext2D.prototype, "measureText", function (orig) {
        return function (text) {
          var m = orig.apply(this, arguments);
          try {
            var delta = ((seedToInt(String(text) + "|" + String(this.font) + "|" + NOISE_SEED) % 2000) / 2000 - 0.5) * 0.02;
            var w = m.width + delta;
            Object.defineProperty(m, "width", { get: function () { return w; }, configurable: true });
          } catch (_) {}
          return m;
        };
      });
    } catch (_) {}
  }

  // ── WebGL (per-profile vendor/renderer; leave numeric caps native) ────────
  if (CFG.blockWebGL !== false && (CFG._gpuVendor || CFG._gpuRenderer)) {
    try {
      var UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;
      var patchGetParam = function (proto) {
        if (!proto) return;
        wrap(proto, "getParameter", function (orig) {
          return function (p) {
            try {
              if (p === UNMASKED_VENDOR && CFG._gpuVendor) return CFG._gpuVendor;
              if (p === UNMASKED_RENDERER && CFG._gpuRenderer) return CFG._gpuRenderer;
              // 0x1F00 VENDOR, 0x1F01 RENDERER — keep ANGLE-style coherent strings.
              if (p === 0x1F00 && CFG._gpuVendor) return "Google Inc. (" + String(CFG._gpuVendor).replace(/^Google Inc\. \(|\)$/g, "") + ")";
              if (p === 0x1F01 && CFG._gpuRenderer) return CFG._gpuRenderer;
            } catch (_) {}
            return orig.apply(this, arguments);
          };
        });
      };
      patchGetParam(typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext.prototype);
      patchGetParam(typeof WebGL2RenderingContext !== "undefined" && WebGL2RenderingContext.prototype);
    } catch (_) {}
  }

  // ── Audio (per-seed tiny sample noise) ────────────────────────────────────
  if (CFG.blockAudio !== false) {
    try {
      if (typeof AudioBuffer !== "undefined") {
        wrap(AudioBuffer.prototype, "getChannelData", function (orig) {
          return function () {
            var data = orig.apply(this, arguments);
            try { for (var i = 0; i < data.length; i += 500) data[i] = data[i] + (stableNoise(i) - 0.5) * 1e-7; } catch (_) {}
            return data;
          };
        });
      }
      if (typeof AnalyserNode !== "undefined") {
        wrap(AnalyserNode.prototype, "getFloatFrequencyData", function (orig) {
          return function (arr) {
            orig.apply(this, arguments);
            try { for (var i = 0; i < arr.length; i += 100) arr[i] = arr[i] + (stableNoise(i) - 0.5) * 1e-4; } catch (_) {}
          };
        });
      }
    } catch (_) {}
  }

  // ── Timezone (Windows Chromium ignores the TZ env var, so spoof in JS) ────
  // DST-correct: compute the target-zone offset from a formatter created BEFORE we
  // override Intl, so the real ICU data does the work — we only relabel the zone.
  if (CFG.timezone) {
    try {
      var TZ = CFG.timezone;
      var OrigDTF = Intl.DateTimeFormat;
      var offsetFor = function (date) {
        try {
          var dtf = new OrigDTF("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
          var p = {};
          dtf.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
          var hh = p.hour === "24" ? "00" : p.hour;
          var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hh, +p.minute, +p.second);
          return -Math.round((asUTC - date.getTime()) / 60000);
        } catch (_) { return typeof CFG.localeOffsetMinutes === "number" ? CFG.localeOffsetMinutes : 0; }
      };
      wrap(Date.prototype, "getTimezoneOffset", function () { return function () { return offsetFor(this); }; });
      // Intl.DateTimeFormat: default an unspecified timeZone to the target, and
      // report it in resolvedOptions.
      var DTFProxy = function (locales, opts) {
        opts = opts || {};
        if (!opts.timeZone) opts = Object.assign({}, opts, { timeZone: TZ });
        return new OrigDTF(locales, opts);
      };
      DTFProxy.prototype = OrigDTF.prototype;
      DTFProxy.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);
      cloak(DTFProxy, "DateTimeFormat");
      try { Intl.DateTimeFormat = DTFProxy; } catch (_) {}
      wrap(OrigDTF.prototype, "resolvedOptions", function (orig) {
        return function () { var o = orig.apply(this, arguments); try { if (!o.__tzSet) o.timeZone = TZ; } catch (_) {} return o; };
      });
      // Date string methods reflect the zone via toLocaleString with target TZ.
      wrap(Date.prototype, "toString", function (orig) {
        return function () {
          try {
            var off = offsetFor(this); var sign = off <= 0 ? "+" : "-"; var abs = Math.abs(off);
            var hh = String(Math.floor(abs / 60)).padStart(2, "0"); var mm = String(abs % 60).padStart(2, "0");
            var base = new OrigDTF("en-US", { timeZone: TZ, weekday: "short", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            var p = {}; base.formatToParts(this).forEach(function (x) { p[x.type] = x.value; });
            return p.weekday + " " + p.month + " " + p.day + " " + p.year + " " + p.hour + ":" + p.minute + ":" + p.second + " GMT" + sign + hh + mm;
          } catch (_) { return orig.apply(this, arguments); }
        };
      });
    } catch (_) {}
  }

  // ── Geolocation (return the profile's coordinates; never the real ones) ───
  if (CFG.spoofGeo !== false && CFG.geo && (CFG.geo.latitude || CFG.geo.longitude)) {
    try {
      var g = CFG.geo;
      var makePos = function () {
        return {
          coords: {
            latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy || 50,
            altitude: g.altitude != null ? g.altitude : null,
            altitudeAccuracy: g.altitudeAccuracy != null ? g.altitudeAccuracy : null,
            heading: g.heading != null ? g.heading : null,
            speed: g.speed != null ? g.speed : null
          },
          timestamp: Date.now()
        };
      };
      if (navigator.geolocation) {
        wrap(navigator.geolocation, "getCurrentPosition", function () {
          return function (success) { try { if (typeof success === "function") success(makePos()); } catch (_) {} };
        });
        wrap(navigator.geolocation, "watchPosition", function () {
          return function (success) { try { if (typeof success === "function") success(makePos()); } catch (_) {} return 0; };
        });
      }
    } catch (_) {}
  }
})();
`;

function safeId(id) {
  return String(id || "profile").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Map a full resolved config (buildConfigFromProfile) down to just the fields the
// content script needs. Keeping it minimal avoids shipping proxy creds / internal
// flags into a file the page's browser process can read.
//
// opts.gpuGeoOnly: for the patched-chromium engine, the C++ layer already does
// canvas/audio/font/navigator/screen/timezone per-seed. Only WebGL renderer STRING
// and geolocation are left to JS, so we disable everything else to avoid double
// work and keep the C++ noise authoritative.
function extensionConfig(cfg, opts = {}) {
  cfg = cfg || {};
  if (opts.gpuGeoOnly) {
    return {
      enabled: true,
      _profileId: cfg._profileId || "",
      _fingerprintSeed: cfg._fingerprintSeed || cfg._profileId || "",
      spoofSkipHosts: Array.isArray(cfg._spoofSkipHosts) ? cfg._spoofSkipHosts : [],
      blockCanvas: false,   // C++ engine handles canvas
      blockAudio: false,    // C++ engine handles audio
      blockWebGL: true,     // JS handles the WebGL renderer STRING
      _gpuVendor: cfg._gpuVendor || "",
      _gpuRenderer: cfg._gpuRenderer || "",
      // timezone/navigator/screen intentionally omitted → those overrides self-skip
      spoofGeo: cfg.spoofGeo !== false,
      geo: cfg.geo || null
    };
  }
  return {
    enabled: cfg.enabled !== false,
    _profileId: cfg._profileId || "",
    _fingerprintSeed: cfg._fingerprintSeed || cfg._profileId || "",
    spoofSkipHosts: Array.isArray(cfg._spoofSkipHosts) ? cfg._spoofSkipHosts : [],
    hardwareConcurrency: typeof cfg.hardwareConcurrency === "number" ? cfg.hardwareConcurrency : undefined,
    deviceMemory: typeof cfg.deviceMemory === "number" ? cfg.deviceMemory : undefined,
    platform: cfg.platform || "",
    _maxTouchPoints: typeof cfg._maxTouchPoints === "number" ? cfg._maxTouchPoints : 0,
    language: cfg.language || "",
    languages: Array.isArray(cfg.languages) ? cfg.languages : [],
    screen: cfg.screen || null,
    blockCanvas: cfg.blockCanvas !== false,
    blockWebGL: cfg.blockWebGL !== false,
    blockAudio: cfg.blockAudio !== false,
    _gpuVendor: cfg._gpuVendor || "",
    _gpuRenderer: cfg._gpuRenderer || "",
    timezone: cfg.timezone || "",
    localeOffsetMinutes: typeof cfg.localeOffsetMinutes === "number" ? cfg.localeOffsetMinutes : 0,
    spoofGeo: cfg.spoofGeo !== false,
    geo: cfg.geo || null
  };
}

function buildManifest() {
  return {
    manifest_version: 3,
    name: "Profile Runtime",
    version: "1.0.0",
    description: "Per-profile runtime settings.",
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["fp.js"],
        run_at: "document_start",
        all_frames: true,
        match_about_blank: true,
        world: "MAIN"
      }
    ]
  };
}

// Write (regenerate) the per-profile extension into `destDir`. Returns the dir on
// success, or null on failure (the caller then launches without JS spoof rather
// than blocking the browser entirely).
function writeExtension(profileId, cfg, destDir, opts = {}) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const json = JSON.stringify(extensionConfig(cfg, opts));
    const fpJs = SPOOF_BODY.replace("__PS_CFG__", json);
    fs.writeFileSync(path.join(destDir, "fp.js"), fpJs, "utf8");
    fs.writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(buildManifest(), null, 2), "utf8");
    return destDir;
  } catch (_) {
    return null;
  }
}

module.exports = { writeExtension, extensionConfig, safeId, MIN_CHROME_MAJOR, SPOOF_BODY };
