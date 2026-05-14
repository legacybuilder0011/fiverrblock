"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// Log errors to a file. Don't exit the app — but DO surface critical
// startup errors so the user knows something went wrong instead of
// silently failing to open.
const LOG_PATH = path.join(require("os").homedir(), "Desktop", "privacy-shield-error.txt");
function logError(err) {
  try {
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + String(err?.stack || err) + "\n", "utf8");
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
const PROFILES_HTML = path.join(__dirname, "..", "renderer", "profiles.html");
const LOGIN_HTML = path.join(__dirname, "..", "renderer", "login.html");

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
  loginWindow.loadFile(LOGIN_HTML);
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

  mainWindow.loadFile(PROFILES_HTML);
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
