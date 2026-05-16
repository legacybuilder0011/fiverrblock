"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

// Register a custom protocol BEFORE app.ready so it can be used to load HTML files.
// file:// URLs into app.asar.unpacked/ confuse Electron's ASAR interceptor (the path
// contains ".asar" which triggers archive-handling logic), causing ERR_FAILED (-2)
// in BrowserWindow. psapp:// bypasses all of that — it reads via fs.readFileSync,
// which Node.js handles ASAR transparently for.
protocol.registerSchemesAsPrivileged([
  { scheme: "psapp", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }
]);

// Log errors to a file. Don't exit the app — but DO surface critical
// startup errors so the user knows something went wrong instead of
// silently failing to open. Pick the first writable location so OneDrive-
// redirected Desktops still get a log (previously we wrote to
// homedir/Desktop which doesn't exist when Desktop is in OneDrive).
function resolveLogPath() {
  const os = require("os");
  const candidates = [
    path.join(os.homedir(), "OneDrive", "Desktop"),
    path.join(os.homedir(), "Desktop"),
    os.tmpdir()
  ];
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return path.join(dir, "privacy-shield-error.txt"); } catch (_) {}
  }
  return path.join(os.tmpdir(), "privacy-shield-error.txt");
}
const LOG_PATH = resolveLogPath();
function logError(err) {
  try {
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + String(err?.stack || err) + "\n", "utf8");
  } catch (_) {}
}
function logInfo(msg) {
  try {
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " [info] " + msg + "\n", "utf8");
  } catch (_) {}
}
let appReady = false;

// Keep WebRTC from bypassing the selected profile network path with direct UDP.
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("enable-features", "WebRtcHideLocalIpsWithMdns");
app.setName("Privacy Shield Browser");
if (process.platform === "win32") app.setAppUserModelId("com.privacyshield.browser");

process.on("uncaughtException", (err) => {
  logError(err);
  // Before the app is ready, errors prevent the window from opening at all.
  // Show a dialog so the user knows + can read the message.
  if (!appReady) {
    try { dialog.showErrorBox("Privacy Shield startup error", String(err?.message || err) + "\n\nDetails written to: " + LOG_PATH); } catch (_) {}
  }
});
process.on("unhandledRejection", logError);

// Wrap critical requires so a missing/broken module is surfaced clearly.
let registerIpcHandlers, openProfileWindow, store, authStore;
try {
  ({ registerIpcHandlers, openProfileWindow } = require("./ipc-handlers"));
  store = require("./profile-store");
  authStore = require("./auth-store");
} catch (err) {
  logError(err);
  try { dialog.showErrorBox("Privacy Shield failed to load", String(err?.message || err) + "\n\nDetails written to: " + LOG_PATH); } catch (_) {}
  process.exit(1);
}

let mainWindow = null;
let loginWindow = null;
let tray = null;

const RENDERER_PRELOAD = path.join(__dirname, "renderer-preload.js");
// HTML files load via the custom psapp:// protocol (registered in app.whenReady)
// instead of file:// because Electron 31 fails to load file:// URLs that contain
// ".asar" in the path (asarUnpack adds .asar.unpacked which trips the same code path).
const PROFILES_URL = "psapp://app/renderer/profiles.html";
const LOGIN_URL    = "psapp://app/renderer/login.html";

// Single-instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (!loginWindow || loginWindow.isDestroyed()) {
    openLoginOrMain();
  }
});

app.whenReady().then(async () => {
  appReady = true;

  // Wire up the psapp:// protocol handler. Reads bundled files via fs (ASAR-aware)
  // and returns them as a fetch Response. This is the only reliable way to load
  // local HTML/JS/CSS in Electron 31 BrowserWindow when the app is packed.
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json"
  };
  protocol.handle("psapp", (request) => {
    let filePath = "<unresolved>";
    try {
      const u = new URL(request.url);
      // psapp://app/renderer/tab-strip.html -> renderer/tab-strip.html
      // Strip leading slash from pathname; host segment is just a placeholder.
      const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      filePath = path.join(app.getAppPath(), rel);
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      logInfo(`psapp served ${request.url} -> ${filePath} (${data.length} bytes)`);
      return new Response(data, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
    } catch (err) {
      logError(`psapp FAILED for ${request.url} (filePath=${filePath}): ${err.stack || err}`);
      return new Response("psapp not found: " + request.url + "\n" + (err.message || err), { status: 404 });
    }
  });
  logInfo(`psapp protocol registered. appPath=${app.getAppPath()} LOG_PATH=${LOG_PATH}`);

  registerIpcHandlers();

  // After successful auth, open the profile manager and close the login window
  const { ipcMain } = require("electron");
  ipcMain.handle("AUTH_OPEN_APP", async () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    createMainWindow();
    await restoreOpenProfiles();
    return { ok: true };
  });

  ipcMain.handle("AUTH_DO_LOGOUT", async () => {
    const auth = require("./auth-store");
    auth.logout();
    // Close all profile windows
    for (const win of BrowserWindow.getAllWindows()) {
      if (mainWindow && win.id === mainWindow.id) continue;
      if (!win.isDestroyed()) win.destroy();
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    createLoginWindow();
    return { ok: true };
  });

  createTray();
  openLoginOrMain();
});

function openLoginOrMain() {
  const session = authStore.getSession();
  if (session && session.userId) {
    createMainWindow();
    restoreOpenProfiles();
  } else {
    createLoginWindow();
  }
}

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  else if (!loginWindow || loginWindow.isDestroyed()) openLoginOrMain();
});

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    title: "Privacy Shield — Sign In",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  loginWindow.loadURL(LOGIN_URL);
  loginWindow.setMenuBarVisibility(false);
  loginWindow.on("closed", () => { loginWindow = null; });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Privacy Shield — Profile Manager",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(PROFILES_URL);
  mainWindow.setMenuBarVisibility(false);

  // Hide to tray instead of destroying — keeps app alive and prevents
  // "all windows closed" from ever firing on Windows
  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }
}

async function restoreOpenProfiles() {
  const profileIds = store.getOpenProfiles();
  if (!profileIds.length) return;
  await new Promise((r) => setTimeout(r, 1500));
  const profiles = store.getProfiles();
  for (const id of profileIds) {
    const profile = profiles.find((p) => p.id === id && !p.deletedAt);
    // Only restore profiles that have a real saved session (user was actually browsing)
    if (profile && profile.session && profile.session.tabs && profile.session.tabs.length) {
      try { await openProfileWindow(id); } catch (_) {}
    }
  }
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, "..", "icons", "icon16.png");
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip("Privacy Shield");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Profile Manager",
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
          else openLoginOrMain();
        }
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      else openLoginOrMain();
    });
  } catch (_) {
    // Tray is optional — continue without it if icon is missing
  }
}
