"use strict";
// Cloud viewer only: files dragged from this PC onto the cloud window are sent
// to the cloud browser and dropped at the same spot (e.g. a site's upload area).
// The remote browser's own file picker only sees the server's disk, so dragging
// is how you get your own files in. Runs before neko's page handles the drop.
const { ipcRenderer, webUtils } = require("electron");

const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = "copy";
}, true);

window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.stopPropagation();
  const v = document.querySelector("video");
  if (!v || !v.videoWidth) return;
  // Window point → remote screen pixel, allowing for the video being scaled and
  // letterboxed inside its element.
  const r = v.getBoundingClientRect();
  const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
  const ox = r.left + (r.width - v.videoWidth * scale) / 2;
  const oy = r.top + (r.height - v.videoHeight * scale) / 2;
  const x = (e.clientX - ox) / scale, y = (e.clientY - oy) / scale;
  const paths = Array.from(e.dataTransfer.files).map((f) => webUtils.getPathForFile(f)).filter(Boolean);
  if (paths.length) ipcRenderer.send("CLOUD_VIEWER_DROP", { x, y, paths });
}, true);
