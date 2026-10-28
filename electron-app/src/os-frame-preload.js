"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("osFrame", {
  action: (name) => ipcRenderer.send("os-frame-action", name)
});
