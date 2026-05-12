"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// Log errors silently — do NOT exit the app. A bad proxy or transient
// error should never close the whole app.
function logError(err) {
  try {
    const logPath = path.join(require("os").homedir(), "Desktop", "privacy-shield-error.txt");
    fs.appendFileSync(logPath, new Date().toISOString() + " " + String(err?.stack || err) + "\n", "utf8");
  } catch (_) {}
}
process.on("uncaughtException", logError);
process.on("unhandledRejection", logError);

const { registerIpcHandlers, openProfileWindow } = require("./ipc-handlers");
const store = require("./profile-store");
const authStore = require("./auth-store");

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
