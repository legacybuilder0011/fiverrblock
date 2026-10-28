"use strict";

// The Mac browser window for a Patched Chromium page. The Windows binary still
// draws the page and still applies the C++ fingerprint. This window is the
// whole browser: rounded frame, tab row, and address bar, with a hole where
// the page shows through. It is not a bar sitting on Windows Chrome.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const frames = new Map();
const byContents = new Map();
let ipcReady = false;

function wants(osName) {
  const name = String(osName || "").toLowerCase();
  return name === "macos" || name === "ios";
}

const SHADOW = 22;

function overlayBounds(win, toolbarDip) {
  const measured = Math.round(Number(toolbarDip) || 0);
  const toolbar = measured >= 64 && measured <= 150 ? measured : 88;
  const windowH = Math.round(Number(win && win.height) || 0);
  const height = windowH >= toolbar + 80 ? windowH : toolbar;
  return {
    x: Math.round(win.x) - SHADOW,
    y: Math.round(win.y) - SHADOW,
    width: Math.max(0, Math.round(win.width)) + SHADOW * 2,
    height: height + SHADOW * 2,
    toolbar,
    shadow: SHADOW
  };
}

function htmlPath() {
  const unpacked = path.join(process.resourcesPath || "", "app.asar.unpacked", "renderer", "mac-chrome.html");
  if (process.resourcesPath && fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, "..", "renderer", "mac-chrome.html");
}

function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || !buf.length) return "0";
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch (_) {
    return "0";
  }
}

function writeText(file, text) {
  try { fs.writeFileSync(file, text, "utf8"); } catch (_) {}
}

function debugLine(text) {
  if (process.env.PS_MAC_DEBUG !== "1") return;
  try { fs.appendFileSync(path.join(os.tmpdir(), "ps-mac-debug.log"), String(text) + "\n"); } catch (_) {}
}

function stateFor(senderId) {
  const pid = byContents.get(senderId);
  return pid ? frames.get(pid) : null;
}

function cleanGo(value) {
  const text = String(value || "").replace(/[\r\n\t]/g, "").trim();
  if (!text || text.length > 2000) return "";
  return text;
}

function writeCmd(state, command) {
  if (!state || !state.cmdFile || !command) return;
  writeText(state.cmdFile, command);
}

function syncPos(state) {
  if (!state || !state.win || state.win.isDestroyed()) return;
  const { screen } = require("electron");
  const bounds = state.win.getBounds();
  const shadow = state.shadow || 0;
  const phys = screen.dipToScreenRect(state.win, {
    x: bounds.x + shadow,
    y: bounds.y + shadow,
    width: Math.max(1, bounds.width - shadow * 2),
    height: Math.max(1, bounds.height - shadow * 2)
  });
  state.posGen += 1;
  writeText(state.posFile, state.posGen + "\t" + Math.round(phys.x) + "\t" + Math.round(phys.y));
}

function place(state, bounds) {
  if (!state || !state.win || state.win.isDestroyed() || !bounds || bounds.width < 320 || bounds.height < 64) return;
  const next = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  const cur = state.win.getBounds();
  if (cur.x === next.x && cur.y === next.y && cur.width === next.width && cur.height === next.height) return;
  state.suppressMove = (state.suppressMove || 0) + 1;
  try { state.win.setBounds(next); } catch (_) {}
  setTimeout(() => {
    const current = frames.get(state.pid);
    if (current) current.suppressMove = Math.max(0, (current.suppressMove || 1) - 1);
  }, 80);
}

function show(state) {
  const win = state && state.win;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    try { win.showInactive(); } catch (_) {}
  }
}

function paintWindow(state, toolbar, shadow, zoomed) {
  if (!state || !state.win || state.win.isDestroyed()) return;
  if (state.painted === toolbar && state.paintedShadow === shadow && state.zoomed === zoomed) return;
  state.painted = toolbar;
  state.paintedShadow = shadow;
  state.zoomed = zoomed;
  state.win.webContents.executeJavaScript(
    "document.documentElement.style.setProperty('--chrome','" + toolbar + "px');" +
    "document.documentElement.style.setProperty('--shadow','" + shadow + "px');" +
    "document.body.classList.toggle('zoomed'," + (zoomed ? "true" : "false") + ")"
  ).catch(() => {});
}

