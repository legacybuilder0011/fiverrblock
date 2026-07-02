"use strict";

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

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

function createHandler(logInfo = () => {}, logError = () => {}) {
  return (request) => {
    let filePath = "<unresolved>";
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      filePath = path.join(app.getAppPath(), relativePath);
      const data = fs.readFileSync(filePath);
      const extension = path.extname(filePath).toLowerCase();
      logInfo(`psapp served ${request.url} -> ${filePath} (${data.length} bytes)`);
      return new Response(data, {
        headers: { "Content-Type": MIME[extension] || "application/octet-stream" }
      });
    } catch (err) {
      logError(`psapp FAILED for ${request.url} (filePath=${filePath}): ${err.stack || err}`);
      return new Response(
        "psapp not found: " + request.url + "\n" + (err.message || err),
        { status: 404 }
      );
    }
  };
}

async function ensureAppProtocol(targetProtocol, logInfo, logError) {
  if (!targetProtocol || typeof targetProtocol.handle !== "function") {
    throw new Error("Electron protocol API is unavailable for this session");
  }
  if (typeof targetProtocol.isProtocolHandled === "function") {
    const registered = await targetProtocol.isProtocolHandled("psapp");
    if (registered) return false;
  }
  targetProtocol.handle("psapp", createHandler(logInfo, logError));
  return true;
}

module.exports = { ensureAppProtocol };
