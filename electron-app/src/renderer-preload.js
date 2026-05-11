"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (type, data) => ipcRenderer.invoke(type, data || {}),
  onMainEvent: (cb) => {
    ipcRenderer.on("MAIN_EVENT", (_ev, payload) => cb(payload));
  }
});