function hide(state) {
  const win = state && state.win;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try { win.hide(); } catch (_) {}
}

function ensureIpc() {
  if (ipcReady) return;
  const { ipcMain } = require("electron");
  ipcMain.on("mac-chrome-action", (event, action) => {
    const name = String(action || "");
    const allowed = ["close", "min", "zoom", "back", "fwd", "reload", "newtab", "closetab", "star", "menu"];
    if (!allowed.includes(name)) return;
    const state = stateFor(event.sender.id);
    if (!state) return;
    if (name === "menu") state.pauseUntil = Date.now() + 500;
    writeCmd(state, name);
  });
  ipcMain.on("mac-chrome-go", (event, url) => {
    const state = stateFor(event.sender.id);
    const text = cleanGo(url);
    if (!state || !text) return;
    writeCmd(state, "go\t" + text);
  });
  ipcMain.on("mac-chrome-tab", (event, index) => {
    const state = stateFor(event.sender.id);
    const n = Math.round(Number(index) || 0);
    if (!state || n < 1 || n > 8) return;
    writeCmd(state, "tab\t" + n);
  });
  ipcMain.on("mac-chrome-hit", (event, hit) => {
    const state = stateFor(event.sender.id);
    if (!state || !state.win || state.win.isDestroyed()) return;
    try {
      if (hit) state.win.setIgnoreMouseEvents(false);
      else state.win.setIgnoreMouseEvents(true, { forward: true });
    } catch (_) {}
  });
  ipcMain.on("mac-chrome-nudge", (event, dx, dy) => {
    const state = stateFor(event.sender.id);
    if (!state || !state.win || state.win.isDestroyed()) return;
    const moveX = Math.round(Number(dx) || 0);
    const moveY = Math.round(Number(dy) || 0);
    if (!moveX && !moveY) return;
    const bounds = state.win.getBounds();
    state.draggingUntil = Date.now() + 300;
    state.suppressMove = (state.suppressMove || 0) + 1;
    try {
      state.win.setBounds({
        x: bounds.x + moveX,
        y: bounds.y + moveY,
        width: bounds.width,
        height: bounds.height
      });
    } catch (_) {}
    setTimeout(() => {
      const current = frames.get(state.pid);
      if (current) current.suppressMove = Math.max(0, (current.suppressMove || 1) - 1);
    }, 80);
    syncPos(state);
  });
  ipcReady = true;
}

function startWatcher(pid, cmdFile, hostFile, posFile) {
  const scriptText = fs.readFileSync(path.join(__dirname, "mac-chrome-watch.ps1"), "utf8");
  const scriptFile = path.join(os.tmpdir(), "ps-mac-chrome-watch.ps1");
  fs.writeFileSync(scriptFile, scriptText, "utf8");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptFile, String(pid), cmdFile, hostFile, posFile
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function applyState(pid, raw) {
  try { applyStateInner(pid, raw); } catch (err) { debugLine("apply-err " + (err && err.stack || err)); }
}

function applyStateInner(pid, raw) {
  const state = frames.get(pid);
  if (!state || !state.win || state.win.isDestroyed()) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg.alive) {
    detach(pid);
    return;
  }
  const showChrome = msg.visible && !msg.iconic && (msg.ours || state.focused);
  if (!showChrome || Date.now() < (state.pauseUntil || 0)) {
    hide(state);
    return;
  }
  if (Date.now() < (state.draggingUntil || 0)) {
    show(state);
    return;
  }
  const { screen } = require("electron");
  const physW = Math.max(1, (Number(msg.r) || 0) - (Number(msg.l) || 0));
  const physH = Math.max(1, (Number(msg.b) || 0) - (Number(msg.t) || 0));
  const dip = screen.screenToDipRect(null, {
    x: Number(msg.l) || 0,
    y: Number(msg.t) || 0,
    width: physW,
    height: physH
  });
  state.scale = dip.width / physW;
  const toolbarDip = Math.round((Number(msg.toolbar) || 0) * state.scale);
  const fitted = overlayBounds(dip, toolbarDip > 0 ? toolbarDip + 1 : 0);
  state.toolbar = fitted.toolbar;
  state.shadow = fitted.shadow;
  place(state, fitted);
  show(state);
  writeText(state.hostFile, hwndOf(state.win));
  paintWindow(state, fitted.toolbar, fitted.shadow, Boolean(msg.zoomed));
}

