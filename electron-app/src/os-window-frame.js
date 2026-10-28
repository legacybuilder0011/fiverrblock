"use strict";

// Picture of the operating system the profile picked. The Windows browser
// binary still draws the page. This strip sits on that window: a Mac menu
// bar and traffic lights, or a Linux header. It does not change the site
// fingerprint.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BAR_H = 32;
const COVER_W = 168;
const COVER_H = 36;
const LIGHTS = { w: 72, h: 22 };
const frames = new Map();
const byContents = new Map();
let ipcReady = false;

function frameKind(osName) {
  const name = String(osName || "").toLowerCase();
  if (name === "macos" || name === "ios") return "mac";
  if (name === "linux") return "linux";
  return "";
}

function layoutFor(win, work) {
  const width = Math.max(0, Math.round(win.width));
  const height = Math.max(0, Math.round(win.height));
  const x = Math.round(win.x);
  const y = Math.round(win.y);
  const roomAbove = y >= Math.round(work.y) + BAR_H;
  const bar = roomAbove ? { x, y: y - BAR_H, width, height: BAR_H } : null;
  const lights = roomAbove ? null : { x: x + 8, y: y + 6, width: LIGHTS.w, height: LIGHTS.h };
  const coverW = Math.min(COVER_W, width);
  return {
    bar,
    lights,
    cover: { x: x + Math.max(0, width - coverW), y, width: coverW, height: Math.min(COVER_H, height) }
  };
}

