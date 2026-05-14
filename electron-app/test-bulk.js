// Simulate what bulkCreateProfiles does, without Electron
process.env.TEST_MODE = "1";

// Mock app.getPath for testing outside Electron
const path = require("path");
const os = require("os");
const mockDataDir = path.join(os.tmpdir(), "ps-test-" + Date.now());

// Patch electron before requiring store
require("module").Module._resolveFilename = ((orig) => (req, parent, isMain, opts) => {
  if (req === "electron") return req;
  return orig(req, parent, isMain, opts);
})(require("module").Module._resolveFilename);

const Module = require("module");
const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === "electron") {
    return {
      app: { getPath: () => mockDataDir },
      ipcMain: { handle: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      WebContentsView: class {},
      net: {}
    };
  }
  return origLoad.apply(this, arguments);
};

const fs = require("fs");
fs.mkdirSync(mockDataDir, { recursive: true });

// Write a fake session so getCurrentUserDataDir works
const sessionDir = path.join(mockDataDir, "privacy-shield");
fs.mkdirSync(sessionDir, { recursive: true });
const fakeUserId = "test-user-123";
fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ userId: fakeUserId, email: "test@test.com", loginAt: Date.now() }));
fs.mkdirSync(path.join(sessionDir, "users", fakeUserId), { recursive: true });

const store = require("./src/profile-store");

function randomProfileData(country, idx) {
  const COUNTRY_TZ = { us:"America/New_York", gb:"Europe/London", de:"Europe/Berlin" };
  const COUNTRY_LANG = { us:"en-US", gb:"en-GB", de:"de-DE" };
  const SCREENS = [[1920,1080],[1366,768]];
  const screen = SCREENS[Math.floor(Math.random() * SCREENS.length)];
  const fp = store.getDefaultFingerprint();
  fp.timezone = "manual"; fp.timezoneValue = COUNTRY_TZ[country] || "UTC";
  fp.language = "manual"; fp.languageValue = COUNTRY_LANG[country] || "en-US";
  fp.screen = "manual"; fp.screenWidth = screen[0]; fp.screenHeight = screen[1];
  fp.cpuCores = "manual"; fp.cpuCoresValue = 4;
  fp.ram = "manual"; fp.ramValue = 8;
  fp.browserVersion = "148";
  return { name: `${country.toUpperCase()} Profile ${idx}`, os: "windows", browserApp: "chrome", status: "new", fingerprint: fp };
}

async function test() {
  try {
    const count = 3, country = "us", assignProxies = false;
    const n = Math.max(1, Math.min(100, parseInt(count, 10) || 10));
    const proxyLib = assignProxies ? store.getProxyLibrary() : [];
    const created = [];
    for (let i = 0; i < n; i++) {
      const data = randomProfileData(country, i + 1);
      const profile = store.createProfile(data);
      created.push(profile);
    }
    console.log("OK - created:", created.length);
    console.log("Profiles in store:", store.getProfiles().length);
  } catch (err) {
    console.log("ERROR:", err.message);
    console.log(err.stack);
  }
}

test();