function attach(pid) {
  const id = Number(pid);
  if (process.platform !== "win32" || !Number.isSafeInteger(id) || id <= 0) return Promise.resolve(false);
  if (frames.has(id)) return Promise.resolve(true);
  ensureIpc();
  const { BrowserWindow } = require("electron");
  const cmdFile = path.join(os.tmpdir(), "ps-mac-chrome-" + id + ".cmd");
  const hostFile = path.join(os.tmpdir(), "ps-mac-chrome-" + id + ".host");
  const posFile = path.join(os.tmpdir(), "ps-mac-chrome-" + id + ".pos");
  writeText(cmdFile, "");
  writeText(hostFile, "0");
  writeText(posFile, "0\t0\t0");
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    width: 960,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, "mac-chrome-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);
  const state = {
    pid: id,
    cmdFile,
    hostFile,
    posFile,
    posGen: 0,
    win,
    watcher: null,
    focused: false,
    scale: 1,
    toolbar: 88,
    painted: 0,
    zoomed: false,
    suppressMove: 0,
    draggingUntil: 0,
    pauseUntil: 0
  };
  frames.set(id, state);
  const contentsId = win.webContents.id;
  byContents.set(contentsId, id);
  win.on("focus", () => { state.focused = true; });
  win.on("blur", () => { state.focused = false; });
  win.on("closed", () => { byContents.delete(contentsId); });
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    writeText(hostFile, hwndOf(win));
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
  });
  win.loadFile(htmlPath());
  const watcher = startWatcher(id, cmdFile, hostFile, posFile);
  state.watcher = watcher;
  let buf = "";
  watcher.stdout.setEncoding("utf8");
  if (watcher.stderr) {
    watcher.stderr.setEncoding("utf8");
    watcher.stderr.on("data", (chunk) => debugLine("watch-err " + String(chunk).trim()));
  }
  watcher.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        debugLine(line);
        applyState(id, line);
      }
    }
  });
  watcher.once("exit", () => {
    const current = frames.get(id);
    if (current && current.watcher === watcher) detach(id);
  });
  return Promise.resolve(true);
}

function detach(pid) {
  const id = Number(pid);
  const state = frames.get(id);
  if (!state) return;
  frames.delete(id);
  try { if (state.win && !state.win.isDestroyed()) byContents.delete(state.win.webContents.id); } catch (_) {}
  try { if (state.win && !state.win.isDestroyed()) state.win.destroy(); } catch (_) {}
  if (state.watcher && state.watcher.pid) {
    const watcherPid = state.watcher.pid;
    try { state.watcher.kill(); } catch (_) {}
    if (process.platform === "win32") {
      try { spawn("taskkill", ["/PID", String(watcherPid), "/F"], { windowsHide: true, stdio: "ignore" }); } catch (_) {}
    }
  }
  for (const file of [state.cmdFile, state.hostFile, state.posFile]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function chromeStatus(pid) {
  const state = frames.get(Number(pid));
  if (!state || !state.win || state.win.isDestroyed()) return null;
  return {
    visible: state.win.isVisible(),
    bounds: state.win.getBounds(),
    toolbar: state.toolbar || 0
  };
}

module.exports = { wants, overlayBounds, attach, detach, chromeStatus };
