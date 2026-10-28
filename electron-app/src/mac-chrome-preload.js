"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("macChrome", {
  action: (name) => ipcRenderer.send("mac-chrome-action", String(name || "")),
  go: (url) => ipcRenderer.send("mac-chrome-go", String(url || "")),
  tab: (index) => ipcRenderer.send("mac-chrome-tab", Number(index) || 1),
  nudge: (dx, dy) => ipcRenderer.send("mac-chrome-nudge", Number(dx) || 0, Number(dy) || 0),
  hit: (on) => ipcRenderer.send("mac-chrome-hit", Boolean(on))
});