function frameHtml() {
  const unpacked = path.join(process.resourcesPath || "", "app.asar.unpacked", "renderer", "os-frame.html");
  if (process.resourcesPath && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "renderer", "os-frame.html");
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function ensureIpc() {
  if (ipcReady) return;
  const { ipcMain } = require("electron");
  ipcMain.on("os-frame-action", (event, action) => {
    const name = String(action || "");
    if (name !== "close" && name !== "min" && name !== "zoom") return;
    const pid = byContents.get(event.sender.id);
    const state = pid ? frames.get(pid) : null;
    if (!state || !state.cmdFile) return;
    try { fs.writeFileSync(state.cmdFile, name, "utf8"); } catch (_) {}
  });
  ipcReady = true;
}

function makeWindow(kind, part, appName, focusable) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: focusable,
    show: false,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    backgroundColor: part === "bar" ? (kind === "linux" ? "#2d2d2d" : "#ececec") : "#323639",
    webPreferences: {
      preload: path.join(__dirname, "os-frame-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(frameHtml(), { query: { kind, part, app: appName } });
  return win;
}

function place(win, bounds) {
  if (!win || win.isDestroyed() || !bounds || bounds.width < 8 || bounds.height < 8) return;
  const next = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  const cur = win.getBounds();
  if (cur.x === next.x && cur.y === next.y && cur.width === next.width && cur.height === next.height) return;
  win.setBounds(next);
}

function show(win) {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  win.showInactive();
  win.setAlwaysOnTop(true, "floating");
}

function hide(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.hide();
}

function remember(win, pid) {
  if (!win || win.isDestroyed()) return;
  byContents.set(win.webContents.id, pid);
  win.on("focus", () => {
    const state = frames.get(pid);
    if (state) state.frameFocused = true;
  });
  win.on("blur", () => {
    const state = frames.get(pid);
    if (state) state.frameFocused = false;
  });
}

function startWatcher(pid, cmdFile) {
  const script = fs.readFileSync(path.join(__dirname, "os-frame-watch.ps1"), "utf8");
  const command = "& {\n" + script + "\n} -BrowserPid " + pid + " -CmdFile " + psQuote(cmdFile);
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function applyState(pid, raw) {
  const state = frames.get(pid);
  if (!state) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg.alive) {
    detach(pid);
    return;
  }
  const showPicture = msg.visible && !msg.iconic && msg.hwnd && msg.hwnd !== "0" && (msg.ours || state.frameFocused);
  if (!showPicture) {
    hide(state.bar);
    hide(state.lights);
    hide(state.cover);
    return;
  }
  const { screen } = require("electron");
  const dip = screen.screenToDipRect(null, {
    x: Number(msg.l) || 0,
    y: Number(msg.t) || 0,
    width: Math.max(0, (Number(msg.r) || 0) - (Number(msg.l) || 0)),
    height: Math.max(0, (Number(msg.b) || 0) - (Number(msg.t) || 0))
  });
  if (dip.width < 200 || dip.height < 120) return;
  const work = screen.getDisplayMatching(dip).workArea;
  const layout = layoutFor(dip, work);
  if (layout.bar) {
    place(state.bar, layout.bar);
    show(state.bar);
    hide(state.lights);
  } else {
    hide(state.bar);
    place(state.lights, layout.lights);
    show(state.lights);
  }
  place(state.cover, layout.cover);
  if (typeof msg.strip === "string" && /^#[0-9A-Fa-f]{6}$/.test(msg.strip) && msg.strip.toLowerCase() !== "#000000" && state.strip !== msg.strip) {
    state.strip = msg.strip;
    try { state.cover.setBackgroundColor(msg.strip); } catch (_) {}
    if (state.cover.webContents && !state.cover.webContents.isLoading()) {
      state.cover.webContents.executeJavaScript("document.body.style.background=" + JSON.stringify(msg.strip)).catch(() => {});
    }
  }
  show(state.cover);
}

function attach(pid, kind, appName) {
  const id = Number(pid);
  const picture = frameKind(kind) || (kind === "mac" || kind === "linux" ? kind : "");
  if (process.platform !== "win32" || !Number.isSafeInteger(id) || id <= 0 || !picture) return Promise.resolve(false);
  if (frames.has(id)) return Promise.resolve(true);
  ensureIpc();
  const name = String(appName || "Chrome").replace(/[^\w .+-]/g, "").slice(0, 40) || "Chrome";
  const cmdFile = path.join(os.tmpdir(), "ps-os-frame-" + id + ".cmd");
  try { fs.writeFileSync(cmdFile, "", "utf8"); } catch (_) {}
  const state = {
    kind: picture,
    cmdFile,
    frameFocused: false,
    bar: makeWindow(picture, "bar", name, true),
    lights: makeWindow(picture, "lights", name, true),
    cover: makeWindow(picture, "cover", name, false),
    watcher: null
  };
  state.cover.setBackgroundColor("#323639");
  remember(state.bar, id);
  remember(state.lights, id);
  frames.set(id, state);
  const watcher = startWatcher(id, cmdFile);
  state.watcher = watcher;
  let buf = "";
  watcher.stdout.setEncoding("utf8");
  watcher.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) applyState(id, line);
    }
  });
  watcher.once("exit", () => {
    const current = frames.get(id);
    if (current && current.watcher === watcher) detach(id);
  });
  return Promise.resolve(true);
}

function closeWin(win) {
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
}

function detach(pid) {
  const id = Number(pid);
  const state = frames.get(id);
  if (!state) return;
  frames.delete(id);
  for (const win of [state.bar, state.lights, state.cover]) {
    try { if (win && !win.isDestroyed()) byContents.delete(win.webContents.id); } catch (_) {}
    closeWin(win);
  }
  if (state.watcher && state.watcher.pid) {
    const watcherPid = state.watcher.pid;
    try { state.watcher.kill(); } catch (_) {}
    if (process.platform === "win32") {
      try { spawn("taskkill", ["/PID", String(watcherPid), "/F"], { windowsHide: true, stdio: "ignore" }); } catch (_) {}
    }
  }
  try { fs.unlinkSync(state.cmdFile); } catch (_) {}
}

function pictureStatus(pid) {
  const state = frames.get(Number(pid));
  if (!state) return null;
  const bounds = (win) => (win && !win.isDestroyed() && win.isVisible()) ? win.getBounds() : null;
  return { bar: bounds(state.bar), lights: bounds(state.lights), cover: bounds(state.cover) };
}

module.exports = { frameKind, layoutFor, attach, detach, pictureStatus, BAR_H, COVER_W, COVER_H };
