"use strict";

// Browser-only preview shim. Electron provides window.electronAPI through
// renderer-preload.js; this file fills that gap when profiles.html is opened
// from localhost for responsive layout testing.
(() => {
  if (window.electronAPI) return;

  const STORAGE_KEY = "privacy-shield-preview-state-v2";
  const listeners = new Set();

  const webglPresets = [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" }
  ];

  const defaultFingerprint = () => ({
    browser: "chrome",
    userAgent: "auto",
    userAgentValue: "",
    canvas: "noise",
    webgl: "noise",
    webglInfo: "manual",
    webglVendor: webglPresets[0].vendor,
    webglRenderer: webglPresets[0].renderer,
    webgpu: false,
    audio: "noise",
    clientRects: "real",
    timezone: "manual",
    timezoneValue: "Africa/Lagos",
    timezoneOffset: -60,
    language: "manual",
    languageValue: "en-US",
    geolocation: "manual",
    geoLat: 6.5244,
    geoLng: 3.3792,
    geoAccuracy: 50,
    cpuCores: "manual",
    cpuCoresValue: 8,
    ram: "manual",
    ramValue: 16,
    screen: "manual",
    screenWidth: 390,
    screenHeight: 844,
    mediaDevices: "real",
    cameras: 1,
    microphones: 1,
    speakers: 1,
    fonts: "real",
    deviceName: "off",
    deviceNameValue: "",
    hardwareId: "",
    fontProfile: "windows",
    installedFonts: [],
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1,
    deviceClass: "desktop",
    mobileModel: "",
    mobileManufacturer: "",
    platformVersion: "",
    androidBuild: "",
    architecture: "x86",
    bitness: "64",
    maxTouchPoints: 0,
    screenOrientation: "landscape-primary",
    touchEmulation: false,
    sensorEmulation: false,
    viewportMobile: false,
    pointerType: "fine",
    hoverType: "hover",
    deviceMotion: null,
    deviceOrientation: null,
    connectionType: "wifi",
    downlink: 10,
    rtt: 50,
    ports: "block",
    blockedPorts: [3389, 5938],
    doNotTrack: false,
    webrtc: "altered",
    webrtcIP: "",
    blockCookies: false,
    blockStorage: false,
    browserVersion: "148",
    city: "Lagos",
    state: "Lagos State",
    ispName: "Preview ISP",
    ispAsn: "36873",
    ispOrg: "Privacy Shield Preview"
  });

  const defaultProxy = () => ({
    networkMode: "direct",
    enabled: false,
    scheme: "socks5",
    host: "",
    port: 1080,
    username: "",
    password: "",
    rotationUrl: "",
    bypassList: []
  });

  const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const seedState = () => ({
    profiles: [
      {
        id: "preview_lagos",
        name: "Lagos Mobile Preview",
        status: "active",
        os: "windows",
        browserApp: "chrome",
        windowMode: "normal",
        tags: ["preview", "mobile"],
        notes: "Browser preview data. Electron-only browser windows are simulated here.",
        fingerprint: defaultFingerprint(),
        proxy: defaultProxy(),
        cookies: [],
        session: {
          lastSaved: Date.now(),
          tabs: [
            { title: "Pixelscan", url: "https://pixelscan.net/", active: true },
            { title: "Fiverr", url: "https://www.fiverr.com/" }
          ]
        },
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ],
    proxies: [],
    vpsProxies: [],
    cloudPhones: [],
    proxyProvider: {
      endpoint: "",
      authMode: "bearer",
      hasToken: false
    },
    cloudPhoneProvider: {
      endpoint: "",
      authMode: "bearer",
      hasToken: false
    },
    windows: {}
  });

  const save = (state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  const load = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed && Array.isArray(parsed.profiles)) return parsed;
    } catch (_) {}
    const state = seedState();
    save(state);
    return state;
  };

  const emitWindowsChanged = () => listeners.forEach((cb) => cb({ type: "WINDOWS_CHANGED" }));

  const createProfile = (state, data = {}) => {
    const now = Date.now();
    const profile = {
      id: data.id || makeId("profile"),
      name: data.name || "New Profile",
      status: data.status || "new",
      os: data.os || "windows",
      browserApp: data.browserApp || "chrome",
      windowMode: data.windowMode || "normal",
      tags: Array.isArray(data.tags) ? data.tags : [],
      notes: data.notes || "",
      fingerprint: { ...defaultFingerprint(), ...(data.fingerprint || {}) },
      proxy: { ...defaultProxy(), ...(data.proxy || {}) },
      cookies: Array.isArray(data.cookies) ? data.cookies : [],
      session: data.session || null,
      createdAt: data.createdAt || now,
      updatedAt: now
    };
    state.profiles.push(profile);
    return profile;
  };

  const randomProfileData = (country, index, options = {}) => {
    const fp = defaultFingerprint();
    const deviceClass = options.deviceClass === "mobile" || options.deviceClass === "android"
      ? "mobile"
      : options.deviceClass === "random" && Math.random() < 0.25 ? "mobile" : "desktop";
    const countryMap = {
      us: ["United States", "North America", "America/New_York", 300, "en-US", "New York", "New York", 40.7128, -74.006, "Comcast Cable Communications", "7922", "Comcast Cable"],
      gb: ["United Kingdom", "Europe", "Europe/London", 0, "en-GB", "London", "England", 51.5074, -0.1278, "BT Group plc", "2856", "BT Group plc"],
      de: ["Germany", "Europe", "Europe/Berlin", -60, "de-DE", "Berlin", "Berlin", 52.52, 13.405, "Deutsche Telekom AG", "3320", "Deutsche Telekom AG"],
      nl: ["Netherlands", "Europe", "Europe/Amsterdam", -60, "nl-NL", "Amsterdam", "North Holland", 52.3676, 4.9041, "KPN Netherlands", "1136", "KPN Netherlands"],
      fr: ["France", "Europe", "Europe/Paris", -60, "fr-FR", "Paris", "Ile-de-France", 48.8566, 2.3522, "Orange S.A.", "3215", "Orange S.A."],
      ch: ["Switzerland", "Europe", "Europe/Zurich", -60, "de-DE", "Zurich", "Zurich", 47.3769, 8.5417, "Swisscom AG", "3303", "Swisscom AG"],
      se: ["Sweden", "Europe", "Europe/Stockholm", -60, "sv-SE", "Stockholm", "Stockholm", 59.3293, 18.0686, "Telia Company AB", "1257", "Telia Company AB"],
      ca: ["Canada", "North America", "America/Toronto", 300, "en-CA", "Toronto", "Ontario", 43.6532, -79.3832, "Rogers Communications Inc.", "812", "Rogers Communications"],
      au: ["Australia", "Oceania", "Australia/Sydney", -600, "en-AU", "Sydney", "New South Wales", -33.8688, 151.2093, "Telstra Corporation Ltd", "1221", "Telstra Corporation"],
      jp: ["Japan", "Asia", "Asia/Tokyo", -540, "ja-JP", "Tokyo", "Tokyo", 35.6762, 139.6503, "NTT Communications Corporation", "2914", "NTT Communications"],
      sg: ["Singapore", "Asia", "Asia/Singapore", -480, "en-SG", "Singapore", "Singapore", 1.3521, 103.8198, "Singtel Fibre Broadband", "9506", "Singtel Fibre"],
      br: ["Brazil", "South America", "America/Sao_Paulo", 180, "pt-BR", "Sao Paulo", "Sao Paulo", -23.5505, -46.6333, "Claro NXT Telecomunicacoes Ltda", "28573", "Claro NXT Telecomunicacoes"],
      in: ["India", "Asia", "Asia/Kolkata", -330, "hi-IN", "Mumbai", "Maharashtra", 19.076, 72.8777, "Reliance Jio Infocomm Limited", "55836", "Reliance Jio Infocomm"],
      ae: ["United Arab Emirates", "Asia", "Asia/Dubai", -240, "ar-AE", "Dubai", "Dubai", 25.2048, 55.2708, "Emirates Integrated Telecom", "15802", "du"],
      ru: ["Russia", "Europe", "Europe/Moscow", -180, "ru-RU", "Moscow", "Moscow", 55.7558, 37.6173, "Rostelecom", "12389", "Rostelecom"],
      tr: ["Turkey", "Asia", "Europe/Istanbul", -180, "tr-TR", "Istanbul", "Istanbul", 41.0082, 28.9784, "Turk Telekomunikasyon A.S.", "9121", "Turk Telekomunikasyon"],
      ng: ["Nigeria", "Africa", "Africa/Lagos", -60, "en-US", "Lagos", "Lagos State", 6.5244, 3.3792, "Airtel Networks Limited", "36873", "Airtel Networks Limited"]
    };
    const preset = countryMap[country] || countryMap.us;
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const screens = deviceClass === "mobile"
      ? [[360, 800], [384, 854], [393, 873], [412, 915]]
      : [[1366, 768], [1440, 900], [1536, 864], [1920, 1080]];
    const screen = screens[Math.floor(Math.random() * screens.length)];
    const osName = deviceClass === "mobile" ? "android" : country === "gb" ? "macos" : "windows";
    const requestedBrowser = options.browserApp || "random";
    const browser = requestedBrowser === "random"
      ? ["chrome", "chrome", "brave", "edge"][Math.floor(Math.random() * 4)]
      : requestedBrowser;
    const compatibleBrowser =
      deviceClass === "mobile" && ["firefox", "safari"].includes(browser) ? "chrome" :
      osName !== "macos" && browser === "safari" ? "chrome" :
      browser;
    fp.browser = compatibleBrowser;
    fp.timezone = "manual";
    fp.timezoneValue = preset[2];
    fp.timezoneOffset = preset[3];
    fp.language = "manual";
    fp.languageValue = preset[4];
    fp.geolocation = "manual";
    fp.geoLat = Number((preset[7] + (Math.random() - 0.5) * 0.04).toFixed(6));
    fp.geoLng = Number((preset[8] + (Math.random() - 0.5) * 0.04).toFixed(6));
    fp.cpuCoresValue = deviceClass === "mobile" ? 8 : [4, 6, 8, 12][Math.floor(Math.random() * 4)];
    fp.ramValue = deviceClass === "mobile" ? [6, 8, 12][Math.floor(Math.random() * 3)] : [8, 16, 32][Math.floor(Math.random() * 3)];
    fp.screenWidth = screen[0];
    fp.screenHeight = screen[1];
    fp.deviceName = "manual";
    fp.deviceNameValue = deviceClass === "mobile" ? `Android-${suffix.slice(0, 5)}` : `DESKTOP-${suffix}`;
    fp.hardwareId = deviceClass === "mobile"
      ? `ANDROID-${suffix}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
      : `{${suffix}-${Math.random().toString(16).slice(2, 6).toUpperCase()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}}`;
    fp.fontProfile = deviceClass === "mobile" ? "android" : country === "gb" ? "macos" : "windows";
    fp.installedFonts = deviceClass === "mobile"
      ? ["Roboto", "Droid Sans", "Noto Sans", "Noto Color Emoji", "Google Sans"]
      : ["Arial", "Calibri", "Cambria", "Consolas", "Courier New", "Georgia", "Segoe UI", "Tahoma", "Times New Roman", "Verdana"];
    fp.colorDepth = 24;
    fp.pixelDepth = 24;
    fp.devicePixelRatio = deviceClass === "mobile" ? [2.625, 2.75, 3][Math.floor(Math.random() * 3)] : [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)];
    fp.deviceClass = deviceClass;
    fp.mobileModel = deviceClass === "mobile" ? ["Pixel 8", "SM-S911B", "SM-A546B", "CPH2449"][Math.floor(Math.random() * 4)] : "";
    fp.mobileManufacturer = deviceClass === "mobile" ? "Android" : "";
    fp.platformVersion = deviceClass === "mobile" ? ["13", "14", "15"][Math.floor(Math.random() * 3)] : "";
    fp.androidBuild = deviceClass === "mobile" ? "UP1A.231005.007" : "";
    fp.architecture = deviceClass === "mobile" ? "arm" : "x86";
    fp.bitness = "64";
    fp.maxTouchPoints = deviceClass === "mobile" ? 5 : 0;
    fp.screenOrientation = deviceClass === "mobile" ? "portrait-primary" : "landscape-primary";
    fp.touchEmulation = deviceClass === "mobile";
    fp.sensorEmulation = deviceClass === "mobile";
    fp.viewportMobile = deviceClass === "mobile";
    fp.pointerType = deviceClass === "mobile" ? "coarse" : "fine";
    fp.hoverType = deviceClass === "mobile" ? "none" : "hover";
    fp.deviceMotion = deviceClass === "mobile"
      ? { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0.01, y: 0.02, z: 9.81 }, rotationRate: { alpha: 0.02, beta: 0.01, gamma: 0.01 }, interval: 16 }
      : null;
    fp.deviceOrientation = deviceClass === "mobile"
      ? { alpha: Math.floor(Math.random() * 360), beta: 0.5, gamma: -0.5, absolute: false }
      : null;
    fp.connectionType = deviceClass === "mobile" ? "cellular" : "wifi";
    fp.downlink = [8.5, 10, 18, 25][Math.floor(Math.random() * 4)];
    fp.rtt = [35, 50, 75, 100][Math.floor(Math.random() * 4)];
    fp.browserVersion = String([131, 136, 140, 144, 148][Math.floor(Math.random() * 5)]);
    fp.city = preset[5];
    fp.state = preset[6];
    fp.ispName = preset[9];
    fp.ispAsn = preset[10];
    fp.ispOrg = preset[11];
    fp.countryCode = country;
    fp.country = preset[0];
    fp.continent = preset[1];
    fp.organization = preset[11];
    fp.ip = "";
    fp.domain = "";
    return {
      name: `${preset[0]} ${deviceClass === "mobile" ? "Mobile" : "Profile"} ${index}`,
      status: "new",
      os: osName,
      browserApp: compatibleBrowser,
      tags: [country, deviceClass, "country-profile"],
      fingerprint: fp,
      proxy: defaultProxy()
    };
  };

  window.electronAPI = {
    onMainEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async invoke(type, data = {}) {
      const state = load();
      let result;

      switch (type) {
        case "PROFILE_WEBGL_PRESETS":
          result = { ok: true, presets: webglPresets };
          break;
        case "ENGINE_CAPABILITIES":
          result = {
            ok: true,
            capabilities: {
              actualEngine: "Browser preview",
              nativeEngines: ["chromium-preview"],
              chromiumCppPatches: false,
              aiDailyFingerprints: false,
              firefoxGeckoRuntime: false
            }
          };
          break;
        case "PROFILE_AUDIT": {
          const profile = data.profile || state.profiles.find((p) => p.id === data.profileId);
          const fp = profile?.fingerprint || {};
          const issues = [];
          const warnings = [];
          const passes = [];
          if (!profile) {
            result = { ok: false, error: "Profile not found" };
            break;
          }
          if (profile.os === "android" && fp.deviceClass !== "mobile") issues.push({ level: "issue", message: "Android profiles should use mobile device class." });
          if ((fp.browser || profile.browserApp) === "firefox") warnings.push({ level: "warn", message: "Firefox is an identity template only in this build." });
          if ((fp.browser || profile.browserApp) === "safari") warnings.push({ level: "warn", message: "Safari is an identity template only in this build." });
          passes.push({ level: "pass", message: "Preview audit completed." });
          result = {
            ok: true,
            audit: {
              ok: issues.length === 0,
              score: Math.max(0, 100 - issues.length * 25 - warnings.length * 8),
              profile: { actualRuntime: "Browser preview" },
              issues,
              warnings,
              passes
            }
          };
          break;
        }
        case "PROFILE_LIST":
          result = {
            ok: true,
            profiles: data.showDeleted ? state.profiles : state.profiles.filter((p) => !p.deletedAt)
          };
          break;
        case "PROFILE_CREATE":
          result = { ok: true, profile: createProfile(state, data.data || {}) };
          save(state);
          break;
        case "PROFILE_COUNTRY_IDENTITY":
          result = { ok: true, data: randomProfileData(String(data.country || "us").toLowerCase(), Number(data.index) || 1, { deviceClass: data.deviceClass, browserApp: data.browserApp || "random" }) };
          break;
        case "PROFILE_UPDATE": {
          const profile = state.profiles.find((p) => p.id === data.id);
          if (!profile) {
            result = { ok: false, error: "Profile not found" };
            break;
          }
          Object.assign(profile, data.data || {}, { updatedAt: Date.now() });
          if (data.data?.fingerprint) profile.fingerprint = { ...defaultFingerprint(), ...profile.fingerprint };
          if (data.data?.proxy) profile.proxy = { ...defaultProxy(), ...profile.proxy };
          save(state);
          result = { ok: true, profile };
          break;
        }
        case "PROFILE_DELETE": {
          const profile = state.profiles.find((p) => p.id === data.id);
          if (data.hard) state.profiles = state.profiles.filter((p) => p.id !== data.id);
          else if (profile) profile.deletedAt = Date.now();
          delete state.windows[data.id];
          save(state);
          emitWindowsChanged();
          result = { ok: true };
          break;
        }
        case "PROFILE_DUPLICATE": {
          const profile = state.profiles.find((p) => p.id === data.id);
          result = profile
            ? { ok: true, profile: createProfile(state, { ...profile, id: makeId("profile"), name: `${profile.name} Copy`, deletedAt: undefined }) }
            : { ok: false, error: "Profile not found" };
          save(state);
          break;
        }
        case "PROFILE_EXPORT_COOKIES": {
          const profile = state.profiles.find((p) => p.id === data.profileId);
          result = { ok: true, cookies: profile?.cookies || [] };
          break;
        }
        case "PROFILE_IMPORT_COOKIES": {
          const profile = state.profiles.find((p) => p.id === data.profileId);
          if (profile) profile.cookies = Array.isArray(data.cookies) ? data.cookies : [];
          save(state);
          result = { ok: Boolean(profile), count: profile?.cookies?.length || 0 };
          break;
        }
        case "PROFILE_CAPTURE_COOKIES":
        case "PROFILE_INJECT_COOKIES":
          result = { ok: true, count: 0 };
          break;
        case "PROFILE_ASSIGN_TAB":
          result = { ok: true };
          break;
        case "PROFILE_GET_WINDOWS":
          result = { ok: true, windows: state.windows || {} };
          break;
        case "PROFILE_OPEN_WINDOW": {
          const profile = state.profiles.find((p) => p.id === data.profileId);
          const url = data.url || "browser-start.html?preview=1&profileId=" + encodeURIComponent(data.profileId || "");
          const popup = window.open(
            url,
            "privacy-shield-preview-" + encodeURIComponent(data.profileId || "profile"),
            "popup,width=1280,height=800"
          );
          if (!popup) {
            result = {
              ok: false,
              error: "Preview popup was blocked. Allow popups for this localhost page, or run the desktop app with npm start."
            };
            break;
          }
          try { popup.document.title = "Privacy Shield Browser - " + (profile?.name || "Profile"); } catch (_) {}
          try { popup.focus(); } catch (_) {}
          state.windows[data.profileId] = `preview-window-${data.profileId}`;
          save(state);
          emitWindowsChanged();
          result = { ok: true, windowId: state.windows[data.profileId], preview: true };
          break;
        }
        case "PROFILE_CLOSE_WINDOW":
          delete state.windows[data.profileId];
          save(state);
          emitWindowsChanged();
          result = { ok: true, count: 1 };
          break;
        case "PROFILE_CLEAR_BROWSER_DATA": {
          const profile = state.profiles.find((p) => p.id === data.profileId);
          if (profile) {
            profile.cookies = [];
            profile.localStorageData = {};
            profile.session = null;
          }
          save(state);
          result = { ok: Boolean(profile) };
          break;
        }
        case "PROFILE_SAVE_SESSION": {
          const profile = state.profiles.find((p) => p.id === data.profileId);
          if (profile) {
            profile.session = {
              lastSaved: Date.now(),
              tabs: [{ title: "Preview saved tab", url: "https://pixelscan.net/", active: true }]
            };
          }
          save(state);
          result = { ok: Boolean(profile), count: profile ? 1 : 0 };
          break;
        }
        case "PROFILE_BULK_CREATE": {
          const count = Math.max(1, Math.min(100, Number(data.count) || 10));
          const countries = ["us", "gb", "de", "ng"];
          const requestedMode = String(data.networkMode || "").toLowerCase();
          const networkMode = ["proxy", "vpn", "direct"].includes(requestedMode)
            ? requestedMode
            : (data.assignProxies ? "proxy" : "direct");
          for (let i = 0; i < count; i++) {
            const country = data.country === "random" ? countries[i % countries.length] : (data.country || "us");
            const profileData = randomProfileData(country, i + 1, {
              deviceClass: data.deviceClass,
              browserApp: data.browserApp || "random"
            });
            if (networkMode === "vpn") {
              profileData.proxy = { ...defaultProxy(), networkMode: "vpn", enabled: false };
              profileData.fingerprint = {
                ...profileData.fingerprint,
                ip: "preview-only",
                country: "Nigeria",
                countryCode: "ng",
                continent: "Africa",
                city: "Lagos",
                state: "Lagos",
                timezone: "manual",
                timezoneValue: "Africa/Lagos",
                timezoneOffset: -60,
                language: "manual",
                languageValue: "en-NG",
                geolocation: "manual",
                geoLat: 6.5244,
                geoLng: 3.3792,
                ispName: "Preview VPN",
                ispAsn: "preview",
                ispOrg: "Privacy Shield Preview"
              };
            } else if (networkMode === "proxy") {
              profileData.proxy = { ...defaultProxy(), networkMode: "proxy", enabled: false };
            }
            createProfile(state, profileData);
          }
          save(state);
          result = { ok: true, created: count };
          break;
        }
        case "PROXY_LIB_GET":
          result = { ok: true, library: state.proxies || [] };
          break;
        case "PROXY_LIB_ADD": {
          const entry = { id: makeId("proxy"), ...(data.entry || {}) };
          state.proxies.push(entry);
          save(state);
          result = { ok: true, entry };
          break;
        }
        case "PROXY_LIB_UPDATE": {
          const entry = state.proxies.find((p) => p.id === data.id);
          if (entry) Object.assign(entry, data.data || {});
          save(state);
          result = { ok: Boolean(entry), entry };
          break;
        }
        case "PROXY_LIB_DELETE":
          state.proxies = state.proxies.filter((p) => p.id !== data.id);
          save(state);
          result = { ok: true };
          break;
        case "PROXY_PROVIDER_GET":
          result = { ok: true, config: state.proxyProvider || { endpoint: "", authMode: "bearer", hasToken: false } };
          break;
        case "PROXY_PROVIDER_SAVE":
          state.proxyProvider = {
            endpoint: data.config?.endpoint || "",
            authMode: data.config?.authMode || "bearer",
            hasToken: Boolean(data.config?.token) || Boolean(state.proxyProvider?.hasToken)
          };
          save(state);
          result = { ok: true, config: state.proxyProvider };
          break;
        case "PROXY_GENERATE_PRIVATE": {
          const country = String(data.country || "us").toLowerCase();
          const candidates = (state.proxies || [])
            .filter((p) => p.host && p.port && p.private !== false && p.source === "vps")
            .filter((p) => p.country === country || p.country === "");
          const entry = candidates[0];
          result = entry
            ? { ok: true, entry, source: "vps", warning: "Preview selected a saved VPS proxy record. Install the desktop app to test it for real." }
            : { ok: false, error: "No private VPS proxy for this country. Add and install a VPS proxy in the desktop app first." };
          break;
        }
        case "TEST_PROXY":
          result = { ok: false, error: "Proxy testing only works in the installed desktop app, not the localhost preview." };
          break;
        case "NETWORK_CAPTURE_CURRENT":
          result = {
            ok: true,
            network: {
              ip: "preview-only",
              country: "Nigeria",
              countryCode: "ng",
              continent: "Africa",
              city: "Lagos",
              state: "Lagos State",
              latitude: 6.5244,
              longitude: 3.3792,
              timezone: "Africa/Lagos",
              ispName: "Preview ISP",
              ispAsn: "36873",
              ispOrg: "Privacy Shield Preview",
              organization: "Privacy Shield Preview"
            }
          };
          break;
        case "CLOUD_PHONE_PROVIDER_GET":
          result = { ok: true, config: state.cloudPhoneProvider || { endpoint: "", authMode: "bearer", hasToken: false } };
          break;
        case "CLOUD_PHONE_PROVIDER_SAVE":
          state.cloudPhoneProvider = {
            endpoint: data.config?.endpoint || "",
            authMode: data.config?.authMode || "bearer",
            hasToken: Boolean(data.config?.token) || Boolean(state.cloudPhoneProvider?.hasToken)
          };
          save(state);
          result = { ok: true, config: state.cloudPhoneProvider };
          break;
        case "CLOUD_PHONE_LIST":
          result = { ok: true, phones: state.cloudPhones || [] };
          break;
        case "CLOUD_PHONE_UPSERT": {
          const phone = { ...(data.phone || {}) };
          state.cloudPhones = Array.isArray(state.cloudPhones) ? state.cloudPhones : [];
          phone.id = phone.id || makeId("cloud_phone");
          phone.updatedAt = Date.now();
          phone.createdAt = phone.createdAt || Date.now();
          const idx = (state.cloudPhones || []).findIndex((item) => item.id === phone.id);
          if (idx === -1) state.cloudPhones.push(phone);
          else state.cloudPhones[idx] = { ...state.cloudPhones[idx], ...phone };
          save(state);
          result = { ok: true, phone: idx === -1 ? phone : state.cloudPhones[idx] };
          break;
        }
        case "CLOUD_PHONE_DELETE":
          state.cloudPhones = (state.cloudPhones || []).filter((phone) => phone.id !== data.id);
          save(state);
          result = { ok: true };
          break;
        case "CLOUD_PHONE_OPEN": {
          const phone = (state.cloudPhones || []).find((item) => item.id === data.id);
          if (!phone?.remoteUrl) {
            result = { ok: false, error: "Preview cloud phone needs a console URL first." };
            break;
          }
          const popup = window.open(phone.remoteUrl, "privacy-shield-cloud-phone-" + encodeURIComponent(data.id || "phone"), "popup,width=430,height=900");
          result = popup ? { ok: true, preview: true } : { ok: false, error: "Preview popup was blocked." };
          break;
        }
        case "VPS_PROXY_LIST":
          result = { ok: true, records: state.vpsProxies || [] };
          break;
        case "VPS_PROXY_TEST_SSH":
        case "VPS_PROXY_INSTALL":
        case "VPS_PROXY_TEST":
          result = { ok: false, error: "VPS SSH install and proxy testing only work in the installed desktop app, not the localhost preview." };
          break;
        case "VPS_PROXY_DELETE":
          state.vpsProxies = (state.vpsProxies || []).filter((p) => p.id !== data.id);
          state.proxies = (state.proxies || []).filter((p) => p.vpsId !== data.id);
          save(state);
          result = { ok: true };
          break;
        case "AUTH_SESSION":
          result = { ok: true, session: { userId: "preview-user", email: "preview@privacy-shield.local" } };
          break;
        case "AUTH_DO_LOGOUT":
        case "AUTH_LOGOUT":
        case "CLOUD_SYNC_NOW":
          result = { ok: true };
          break;
        default:
          console.warn("[browser-preview] Unhandled IPC", type, data);
          result = { ok: true };
      }

      return result;
    }
  };
})();
