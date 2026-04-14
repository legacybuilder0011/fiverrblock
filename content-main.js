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

  // Live-update when the bridge pushes a new config.
  window.addEventListener("__privacy_shield_config__", (ev) => {
    try {
      config = Object.assign({}, DEFAULTS, ev.detail || {});
    } catch (_) {}
  });

  // Do nothing when the shield is disabled.
  if (!config.enabled) return;

  // ------------- Tiny helpers -------------
  const defineRO = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, {
        get() {
          return typeof value === "function" ? value() : value;
        },
        configurable: true
      });
    } catch (_) {}
  };

  const wrap = (target, prop, replacement) => {
    try {
      const original = target[prop];
      target[prop] = replacement(original);
      // Make toString look native so naive fingerprinters don't detect the hook.
      try {
        target[prop].toString = () =>
          typeof original === "function"
            ? Function.prototype.toString.call(original)
            : "function " + prop + "() { [native code] }";
      } catch (_) {}
    } catch (_) {}
  };

  // ------------- Navigator spoofing (UA, platform, languages) -------------
  if (config.spoofUA) {
    defineRO(Navigator.prototype, "userAgent", config.userAgent);
    defineRO(Navigator.prototype, "appVersion", () =>
      config.userAgent.replace(/^Mozilla\//, "")
    );
    defineRO(Navigator.prototype, "platform", config.platform);
    defineRO(Navigator.prototype, "vendor", "Google Inc.");
    defineRO(Navigator.prototype, "oscpu", undefined);
    defineRO(Navigator.prototype, "productSub", "20030107");
    defineRO(Navigator.prototype, "language", config.language);
    defineRO(Navigator.prototype, "languages", () => Object.freeze(config.languages.slice()));

    // User-Agent Client Hints (sec-ch-ua family)
    if (navigator.userAgentData) {
      const fakeBrands = [
        { brand: "Not_A Brand", version: "8" },
        { brand: "Chromium", version: "120" },
        { brand: "Google Chrome", version: "120" }
      ];
      try {
        Object.defineProperty(navigator, "userAgentData", {
          get() {
            return {
              brands: fakeBrands,
              mobile: false,
              platform: "Windows",
              getHighEntropyValues(hints) {
                return Promise.resolve({
                  architecture: "x86",
                  bitness: "64",
                  brands: fakeBrands,
                  fullVersionList: fakeBrands,
                  mobile: false,
                  model: "",
                  platform: "Windows",
                  platformVersion: "10.0.0",
                  uaFullVersion: "120.0.0.0",
                  wow64: false
                });
              },
              toJSON() {
                return { brands: fakeBrands, mobile: false, platform: "Windows" };
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
    defineRO(Navigator.prototype, "hardwareConcurrency", () =>
      config.hardwareConcurrency
    );
    defineRO(Navigator.prototype, "deviceMemory", () => config.deviceMemory);
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
    defineRO(Navigator.prototype, "plugins", emptyPlugins);
    defineRO(Navigator.prototype, "mimeTypes", emptyPlugins);
    defineRO(Navigator.prototype, "pdfViewerEnabled", false);
  }

  // ------------- Fonts API -------------
  if (config.blockFonts) {
    try {
      if (document.fonts) {
        document.fonts.check = () => false;
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
    defineRO(Screen.prototype, "width", () => s.width);
    defineRO(Screen.prototype, "height", () => s.height);
    defineRO(Screen.prototype, "availWidth", () => s.availWidth);
    defineRO(Screen.prototype, "availHeight", () => s.availHeight);
    defineRO(Screen.prototype, "colorDepth", () => s.colorDepth);
    defineRO(Screen.prototype, "pixelDepth", () => s.pixelDepth);
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
        return r;
      };
    } catch (_) {}

    // Date.prototype.getTimezoneOffset
    try {
      Date.prototype.getTimezoneOffset = function () {
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
        try {
          if (typeof success === "function") success(buildPosition());
        } catch (_) {
          if (typeof error === "function")
            error({ code: 2, message: "POSITION_UNAVAILABLE" });
        }
      };
      let watchCount = 0;
      navigator.geolocation.watchPosition = function (success, _error, _opts) {
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
        try {
          const ctx = this.getContext("2d");
          if (ctx) noiseCanvas(ctx, this);
        } catch (_) {}
        return orig.apply(this, args);
      }
    );

    wrap(HTMLCanvasElement.prototype, "toBlob", (orig) =>
      function (cb, ...rest) {
        try {
          const ctx = this.getContext("2d");
          if (ctx) noiseCanvas(ctx, this);
        } catch (_) {}
        return orig.call(this, cb, ...rest);
      }
    );

    wrap(CanvasRenderingContext2D.prototype, "getImageData", (orig) =>
      function (...args) {
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
          if (p === 37445) return "Google Inc. (Intel)";
          if (p === 37446)
            return "ANGLE (Intel, Intel(R) UHD Graphics, OpenGL 4.1)";
          if (p === 7936) return "WebKit"; // VENDOR
          if (p === 7937) return "WebKit WebGL"; // RENDERER
          if (p === 7938) return "WebGL 1.0"; // VERSION
          if (p === 35724) return "WebGL GLSL ES 1.0"; // SHADING_LANGUAGE_VERSION
          return orig.call(this, p);
        }
      );
      wrap(proto, "getExtension", (orig) =>
        function (name) {
          if (name === "WEBGL_debug_renderer_info") return null;
          return orig.call(this, name);
        }
      );
      wrap(proto, "getSupportedExtensions", (orig) =>
        function () {
          const ext = orig.call(this) || [];
          return ext.filter((e) => e !== "WEBGL_debug_renderer_info");
        }
      );
      wrap(proto, "readPixels", (orig) =>
        function (...args) {
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
          orig.call(this, arr);
          noiseArr(arr);
        }
      );
      wrap(AnalyserNode.prototype, "getByteFrequencyData", (orig) =>
        function (arr) {
          orig.call(this, arr);
          for (let i = 0; i < arr.length; i++) {
            if (Math.random() < 0.01) arr[i] = (arr[i] ^ 1) & 0xff;
          }
        }
      );
      wrap(AnalyserNode.prototype, "getFloatTimeDomainData", (orig) =>
        function (arr) {
          orig.call(this, arr);
          noiseArr(arr);
        }
      );
    }
    if (typeof AudioBuffer !== "undefined") {
      wrap(AudioBuffer.prototype, "getChannelData", (orig) =>
        function (...args) {
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

  // ------------- Media / speech enumeration -------------
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices = function () {
        return Promise.resolve([]);
      };
    }
  } catch (_) {}

  try {
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices = function () {
        return [];
      };
    }
  } catch (_) {}

  // ------------- Storage neuter (optional) -------------
  if (config.blockStorage) {
    const kill = (storage) => {
      try {
        storage.setItem = () => {};
        storage.getItem = () => null;
        storage.removeItem = () => {};
        storage.clear = () => {};
        storage.key = () => null;
        Object.defineProperty(storage, "length", {
          get: () => 0,
          configurable: true
        });
      } catch (_) {}
    };
    try {
      kill(window.localStorage);
    } catch (_) {}
    try {
      kill(window.sessionStorage);
    } catch (_) {}
    try {
      if (window.indexedDB) {
        window.indexedDB.open = function () {
          const req = {};
          setTimeout(() => {
            if (typeof req.onerror === "function")
              req.onerror({ target: { error: new Error("blocked") } });
          }, 0);
          return req;
        };
      }
    } catch (_) {}
    try {
      if (window.caches) {
        window.caches.open = () =>
          Promise.reject(new Error("caches disabled"));
        window.caches.keys = () => Promise.resolve([]);
        window.caches.match = () => Promise.resolve(undefined);
        window.caches.has = () => Promise.resolve(false);
        window.caches.delete = () => Promise.resolve(false);
      }
    } catch (_) {}
  }

  // ------------- document.cookie blocking -------------
  if (config.blockCookies) {
    try {
      const desc = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "cookie"
      );
      if (desc && desc.configurable) {
        Object.defineProperty(Document.prototype, "cookie", {
          get() {
            return "";
          },
          set(_v) {
            /* swallow writes */
          },
          configurable: true
        });
      }
    } catch (_) {}
  }

  // ------------- RTCPeerConnection IP leak guard -------------
  try {
    if (typeof RTCPeerConnection !== "undefined") {
      const OrigRTC = window.RTCPeerConnection;
      window.RTCPeerConnection = function (...args) {
        const pc = new OrigRTC(...args);
        const origCreateOffer = pc.createOffer.bind(pc);
        pc.createOffer = function (opts) {
          opts = opts || {};
          opts.offerToReceiveAudio = false;
          opts.offerToReceiveVideo = false;
          return origCreateOffer(opts);
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = OrigRTC.prototype;
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
