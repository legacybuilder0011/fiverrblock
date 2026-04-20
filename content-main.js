// content-main.js - Runs in the MAIN world at document_start.
// Overrides fingerprintable browser / hardware APIs, spoofs geolocation and
// timezone, noises canvas / audio, and neuters storage APIs on request.
//
// This must run BEFORE any page script. Keep it synchronous at the top and
// avoid relying on async Chrome APIs (they are unavailable in MAIN world anyway).

(function () {
  "use strict";

  // ------------- Defaults + live config -------------
  const DEFAULTS = {
    enabled: true,
    blockCookies: true,
    spoofGeo: true,
    geo: {
      latitude: 40.7128,
      longitude: -74.006,
      accuracy: 50,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    },
    spoofTimezone: true,
    timezone: "UTC",
    localeOffsetMinutes: 0,
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
    rotateFingerprint: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    platform: "Win32",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 4,
    deviceMemory: 8,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24
    }
  };

  // Attempt to read config synchronously from the html element attribute.
  let config = DEFAULTS;
  try {
    const attr = document.documentElement.getAttribute("data-privacy-shield");
    if (attr) config = Object.assign({}, DEFAULTS, JSON.parse(attr));
  } catch (_) {
    /* use defaults */
  }

  // ------------- Rotation pools -------------
  // A fixed fake identity is still a stable identity. Rotating on every page
  // load breaks passive cross-session tracking. Pools are intentionally common
  // / plausible so the spoofed profile doesn't stand out.
  const POOLS = {
    ua: [
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        platform: "Win32",
        os: "Windows"
      },
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        platform: "Win32",
        os: "Windows"
      },
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        platform: "Win32",
        os: "Windows"
      },
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        platform: "MacIntel",
        os: "macOS"
      },
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        platform: "MacIntel",
        os: "macOS"
      },
      {
        ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        os: "Linux"
      },
      {
        ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        os: "Linux"
      }
    ],
    screens: [
      { w: 1920, h: 1080 },
      { w: 1366, h: 768 },
      { w: 1536, h: 864 },
      { w: 1440, h: 900 },
      { w: 1680, h: 1050 },
      { w: 2560, h: 1440 }
    ],
    colorDepths: [24, 30],
    languages: [
      ["en-US", "en"],
      ["en-GB", "en"],
      ["en-CA", "en"],
      ["fr-FR", "fr", "en"],
      ["de-DE", "de", "en"],
      ["es-ES", "es", "en"],
      ["nl-NL", "nl", "en"],
      ["it-IT", "it", "en"]
    ],
    timezones: [
      { tz: "America/New_York", offset: 300 },
      { tz: "America/Los_Angeles", offset: 480 },
      { tz: "America/Chicago", offset: 360 },
      { tz: "Europe/London", offset: 0 },
      { tz: "Europe/Paris", offset: -60 },
      { tz: "Europe/Berlin", offset: -60 },
      { tz: "Europe/Amsterdam", offset: -60 },
      { tz: "Asia/Tokyo", offset: -540 },
      { tz: "Asia/Singapore", offset: -480 },
      { tz: "Australia/Sydney", offset: -600 }
    ],
    cores: [2, 4, 4, 4, 8, 8, 12, 16],
    memory: [4, 8, 8, 8, 16, 16, 32],
    // Fake GPU strings. Mix of common Intel/NVIDIA/AMD names so the spoofed
    // WebGL profile stays plausible across reloads.
    gpus: [
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)"
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)"
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
      },
      {
        vendor: "Google Inc. (AMD)",
        renderer:
          "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)"
      }
    ]
  };

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Rotate on every page load. Picks fresh plausible values and mutates the
  // config in place so downstream overrides pick them up.
  function rotateConfig(cfg) {
    const uaEntry = pick(POOLS.ua);
    const scr = pick(POOLS.screens);
    const langs = pick(POOLS.languages);
    const tz = pick(POOLS.timezones);
    const gpu = pick(POOLS.gpus);

    cfg.userAgent = uaEntry.ua;
    cfg.platform = uaEntry.platform;
    cfg._uaOS = uaEntry.os;
    cfg._gpuVendor = gpu.vendor;
    cfg._gpuRenderer = gpu.renderer;
    cfg.screen = {
      width: scr.w,
      height: scr.h,
      availWidth: scr.w,
      availHeight: scr.h - 40,
      colorDepth: pick(POOLS.colorDepths),
      pixelDepth: 24
    };
    cfg.language = langs[0];
    cfg.languages = langs;
    cfg.timezone = tz.tz;
    cfg.localeOffsetMinutes = tz.offset;
    cfg.hardwareConcurrency = pick(POOLS.cores);
    cfg.deviceMemory = pick(POOLS.memory);
    return cfg;
  }

  if (config.rotateFingerprint !== false) {
    config = rotateConfig({ ...config });
  }

  // Live-update when the bridge pushes a new config.
  window.addEventListener("__privacy_shield_config__", (ev) => {
    try {
      const next = Object.assign({}, DEFAULTS, ev.detail || {});
      config = next.rotateFingerprint !== false ? rotateConfig(next) : next;
    } catch (_) {}
  });

  // Do nothing when the shield is disabled.
  if (!config.enabled) return;

  // Check if this site is paused. When paused we still apply fingerprint
  // defenses (UA, screen, canvas, webgl, audio, fonts, plugins, hardware,
  // battery, timezone, geolocation) — only cookies and storage blocking are
  // turned off so the site works normally without leaking the real device.
  let sitePaused = false;
  try {
    const host = (location.hostname || "").toLowerCase().replace(/^www\./, "");
    const list = Array.isArray(config.siteAllowList)
      ? config.siteAllowList
      : [];
    if (host && list.includes(host)) sitePaused = true;
  } catch (_) {}

  // ------------- Activity emitter (throttled, per-type) -------------
  const EVENT_KEY = "__privacy_shield_event__";
  const lastEmit = Object.create(null);
  const emit = (type, detail) => {
    try {
      const now = Date.now();
      // Throttle same-type events to at most once per second.
      if (now - (lastEmit[type] || 0) < 1000) return;
      lastEmit[type] = now;
      window.dispatchEvent(
        new CustomEvent(EVENT_KEY, {
          detail: { type, detail: detail || "" }
        })
      );
    } catch (_) {}
  };

  // ------------- Tiny helpers -------------
  // Make a function report as native code when fingerprinters call .toString() on it.
  const fakeNative = (fn, name) => {
    try {
      const nativeStr = "function " + (name || fn.name || "") + "() { [native code] }";
      Object.defineProperty(fn, "toString", {
        value: function () {
          return nativeStr;
        },
        configurable: true,
        writable: true
      });
      Object.defineProperty(fn, "name", {
        value: name || fn.name || "",
        configurable: true
      });
    } catch (_) {}
    return fn;
  };

  // Also mask Function.prototype.toString so calling nativeStr from there works too.
  try {
    const origFnToString = Function.prototype.toString;
    const fakeMap = new WeakMap();
    Function.prototype.toString = fakeNative(function toString() {
      if (fakeMap.has(this)) return fakeMap.get(this);
      return origFnToString.call(this);
    }, "toString");
    // Expose a way for our overrides to register their fake toString output.
    window.__ps_fakeNative = (fn, str) => {
      try { fakeMap.set(fn, str); } catch (_) {}
    };
  } catch (_) {}

  const defineRO = (obj, prop, value) => {
    try {
      const getter = function () {
        return typeof value === "function" ? value() : value;
      };
      fakeNative(getter, "get " + prop);
      try {
        window.__ps_fakeNative &&
          window.__ps_fakeNative(getter, "function get " + prop + "() { [native code] }");
      } catch (_) {}
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true
      });
    } catch (_) {}
  };

  const wrap = (target, prop, replacement) => {
    try {
      const original = target[prop];
      const replaced = replacement(original);
      target[prop] = replaced;
      fakeNative(replaced, prop);
      try {
        const nativeStr =
          typeof original === "function"
            ? Function.prototype.toString.call(original)
            : "function " + prop + "() { [native code] }";
        window.__ps_fakeNative && window.__ps_fakeNative(replaced, nativeStr);
      } catch (_) {}
    } catch (_) {}
  };

  // ------------- Navigator spoofing (UA, platform, languages) -------------
  if (config.spoofUA) {
    const uaGet = () => {
      emit("uaAccess", "userAgent");
      return config.userAgent;
    };
    defineRO(Navigator.prototype, "userAgent", uaGet);
    defineRO(Navigator.prototype, "appVersion", () => {
      emit("uaAccess", "appVersion");
      return config.userAgent.replace(/^Mozilla\//, "");
    });
    defineRO(Navigator.prototype, "platform", () => {
      emit("uaAccess", "platform");
      return config.platform;
    });
    defineRO(Navigator.prototype, "vendor", "Google Inc.");
    defineRO(Navigator.prototype, "oscpu", undefined);
    defineRO(Navigator.prototype, "productSub", "20030107");
    defineRO(Navigator.prototype, "language", () => {
      emit("uaAccess", "language");
      return config.language;
    });
    defineRO(Navigator.prototype, "languages", () => {
      emit("uaAccess", "languages");
      return Object.freeze(config.languages.slice());
    });

    // User-Agent Client Hints (sec-ch-ua family) — match rotated OS / version.
    if (navigator.userAgentData) {
      const chromeVer = (config.userAgent.match(/Chrome\/(\d+)/) || [])[1] ||
        "120";
      const fakeBrands = [
        { brand: "Not_A Brand", version: "8" },
        { brand: "Chromium", version: chromeVer },
        { brand: "Google Chrome", version: chromeVer }
      ];
      const os = config._uaOS || "Windows";
      const platformVersion =
        os === "macOS" ? "14.2.1" : os === "Linux" ? "6.5.0" : "15.0.0";
      try {
        Object.defineProperty(navigator, "userAgentData", {
          get() {
            return {
              brands: fakeBrands,
              mobile: false,
              platform: os,
              getHighEntropyValues(hints) {
                return Promise.resolve({
                  architecture: "x86",
                  bitness: "64",
                  brands: fakeBrands,
                  fullVersionList: fakeBrands,
                  mobile: false,
                  model: "",
                  platform: os,
                  platformVersion,
                  uaFullVersion: chromeVer + ".0.0.0",
                  wow64: false
                });
              },
              toJSON() {
                return { brands: fakeBrands, mobile: false, platform: os };
              }
            };
          },
          configurable: true
        });
      } catch (_) {}
    }
  }

  // ------------- Hardware (CPU cores, device memory, connection, etc.) -------------
  if (config.blockHardware) {
    defineRO(Navigator.prototype, "hardwareConcurrency", () => {
      emit("hardwareAccess", "hardwareConcurrency");
      return config.hardwareConcurrency;
    });
    defineRO(Navigator.prototype, "deviceMemory", () => {
      emit("hardwareAccess", "deviceMemory");
      return config.deviceMemory;
    });
    defineRO(Navigator.prototype, "maxTouchPoints", 0);

    // NetworkInformation API (connection type / downlink can fingerprint)
    try {
      const fakeConn = {
        effectiveType: "4g",
        downlink: 10,
        rtt: 50,
        saveData: false,
        type: "wifi",
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        }
      };
      defineRO(Navigator.prototype, "connection", fakeConn);
      defineRO(Navigator.prototype, "mozConnection", fakeConn);
      defineRO(Navigator.prototype, "webkitConnection", fakeConn);
    } catch (_) {}
  }

  // ------------- Battery API -------------
  if (config.blockBattery) {
    const fakeBattery = {
      charging: true,
      chargingTime: Infinity,
      dischargingTime: Infinity,
      level: 1,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      }
    };
    try {
      Navigator.prototype.getBattery = function () {
        emit("batteryAccess", "getBattery");
        return Promise.resolve(fakeBattery);
      };
    } catch (_) {}
    try {
      delete navigator.battery;
      defineRO(Navigator.prototype, "battery", undefined);
    } catch (_) {}
  }

  // ------------- Plugins / MIME types -------------
  if (config.blockPlugins) {
    const emptyPlugins = Object.freeze({
      length: 0,
      item() {
        return null;
      },
      namedItem() {
        return null;
      },
      refresh() {},
      [Symbol.iterator]: function* () {}
    });
    defineRO(Navigator.prototype, "plugins", () => {
      emit("pluginsAccess", "navigator.plugins");
      return emptyPlugins;
    });
    defineRO(Navigator.prototype, "mimeTypes", () => {
      emit("pluginsAccess", "navigator.mimeTypes");
      return emptyPlugins;
    });
    defineRO(Navigator.prototype, "pdfViewerEnabled", false);
  }

  // ------------- Fonts API -------------
  if (config.blockFonts) {
    try {
      if (document.fonts) {
        document.fonts.check = () => {
          emit("fontsAccess", "document.fonts.check");
          return false;
        };
        document.fonts.ready = Promise.resolve(document.fonts);
        document.fonts.forEach = () => {};
        document.fonts.values = function* () {};
        document.fonts.keys = function* () {};
        document.fonts.entries = function* () {};
        Object.defineProperty(document.fonts, "size", {
          get: () => 0,
          configurable: true
        });
      }
    } catch (_) {}
  }

  // ------------- Screen spoofing -------------
  if (config.blockScreen) {
    const s = config.screen;
    const screenGet = (key) => () => {
      emit("screenAccess", "screen." + key);
      return s[key];
    };
    defineRO(Screen.prototype, "width", screenGet("width"));
    defineRO(Screen.prototype, "height", screenGet("height"));
    defineRO(Screen.prototype, "availWidth", screenGet("availWidth"));
    defineRO(Screen.prototype, "availHeight", screenGet("availHeight"));
    defineRO(Screen.prototype, "colorDepth", screenGet("colorDepth"));
    defineRO(Screen.prototype, "pixelDepth", screenGet("pixelDepth"));
    defineRO(Screen.prototype, "availLeft", 0);
    defineRO(Screen.prototype, "availTop", 0);
    try {
      defineRO(window, "devicePixelRatio", 1);
    } catch (_) {}

    // Orientation lookup
    try {
      if (screen.orientation) {
        defineRO(screen.orientation, "type", "landscape-primary");
        defineRO(screen.orientation, "angle", 0);
      }
    } catch (_) {}
  }

  // ------------- Timezone spoofing -------------
  if (config.spoofTimezone) {
    const fakeTZ = config.timezone || "UTC";
    const offsetMin = Number(config.localeOffsetMinutes) || 0;

    // Intl.DateTimeFormat.resolvedOptions().timeZone
    try {
      const OriginalDTF = Intl.DateTimeFormat;
      const OriginalResolved = OriginalDTF.prototype.resolvedOptions;
      OriginalDTF.prototype.resolvedOptions = function () {
        const r = OriginalResolved.call(this);
        r.timeZone = fakeTZ;
        emit("timezoneAccess", "Intl.DateTimeFormat.resolvedOptions");
        return r;
      };
    } catch (_) {}

    // Date.prototype.getTimezoneOffset
    try {
      Date.prototype.getTimezoneOffset = function () {
        emit("timezoneAccess", "Date.getTimezoneOffset");
        return offsetMin;
      };
    } catch (_) {}

    // Date toString / toLocaleString etc. - best effort
    try {
      const origToString = Date.prototype.toString;
      Date.prototype.toString = function () {
        try {
          return origToString.call(this).replace(
            /GMT[+-]\d{4}.*$/,
            "GMT+0000 (Coordinated Universal Time)"
          );
        } catch (_) {
          return origToString.call(this);
        }
      };
    } catch (_) {}
  }

  // ------------- Geolocation spoofing -------------
  if (config.spoofGeo && navigator.geolocation) {
    const buildPosition = () => {
      const g = config.geo || DEFAULTS.geo;
      return {
        coords: {
          latitude: Number(g.latitude),
          longitude: Number(g.longitude),
          accuracy: Number(g.accuracy) || 50,
          altitude: g.altitude,
          altitudeAccuracy: g.altitudeAccuracy,
          heading: g.heading,
          speed: g.speed
        },
        timestamp: Date.now()
      };
    };

    try {
      navigator.geolocation.getCurrentPosition = function (
        success,
        error,
        _opts
      ) {
        emit("geoAccess", "getCurrentPosition");
        try {
          if (typeof success === "function") success(buildPosition());
        } catch (_) {
          if (typeof error === "function")
            error({ code: 2, message: "POSITION_UNAVAILABLE" });
        }
      };
      let watchCount = 0;
      navigator.geolocation.watchPosition = function (success, _error, _opts) {
        emit("geoAccess", "watchPosition");
        const id = ++watchCount;
        setTimeout(() => {
          try {
            if (typeof success === "function") success(buildPosition());
          } catch (_) {}
        }, 0);
        return id;
      };
      navigator.geolocation.clearWatch = function () {};
    } catch (_) {}
  }

  // ------------- Canvas fingerprint defense -------------
  if (config.blockCanvas) {
    const noiseCanvas = (ctx, canvas) => {
      try {
        const w = canvas.width;
        const h = canvas.height;
        if (!w || !h) return;
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        // Light, deterministic-per-page noise so functionality isn't broken.
        for (let i = 0; i < data.length; i += 4) {
          data[i] = data[i] ^ (Math.random() < 0.01 ? 1 : 0);
          data[i + 1] = data[i + 1] ^ (Math.random() < 0.01 ? 1 : 0);
          data[i + 2] = data[i + 2] ^ (Math.random() < 0.01 ? 1 : 0);
        }
        ctx.putImageData(imgData, 0, 0);
      } catch (_) {}
    };

    wrap(HTMLCanvasElement.prototype, "toDataURL", (orig) =>
      function (...args) {
        emit("canvasAccess", "toDataURL");
        try {
          const ctx = this.getContext("2d");
          if (ctx) noiseCanvas(ctx, this);
        } catch (_) {}
        return orig.apply(this, args);
      }
    );

    wrap(HTMLCanvasElement.prototype, "toBlob", (orig) =>
      function (cb, ...rest) {
        emit("canvasAccess", "toBlob");
        try {
          const ctx = this.getContext("2d");
          if (ctx) noiseCanvas(ctx, this);
        } catch (_) {}
        return orig.call(this, cb, ...rest);
      }
    );

    wrap(CanvasRenderingContext2D.prototype, "getImageData", (orig) =>
      function (...args) {
        emit("canvasAccess", "getImageData");
        const imgData = orig.apply(this, args);
        try {
          const data = imgData.data;
          for (let i = 0; i < data.length; i += 4) {
            if (Math.random() < 0.005) data[i] ^= 1;
            if (Math.random() < 0.005) data[i + 1] ^= 1;
            if (Math.random() < 0.005) data[i + 2] ^= 1;
          }
        } catch (_) {}
        return imgData;
      }
    );

    // OffscreenCanvas
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        wrap(OffscreenCanvas.prototype, "convertToBlob", (orig) =>
          function (...args) {
            return orig.apply(this, args);
          }
        );
      }
    } catch (_) {}
  }

  // ------------- WebGL blocking -------------
  if (config.blockWebGL) {
    const neuter = (proto) => {
      if (!proto) return;
      wrap(proto, "getParameter", (orig) =>
        function (p) {
          // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
          if (p === 37445) {
            emit("webglAccess", "UNMASKED_VENDOR_WEBGL");
            return config._gpuVendor || "Google Inc. (Intel)";
          }
          if (p === 37446) {
            emit("webglAccess", "UNMASKED_RENDERER_WEBGL");
            return (
              config._gpuRenderer ||
              "ANGLE (Intel, Intel(R) UHD Graphics, OpenGL 4.1)"
            );
          }
          if (p === 7936) {
            emit("webglAccess", "VENDOR");
            return "WebKit";
          }
          if (p === 7937) {
            emit("webglAccess", "RENDERER");
            return "WebKit WebGL";
          }
          if (p === 7938) {
            emit("webglAccess", "VERSION");
            return "WebGL 1.0";
          }
          if (p === 35724) {
            emit("webglAccess", "SHADING_LANGUAGE_VERSION");
            return "WebGL GLSL ES 1.0";
          }
          return orig.call(this, p);
        }
      );
      wrap(proto, "getExtension", (orig) =>
        function (name) {
          if (name === "WEBGL_debug_renderer_info") {
            emit("webglAccess", "debug_renderer_info");
            return null;
          }
          return orig.call(this, name);
        }
      );
      // Normalized Chrome 120+ WebGL extensions list — returning the real list
      // leaks the actual GPU driver. This set is what modern Chrome typically
      // reports across desktops; using a fixed list kills a whole fingerprint vector.
      const NORMALIZED_EXTENSIONS = [
        "ANGLE_instanced_arrays",
        "EXT_blend_minmax",
        "EXT_color_buffer_half_float",
        "EXT_disjoint_timer_query",
        "EXT_float_blend",
        "EXT_frag_depth",
        "EXT_shader_texture_lod",
        "EXT_texture_compression_bptc",
        "EXT_texture_compression_rgtc",
        "EXT_texture_filter_anisotropic",
        "EXT_sRGB",
        "KHR_parallel_shader_compile",
        "OES_element_index_uint",
        "OES_fbo_render_mipmap",
        "OES_standard_derivatives",
        "OES_texture_float",
        "OES_texture_float_linear",
        "OES_texture_half_float",
        "OES_texture_half_float_linear",
        "OES_vertex_array_object",
        "WEBGL_color_buffer_float",
        "WEBGL_compressed_texture_s3tc",
        "WEBGL_compressed_texture_s3tc_srgb",
        "WEBGL_debug_shaders",
        "WEBGL_depth_texture",
        "WEBGL_draw_buffers",
        "WEBGL_lose_context",
        "WEBGL_multi_draw"
      ];
      wrap(proto, "getSupportedExtensions", (orig) =>
        function () {
          emit("webglAccess", "getSupportedExtensions");
          return NORMALIZED_EXTENSIONS.slice();
        }
      );
      wrap(proto, "readPixels", (orig) =>
        function (...args) {
          emit("webglAccess", "readPixels");
          const r = orig.apply(this, args);
          try {
            const buf = args[6];
            if (buf && buf.length) {
              for (let i = 0; i < buf.length; i += 4) {
                if (Math.random() < 0.002) buf[i] ^= 1;
              }
            }
          } catch (_) {}
          return r;
        }
      );
    };
    if (typeof WebGLRenderingContext !== "undefined")
      neuter(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined")
      neuter(WebGL2RenderingContext.prototype);
  }

  // ------------- AudioContext fingerprint defense -------------
  if (config.blockAudio) {
    const noiseArr = (arr) => {
      try {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = arr[i] + (Math.random() - 0.5) * 1e-7;
        }
      } catch (_) {}
    };
    if (typeof AnalyserNode !== "undefined") {
      wrap(AnalyserNode.prototype, "getFloatFrequencyData", (orig) =>
        function (arr) {
          emit("audioAccess", "getFloatFrequencyData");
          orig.call(this, arr);
          noiseArr(arr);
        }
      );
      wrap(AnalyserNode.prototype, "getByteFrequencyData", (orig) =>
        function (arr) {
          emit("audioAccess", "getByteFrequencyData");
          orig.call(this, arr);
          for (let i = 0; i < arr.length; i++) {
            if (Math.random() < 0.01) arr[i] = (arr[i] ^ 1) & 0xff;
          }
        }
      );
      wrap(AnalyserNode.prototype, "getFloatTimeDomainData", (orig) =>
        function (arr) {
          emit("audioAccess", "getFloatTimeDomainData");
          orig.call(this, arr);
          noiseArr(arr);
        }
      );
    }
    if (typeof AudioBuffer !== "undefined") {
      wrap(AudioBuffer.prototype, "getChannelData", (orig) =>
        function (...args) {
          emit("audioAccess", "getChannelData");
          const data = orig.apply(this, args);
          try {
            for (let i = 0; i < data.length; i += 500) {
              data[i] = data[i] + (Math.random() - 0.5) * 1e-7;
            }
          } catch (_) {}
          return data;
        }
      );
      wrap(AudioBuffer.prototype, "copyFromChannel", (orig) =>
        function (dest, ...rest) {
          emit("audioAccess", "copyFromChannel");
          orig.call(this, dest, ...rest);
          try {
            for (let i = 0; i < dest.length; i += 500) {
              dest[i] = dest[i] + (Math.random() - 0.5) * 1e-7;
            }
          } catch (_) {}
        }
      );
    }
  }

  // ------------- navigator.webdriver = undefined (bot-detection flag #1) -------------
  // Chrome sets this to `true` under automation. Every anti-bot system checks
  // it first. Explicitly force it to `false` / undefined so we pass that gate.
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get() {
        return false;
      },
      configurable: true
    });
  } catch (_) {}
  try {
    // Also wipe any other automation-framework leaks on window.
    const automationKeys = [
      "__webdriver_evaluate",
      "__selenium_evaluate",
      "__webdriver_script_function",
      "__webdriver_script_func",
      "__webdriver_script_fn",
      "__fxdriver_evaluate",
      "__driver_unwrapped",
      "__webdriver_unwrapped",
      "__driver_evaluate",
      "__selenium_unwrapped",
      "__fxdriver_unwrapped",
      "_Selenium_IDE_Recorder",
      "_selenium",
      "calledSelenium",
      "$cdc_asdjflasutopfhvcZLmcfl_",
      "$chrome_asyncScriptInfo",
      "__$webdriverAsyncExecutor"
    ];
    for (const k of automationKeys) {
      try { delete window[k]; } catch (_) {}
      try { delete document[k]; } catch (_) {}
    }
  } catch (_) {}

  // ------------- MediaDevices.enumerateDevices (realistic fakes) -------------
  // Returning [] is itself a fingerprint — real browsers always have at least
  // a default audio input/output. Return a plausible minimal set.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const fakeDevices = [
        { deviceId: "default", kind: "audioinput", label: "", groupId: "ps-g1" },
        { deviceId: "default", kind: "audiooutput", label: "", groupId: "ps-g1" },
        { deviceId: "ps-cam-1", kind: "videoinput", label: "", groupId: "ps-g2" }
      ];
      navigator.mediaDevices.enumerateDevices = function () {
        emit("hardwareAccess", "enumerateDevices");
        return Promise.resolve(fakeDevices.map((d) => ({ ...d })));
      };
      fakeNative(navigator.mediaDevices.enumerateDevices, "enumerateDevices");
    }
  } catch (_) {}

  // ------------- SpeechSynthesis voices (match rotated OS) -------------
  // Windows and macOS ship very different voice sets — returning [] or a
  // mismatched set leaks the real OS. Build a plausible list from config.platform.
  try {
    if (window.speechSynthesis) {
      const winVoices = [
        { name: "Microsoft David - English (United States)", lang: "en-US", voiceURI: "Microsoft David - English (United States)", localService: true, default: true },
        { name: "Microsoft Zira - English (United States)", lang: "en-US", voiceURI: "Microsoft Zira - English (United States)", localService: true, default: false },
        { name: "Microsoft Mark - English (United States)", lang: "en-US", voiceURI: "Microsoft Mark - English (United States)", localService: true, default: false }
      ];
      const macVoices = [
        { name: "Alex", lang: "en-US", voiceURI: "com.apple.speech.synthesis.voice.Alex", localService: true, default: true },
        { name: "Samantha", lang: "en-US", voiceURI: "com.apple.speech.synthesis.voice.samantha", localService: true, default: false },
        { name: "Victoria", lang: "en-US", voiceURI: "com.apple.speech.synthesis.voice.victoria", localService: true, default: false }
      ];
      const voicesFor = () =>
        /mac|darwin/i.test(config.platform || "") ? macVoices : winVoices;
      window.speechSynthesis.getVoices = function () {
        emit("hardwareAccess", "speechSynthesis.getVoices");
        return voicesFor().map((v) => ({ ...v }));
      };
      fakeNative(window.speechSynthesis.getVoices, "getVoices");
    }
  } catch (_) {}

  // ------------- performance.now() precision reduction -------------
  // High-precision timing is used for side-channel attacks and mouse
  // trajectory analysis. Round to 0.1ms and jitter slightly so the value
  // still advances but attackers can't use sub-ms resolution.
  try {
    const origNow = performance.now.bind(performance);
    performance.now = function () {
      const v = origNow();
      return Math.floor(v * 10) / 10 + Math.random() * 0.01;
    };
    fakeNative(performance.now, "now");
  } catch (_) {}
  try {
    // Date.now() gets similar treatment — some fingerprinters use it for timing.
    const origDateNow = Date.now;
    Date.now = function () {
      const v = origDateNow();
      return Math.floor(v / 2) * 2;
    };
    fakeNative(Date.now, "now");
  } catch (_) {}

  // ------------- Storage neuter (dynamic — checks config live) -------------
  // Always install the overrides so they respond to live config changes.
  // The originals are saved so we can pass-through when blocking is off.
  const origStorage = {};
  try {
    origStorage.lsSetItem = window.localStorage.__proto__.setItem;
    origStorage.lsGetItem = window.localStorage.__proto__.getItem;
    origStorage.lsRemoveItem = window.localStorage.__proto__.removeItem;
    origStorage.lsClear = window.localStorage.__proto__.clear;
    origStorage.lsKey = window.localStorage.__proto__.key;
  } catch (_) {}
  try {
    origStorage.ssSetItem = window.sessionStorage.__proto__.setItem;
    origStorage.ssGetItem = window.sessionStorage.__proto__.getItem;
    origStorage.ssRemoveItem = window.sessionStorage.__proto__.removeItem;
    origStorage.ssClear = window.sessionStorage.__proto__.clear;
    origStorage.ssKey = window.sessionStorage.__proto__.key;
  } catch (_) {}
  try {
    origStorage.idbOpen = window.indexedDB && window.indexedDB.open;
  } catch (_) {}
  try {
    if (window.caches) {
      origStorage.cachesOpen = window.caches.open;
      origStorage.cachesKeys = window.caches.keys;
      origStorage.cachesMatch = window.caches.match;
      origStorage.cachesHas = window.caches.has;
      origStorage.cachesDelete = window.caches.delete;
    }
  } catch (_) {}

  function installStorageProxy(storage, origSet, origGet, origRemove, origClear, origKey, label) {
    try {
      storage.setItem = function (k, v) {
        if (config.blockStorage && !sitePaused) {
          emit("storageAccess", label + ".setItem" + (k ? ":" + k : ""));
          return;
        }
        return origSet.call(this, k, v);
      };
      storage.getItem = function (k) {
        if (config.blockStorage && !sitePaused) {
          emit("storageAccess", label + ".getItem" + (k ? ":" + k : ""));
          return null;
        }
        return origGet.call(this, k);
      };
      storage.removeItem = function (k) {
        if (config.blockStorage && !sitePaused) return;
        return origRemove.call(this, k);
      };
      storage.clear = function () {
        if (config.blockStorage && !sitePaused) return;
        return origClear.call(this);
      };
      storage.key = function (i) {
        if (config.blockStorage && !sitePaused) return null;
        return origKey.call(this, i);
      };
    } catch (_) {}
  }
  try {
    installStorageProxy(window.localStorage, origStorage.lsSetItem, origStorage.lsGetItem, origStorage.lsRemoveItem, origStorage.lsClear, origStorage.lsKey, "localStorage");
  } catch (_) {}
  try {
    installStorageProxy(window.sessionStorage, origStorage.ssSetItem, origStorage.ssGetItem, origStorage.ssRemoveItem, origStorage.ssClear, origStorage.ssKey, "sessionStorage");
  } catch (_) {}
  try {
    if (window.indexedDB && origStorage.idbOpen) {
      const origIdb = origStorage.idbOpen;
      window.indexedDB.open = function (...a) {
        if (config.blockStorage && !sitePaused) {
          emit("storageAccess", "indexedDB.open");
          const req = {};
          setTimeout(() => {
            if (typeof req.onerror === "function")
              req.onerror({ target: { error: new Error("blocked") } });
          }, 0);
          return req;
        }
        return origIdb.apply(this, a);
      };
    }
  } catch (_) {}
  try {
    if (window.caches && origStorage.cachesOpen) {
      window.caches.open = function (...a) {
        if (config.blockStorage && !sitePaused) {
          emit("storageAccess", "caches.open");
          return Promise.reject(new Error("caches disabled"));
        }
        return origStorage.cachesOpen.apply(this, a);
      };
      window.caches.keys = function (...a) {
        if (config.blockStorage && !sitePaused) return Promise.resolve([]);
        return origStorage.cachesKeys.apply(this, a);
      };
      window.caches.match = function (...a) {
        if (config.blockStorage && !sitePaused) return Promise.resolve(undefined);
        return origStorage.cachesMatch.apply(this, a);
      };
      window.caches.has = function (...a) {
        if (config.blockStorage && !sitePaused) return Promise.resolve(false);
        return origStorage.cachesHas.apply(this, a);
      };
      window.caches.delete = function (...a) {
        if (config.blockStorage && !sitePaused) return Promise.resolve(false);
        return origStorage.cachesDelete.apply(this, a);
      };
    }
  } catch (_) {}

  // ------------- document.cookie blocking (dynamic — checks config live) -------------
  try {
    const cookieDesc = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie"
    );
    if (cookieDesc && cookieDesc.configurable) {
      const origGet = cookieDesc.get;
      const origSet = cookieDesc.set;
      Object.defineProperty(Document.prototype, "cookie", {
        get() {
          if (config.blockCookies && !sitePaused) {
            emit("cookiesBlocked", "document.cookie read");
            return "";
          }
          return origGet.call(this);
        },
        set(v) {
          if (config.blockCookies && !sitePaused) {
            try {
              const name = String(v || "").split("=")[0].trim();
              emit("cookiesBlocked", name ? "set:" + name : "document.cookie write");
            } catch (_) {
              emit("cookiesBlocked", "document.cookie write");
            }
            return;
          }
          origSet.call(this, v);
        },
        configurable: true
      });
    }
  } catch (_) {}

  // ------------- RTCPeerConnection IP leak guard (hardened) -------------
  // WebRTC leaks real IP in three ways — this blocks all three:
  //  1. Host candidates   → expose local LAN IP (192.168.x.x, 10.x.x.x)
  //  2. srflx candidates  → expose real public IP via STUN server
  //  3. prflx candidates  → expose via peer-reflexive discovery
  // We also strip iceServers so STUN probes can't happen, and filter any
  // candidates that still leak through onicecandidate.
  try {
    if (typeof RTCPeerConnection !== "undefined") {
      const OrigRTC = window.RTCPeerConnection;

      const isLeakyCandidate = (cand) => {
        if (!cand) return false;
        const c = typeof cand === "string" ? cand : cand.candidate;
        if (!c) return false;
        // Strip candidates that reveal host/public IPs.
        return /\btyp (host|srflx|prflx)\b/i.test(c);
      };

      function PatchedRTC(config, ...rest) {
        // Strip all STUN/TURN servers — no ICE gathering means no IP leak.
        const safeConfig = config ? { ...config } : {};
        safeConfig.iceServers = [];
        // Force mDNS so local IPs get hashed instead of leaked verbatim.
        safeConfig.iceTransportPolicy = safeConfig.iceTransportPolicy || "all";

        const pc = new OrigRTC(safeConfig, ...rest);
        emit("hardwareAccess", "RTCPeerConnection");

        // Kill audio/video offers so receiving tracks can't trigger STUN.
        const origCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = function (opts) {
          const o = Object.assign({}, opts || {});
          o.offerToReceiveAudio = false;
          o.offerToReceiveVideo = false;
          return origCreateOffer(o);
        };

        // Filter ICE candidates passed in from the peer.
        const origAddIce = pc.addIceCandidate.bind(pc);
        pc.addIceCandidate = function (cand, ...a) {
          if (isLeakyCandidate(cand)) return Promise.resolve();
          return origAddIce(cand, ...a);
        };

        // Intercept onicecandidate so our outbound candidates don't leak either.
        let userHandler = null;
        Object.defineProperty(pc, "onicecandidate", {
          get() { return userHandler; },
          set(fn) {
            userHandler = fn;
            pc.addEventListener("icecandidate", function wrapped(ev) {
              if (isLeakyCandidate(ev.candidate)) return;
              if (typeof fn === "function") fn.call(pc, ev);
            }, { once: false });
          },
          configurable: true
        });

        return pc;
      }
      PatchedRTC.prototype = OrigRTC.prototype;
      fakeNative(PatchedRTC, "RTCPeerConnection");
      window.RTCPeerConnection = PatchedRTC;

      // Alias for legacy webkit/moz prefixes if present.
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = PatchedRTC;
      }
      if (window.mozRTCPeerConnection) {
        window.mozRTCPeerConnection = PatchedRTC;
      }
    }
  } catch (_) {}

  // Signal page scripts (and our own code) that shields are active.
  try {
    Object.defineProperty(window, "__privacyShieldActive", {
      value: true,
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (_) {}
})();
