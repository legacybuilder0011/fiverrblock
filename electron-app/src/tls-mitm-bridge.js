"use strict";

// TLS MITM bridge with per-profile JA3 spoofing.
//
// The regular HTTP CONNECT bridge (local-proxy-bridge.js) just tunnels bytes,
// which means Chromium's TLS handshake reaches the upstream untouched — every
// profile sends the same Chromium-126 ClientHello, so the resulting JA3/JA4
// fingerprints cluster all profiles together as "same antidetect tool."
//
// This bridge terminates Chromium's TLS using an on-the-fly leaf cert signed
// by a per-profile root CA, then re-originates each HTTPS request through
// CycleTLS (which wraps uTLS in Go) using a JA3 fingerprint chosen per
// profile. Chromium trusts our CA via the per-session
// setCertificateVerifyProc hook installed in session-manager.
//
// Limitations of this v1:
// - Forces HTTP/1.1 between Chromium and bridge (ALPN h2 advertised but
//   downgraded). Most sites still serve over h1.
// - WebSocket Upgrade is detected and passed through as a raw tunnel
//   (Chromium's TLS reaches upstream — JA3 not spoofed for WS).
// - Response is buffered in memory before forwarding. Fine for browsing,
//   not great for multi-GB downloads.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const crypto = require("crypto");

let forge = null;
let initCycleTLS = null;
let cycletlsBinaryPath = null;
function lazyLoadDeps() {
  if (!forge) {
    try { forge = require("node-forge"); } catch (err) { mitmLog(`forge load failed: ${err.message || err}`); }
  }
  if (!initCycleTLS) {
    try { initCycleTLS = require("cycletls"); } catch (err) { mitmLog(`cycletls load failed: ${err.message || err}`); }
  }
  if (!cycletlsBinaryPath) cycletlsBinaryPath = resolveCycleTlsBinary();
  return Boolean(forge && initCycleTLS && cycletlsBinaryPath);
}

function resolveCycleTlsBinary() {
  const platformBin = {
    win32: "index.exe",
    linux: process.arch === "arm64" ? "index-arm64" : process.arch === "arm" ? "index-arm" : "index",
    darwin: process.arch === "arm64" ? "index-mac-arm64" : process.arch === "arm" ? "index-mac-arm" : "index-mac",
    freebsd: "index-freebsd"
  }[process.platform];
  if (!platformBin) return null;

  // Candidates: app.asar.unpacked FIRST (the actual on-disk location for
  // child_process.spawn). Electron's fs hooks redirect reads from app.asar
  // to app.asar.unpacked transparently, but spawn() uses the raw OS path —
  // so we must hand it the unpacked path explicitly or get ENOENT.
  const candidates = [];

  try {
    const { app } = require("electron");
    if (app && app.getAppPath) {
      const appPath = app.getAppPath();
      const unpackedBase = appPath.endsWith("app.asar")
        ? appPath.slice(0, -"app.asar".length) + "app.asar.unpacked"
        : appPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      candidates.push(path.join(unpackedBase, "node_modules", "cycletls", "dist", platformBin));
      candidates.push(path.join(appPath, "node_modules", "cycletls", "dist", platformBin));
    }
  } catch (_) {}

  let modulePath;
  try { modulePath = require.resolve("cycletls"); } catch (_) { modulePath = null; }
  if (modulePath) {
    const dir = path.dirname(modulePath);
    const unpackedDir = dir.includes("app.asar") && !dir.includes("app.asar.unpacked")
      ? dir.replace("app.asar", "app.asar.unpacked")
      : dir;
    candidates.push(path.join(unpackedDir, platformBin));
    if (unpackedDir !== dir) candidates.push(path.join(dir, platformBin));
  }

  for (const candidate of candidates) {
    // Use statSync via the raw OS, not Electron's redirected fs check.
    // If a path contains "app.asar" without ".unpacked" and the file isn't
    // really there on disk, skip it — spawn() would fail with ENOENT.
    try {
      const looksAsarTrap = candidate.includes("app.asar") && !candidate.includes("app.asar.unpacked");
      if (looksAsarTrap) continue;
      if (fs.existsSync(candidate)) {
        mitmLog(`cycletls binary resolved at ${candidate}`);
        return candidate;
      }
    } catch (_) {}
  }
  mitmLog(`cycletls binary NOT found. Tried: ${candidates.join(" | ")}`);
  return null;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const bridges = new Map();      // profileId -> { server, port, key, caPem, leafCache, cycleClient, ja3, userAgent, upstream }
const caCache = new Map();      // profileId -> { caPem, caKeyPem, caCertObj, caKeyObj }
const leafCacheLimit = 64;

const JA3_PROFILES = [
  { label: "chrome-131", ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
  { label: "chrome-136", ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-5-10-11-13-16-18-21-23-27-35-43-45-51-17513-65037-65281,29-23-24,0", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" },
  { label: "chrome-144", ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-5-10-11-13-16-18-21-23-27-35-43-45-51-17513-65037-65281,29-23-24,0", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36" },
  { label: "firefox-128", ja3: "771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-156-157-47-53,0-23-65281-10-11-16-5-34-51-43-13-45-28-21,29-23-24-25-256-257,0", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0" },
  { label: "safari-17", ja3: "771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49162-49161-49172-49171-157-156-53-47,0-23-65281-10-11-16-5-13-18-51-45-43-27-21,29-23-24-25,0", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" },
  { label: "edge-131", ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0" }
];

function mitmLog(msg) {
  try {
    const { app } = require("electron");
    const dir = app && typeof app.getPath === "function" ? app.getPath("userData") : os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "privacy-shield-error.txt"), new Date().toISOString() + " mitm " + String(msg) + "\n", "utf8");
  } catch (_) {}
}

function caStorePath(profileId) {
  try {
    const { app } = require("electron");
    const dir = app && typeof app.getPath === "function" ? app.getPath("userData") : os.tmpdir();
    const safe = String(profileId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    const root = path.join(dir, "mitm-ca");
    fs.mkdirSync(root, { recursive: true });
    return path.join(root, `${safe}.json`);
  } catch (_) {
    return path.join(os.tmpdir(), `mitm-ca-${profileId}.json`);
  }
}

function loadOrCreateCA(profileId) {
  const cached = caCache.get(profileId);
  if (cached) return cached;

  const file = caStorePath(profileId);
  let caPem = "";
  let caKeyPem = "";
  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      caPem = j.caPem || "";
      caKeyPem = j.caKeyPem || "";
    } catch (_) {}
  }
  if (!caPem || !caKeyPem) {
    const generated = generateCA(profileId);
    caPem = generated.caPem;
    caKeyPem = generated.caKeyPem;
    try { fs.writeFileSync(file, JSON.stringify({ caPem, caKeyPem }), { mode: 0o600 }); } catch (_) {}
  }
  const caCertObj = forge.pki.certificateFromPem(caPem);
  const caKeyObj = forge.pki.privateKeyFromPem(caKeyPem);
  const out = { caPem, caKeyPem, caCertObj, caKeyObj };
  caCache.set(profileId, out);
  return out;
}

function generateCA(profileId) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const attrs = [
    { name: "commonName", value: `PrivacyShield MITM CA ${profileId.slice(0, 8)}` },
    { name: "organizationName", value: "Privacy Shield Browser" },
    { name: "organizationalUnitName", value: "Per-Profile MITM" }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, cRLSign: true },
    { name: "subjectKeyIdentifier" }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    caPem: forge.pki.certificateToPem(cert),
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

function generateLeafCert(hostname, ca) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(ca.caCertObj.subject.attributes);
  const isIP = net.isIP(hostname) !== 0;
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    {
      name: "subjectAltName",
      altNames: isIP
        ? [{ type: 7, ip: hostname }]
        : [{ type: 2, value: hostname }, { type: 2, value: `*.${hostname.split(".").slice(-2).join(".")}` }]
    }
  ]);
  cert.sign(ca.caKeyObj, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

function getLeafCert(hostname, ca, cache) {
  if (cache.has(hostname)) return cache.get(hostname);
  const leaf = generateLeafCert(hostname, ca);
  cache.set(hostname, leaf);
  if (cache.size > leafCacheLimit) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return leaf;
}

function pickJa3ForProfile(seed) {
  const text = String(seed || "default");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const idx = (h >>> 0) % JA3_PROFILES.length;
  return JA3_PROFILES[idx];
}

function readHttpRequest(socket, headBuffer) {
  return new Promise((resolve, reject) => {
    let buf = headBuffer || Buffer.alloc(0);
    let headerEnd = -1;
    let timeout = setTimeout(() => { cleanup(); reject(new Error("request header timeout")); }, 30000);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        cleanup();
        finish();
      } else if (buf.length > 65536) {
        cleanup();
        reject(new Error("request header too large"));
      }
    };
    const onClose = () => { cleanup(); reject(new Error("socket closed before request")); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    }

    function finish() {
      const headStr = buf.slice(0, headerEnd).toString("utf8");
      const lines = headStr.split("\r\n");
      const requestLine = lines.shift() || "";
      const m = requestLine.match(/^(\S+)\s+(\S+)\s+HTTP\/(\d\.\d)$/);
      if (!m) return reject(new Error("malformed request line: " + requestLine));
      const method = m[1];
      const path = m[2];
      const httpVersion = m[3];
      const headers = {};
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        headers[name.toLowerCase()] = value;
      }
      const rest = buf.slice(headerEnd + 4);
      const contentLength = Number(headers["content-length"] || 0);
      const transferEncoding = (headers["transfer-encoding"] || "").toLowerCase();
      const upgrade = (headers["upgrade"] || "").toLowerCase();
      if (upgrade) return resolve({ method, path, httpVersion, headers, body: rest, isUpgrade: true, upgradeKind: upgrade });
      if (transferEncoding.includes("chunked")) return readChunkedBody(socket, rest).then((body) => resolve({ method, path, httpVersion, headers, body })).catch(reject);
      if (contentLength > 0) return readFixedBody(socket, rest, contentLength).then((body) => resolve({ method, path, httpVersion, headers, body })).catch(reject);
      resolve({ method, path, httpVersion, headers, body: Buffer.alloc(0) });
    }
    if (buf.length > 0) onData(Buffer.alloc(0));
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function readFixedBody(socket, initial, length) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    if (buf.length >= length) return resolve(buf.slice(0, length));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= length) {
        socket.removeListener("data", onData);
        resolve(buf.slice(0, length));
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => { socket.removeListener("data", onData); reject(err); });
  });
}

function readChunkedBody(socket, initial) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    let result = Buffer.alloc(0);
    let parsing = true;
    function tryParse() {
      while (parsing) {
        const idx = buf.indexOf("\r\n");
        if (idx === -1) return;
        const sizeLine = buf.slice(0, idx).toString("utf8");
        const size = parseInt(sizeLine.split(";")[0], 16);
        if (Number.isNaN(size)) { parsing = false; return reject(new Error("bad chunk size")); }
        if (size === 0) {
          parsing = false;
          socket.removeListener("data", onData);
          resolve(result);
          return;
        }
        if (buf.length < idx + 2 + size + 2) return;
        result = Buffer.concat([result, buf.slice(idx + 2, idx + 2 + size)]);
        buf = buf.slice(idx + 2 + size + 2);
      }
    }
    const onData = (chunk) => { buf = Buffer.concat([buf, chunk]); tryParse(); };
    socket.on("data", onData);
    socket.once("error", (err) => { socket.removeListener("data", onData); reject(err); });
    tryParse();
  });
}

function buildUpstreamProxyUrl(upstream) {
  if (!upstream || !upstream.host) return "";
  const scheme = (upstream.scheme || "http").toLowerCase();
  const u = encodeURIComponent(upstream.username || "");
  const p = encodeURIComponent(upstream.password || "");
  return `${scheme}://${u}:${p}@${upstream.host}:${upstream.port}`;
}

// Headers we must NOT forward as-is because cycletls already auto-decoded the
// body, or because they describe transport semantics that don't apply to the
// Chromium-facing TLS-terminated connection. Forwarding content-encoding when
// the body has already been gunzipped yields ERR_CONTENT_DECODING_FAILED (-330)
// in Chromium and the page renders blank.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "alt-svc"
]);

// cycletls 2.x returns a fetch-style response: { status, headers, finalUrl,
// data, json(), text(), arrayBuffer(), blob() } — there is NO `.body` field
// (that was the v1 API this bridge was first written against, which is why
// every response used to come back as a tiny serialized stub). On an internal
// transport error (refused/authless proxy, bad CONNECT, DNS failure, etc.)
// cycletls resolves with an EMPTY headers object and the error text in `.data`.
// We read raw bytes via arrayBuffer() — it returns the exact body for both text
// and binary regardless of responseType — and treat empty-headers as the error
// path so Chromium shows a real diagnostic instead of a blank page.
async function readCycleResponse(resp) {
  if (!resp) {
    return { status: 502, headers: {}, bodyBuf: Buffer.alloc(0), errorMessage: "no response from cycletls" };
  }
  let bodyBuf = Buffer.alloc(0);
  try {
    const ab = await resp.arrayBuffer();
    bodyBuf = Buffer.from(ab);
  } catch (_) {
    if (Buffer.isBuffer(resp.data)) bodyBuf = resp.data;
    else if (typeof resp.data === "string") bodyBuf = Buffer.from(resp.data, "utf8");
  }
  const headers = resp.headers && typeof resp.headers === "object" ? resp.headers : {};
  const isError = Object.keys(headers).length === 0;
  let errorMessage = "";
  if (isError) {
    errorMessage = typeof resp.data === "string" && resp.data
      ? resp.data
      : (bodyBuf.length ? bodyBuf.toString("utf8") : "cycletls returned no headers and no body");
  }
  return { status: resp.status || 0, headers, bodyBuf, errorMessage };
}

function writeHttpResponse(socket, status, statusText, headers, body) {
  const lines = [`HTTP/1.1 ${status} ${statusText || ""}`];
  for (const [name, value] of Object.entries(headers || {})) {
    if (!name) continue;
    if (STRIP_RESPONSE_HEADERS.has(String(name).toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${name}: ${v}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  lines.push(`Content-Length: ${bodyBuf.length}`);
  lines.push("Connection: close");
  lines.push("", "");
  const head = Buffer.from(lines.join("\r\n"), "utf8");
  try { socket.write(Buffer.concat([head, bodyBuf])); } catch (_) {}
  try { socket.end(); } catch (_) {}
}

async function handleHttpsRequest(clientSocket, hostname, port, ca, leafCache, profile) {
  const sniContext = (servername, cb) => {
    try {
      const leaf = getLeafCert(servername || hostname, ca, leafCache);
      cb(null, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
    } catch (err) {
      cb(err);
    }
  };

  const defaultLeaf = getLeafCert(hostname, ca, leafCache);
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: defaultLeaf.key,
    cert: defaultLeaf.cert,
    SNICallback: sniContext,
    ALPNProtocols: ["http/1.1"]
  });

  tlsSocket.on("error", (err) => mitmLog(`tls socket err host=${hostname} ${err.message || err}`));

  let req;
  try {
    req = await readHttpRequest(tlsSocket);
  } catch (err) {
    mitmLog(`http parse err host=${hostname} ${err.message || err}`);
    try { tlsSocket.destroy(); } catch (_) {}
    return;
  }

  if (req.isUpgrade) {
    mitmLog(`upgrade ${req.upgradeKind} host=${hostname} — falling back to raw tunnel for this connection`);
    // For Upgrade requests (WebSocket etc), we can't easily use cycletls — close and let Chromium retry through native path
    try { tlsSocket.destroy(); } catch (_) {}
    return;
  }

  const url = `https://${hostname}${req.path}`;
  const headers = { ...req.headers };
  delete headers["host"];
  delete headers["content-length"];
  delete headers["proxy-connection"];
  delete headers["connection"];
  // Force upstream to send uncompressed bytes so cycletls's string round-trip
  // doesn't corrupt the body. Compressed/binary responses survive the string
  // conversion only if we never decompress them.
  headers["accept-encoding"] = "identity";

  if (profile.userAgent) headers["user-agent"] = profile.userAgent;

  try {
    const opts = {
      body: req.body && req.body.length ? req.body.toString("utf8") : "",
      ja3: profile.ja3,
      userAgent: profile.userAgent,
      headers,
      timeout: 30,
      disableRedirect: true,
      responseType: "arraybuffer"
    };
    if (profile.upstreamProxyUrl) opts.proxy = profile.upstreamProxyUrl;

    const resp = await profile.cycleClient(url, opts, req.method.toUpperCase());
    const parsed = await readCycleResponse(resp);
    if (parsed.errorMessage) {
      mitmLog(`mitm upstream-error host=${hostname} status=${parsed.status} proxy=${profile.upstreamProxyUrl ? "yes" : "no"} msg=${parsed.errorMessage.slice(0, 200)}`);
      writeHttpResponse(tlsSocket, 502, "Bridge Upstream Error", { "content-type": "text/plain" }, `Privacy Shield MITM bridge could not fetch this page.\n\n${parsed.errorMessage}`);
      return;
    }
    mitmLog(`mitm response host=${hostname}${req.path.length > 60 ? req.path.slice(0, 60) + "…" : req.path} status=${parsed.status} bytes=${parsed.bodyBuf.length}`);
    writeHttpResponse(tlsSocket, parsed.status || 502, "", parsed.headers, parsed.bodyBuf);
  } catch (err) {
    mitmLog(`cycletls err host=${hostname} ${err.message || err}`);
    writeHttpResponse(tlsSocket, 502, "Bridge Error", { "content-type": "text/plain" }, `Bridge upstream error: ${err.message || err}`);
  }
}

function createMitmServer(profileId, upstream, ja3Profile, ca, leafCache, cycleClient) {
  const server = net.createServer();
  const profile = {
    ja3: ja3Profile.ja3,
    userAgent: ja3Profile.ua,
    upstreamProxyUrl: buildUpstreamProxyUrl(upstream),
    cycleClient
  };

  server.on("connection", (clientSocket) => {
    clientSocket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) {
        if (buf.length > 16384) { try { clientSocket.destroy(); } catch (_) {} }
        return;
      }
      clientSocket.removeListener("data", onData);
      const head = buf.slice(0, sep).toString("utf8");
      const tail = buf.slice(sep + 4);
      const firstLine = head.split("\r\n")[0] || "";
      const connectMatch = firstLine.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/\d\.\d$/i);
      if (connectMatch) {
        const hostname = connectMatch[1];
        const port = Number(connectMatch[2]);
        try { clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: PrivacyShield-MITM\r\n\r\n"); } catch (_) {}
        if (tail.length) clientSocket.unshift(tail);
        handleHttpsRequest(clientSocket, hostname, port, ca, leafCache, profile);
        return;
      }
      // Plain HTTP request — forward as-is via cycletls
      handlePlainHttp(clientSocket, firstLine, head, tail, profile).catch((err) => mitmLog(`plain http err ${err.message || err}`));
    };
    clientSocket.on("data", onData);
    clientSocket.on("error", () => {});
  });

  return server;
}

async function handlePlainHttp(clientSocket, firstLine, fullHead, bodyBuf, profile) {
  const m = firstLine.match(/^(\S+)\s+(\S+)\s+HTTP\/(\d\.\d)$/);
  if (!m) { try { clientSocket.destroy(); } catch (_) {} return; }
  const method = m[1];
  const fullUrl = m[2];
  const headerLines = fullHead.split("\r\n").slice(1);
  const headers = {};
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const url = /^https?:\/\//.test(fullUrl) ? fullUrl : `http://${headers.host}${fullUrl}`;
  delete headers["proxy-connection"];
  delete headers["connection"];

  try {
    const opts = {
      body: bodyBuf && bodyBuf.length ? bodyBuf.toString("utf8") : "",
      ja3: profile.ja3,
      userAgent: profile.userAgent,
      headers,
      timeout: 30,
      disableRedirect: true,
      responseType: "arraybuffer"
    };
    if (profile.upstreamProxyUrl) opts.proxy = profile.upstreamProxyUrl;
    const resp = await profile.cycleClient(url, opts, method.toUpperCase());
    const parsed = await readCycleResponse(resp);
    if (parsed.errorMessage) {
      mitmLog(`mitm plain upstream-error url=${url} status=${parsed.status} msg=${parsed.errorMessage.slice(0, 200)}`);
      writeHttpResponse(clientSocket, 502, "Bridge Upstream Error", { "content-type": "text/plain" }, `Privacy Shield MITM bridge could not fetch this page.\n\n${parsed.errorMessage}`);
      return;
    }
    writeHttpResponse(clientSocket, parsed.status || 502, "", parsed.headers, parsed.bodyBuf);
  } catch (err) {
    writeHttpResponse(clientSocket, 502, "Bridge Error", { "content-type": "text/plain" }, `Bridge upstream error: ${err.message || err}`);
  }
}

function upstreamKey(upstream) {
  return [upstream.scheme || "http", upstream.host, upstream.port, upstream.username || "", upstream.password || ""].join("|");
}

async function getMitmBridge(profileId, upstream, fingerprintSeed) {
  if (!lazyLoadDeps()) {
    mitmLog(`deps unavailable, MITM disabled for profile=${profileId}`);
    return null;
  }
  const scheme = String(upstream && upstream.scheme || "http").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    mitmLog(`MITM only supports http upstream, got ${scheme} — skipping for profile=${profileId}`);
    return null;
  }
  const key = upstreamKey(upstream);
  const existing = bridges.get(profileId);
  if (existing && existing.key === key) {
    return { host: "127.0.0.1", port: existing.port, caPem: existing.caPem };
  }
  if (existing) stopMitmBridge(profileId);

  try {
    const ca = loadOrCreateCA(profileId);
    const ja3 = pickJa3ForProfile(fingerprintSeed || profileId);
    const cycleTlsPort = await pickFreePort();
    mitmLog(`starting cycletls profile=${profileId} port=${cycleTlsPort} binary=${cycletlsBinaryPath}`);
    const cycleClient = await initCycleTLS({
      port: cycleTlsPort,
      executablePath: cycletlsBinaryPath,
      timeout: 30000
    });
    const leafCache = new Map();
    const server = createMitmServer(profileId, upstream, ja3, ca, leafCache, cycleClient);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = server.address().port;
    bridges.set(profileId, { server, port, key, caPem: ca.caPem, leafCache, cycleClient, ja3: ja3.label, userAgent: ja3.ua, upstream });
    mitmLog(`mitm bridge profile=${profileId} ja3=${ja3.label} local=127.0.0.1:${port} -> ${scheme}://${upstream.host}:${upstream.port}`);
    return { host: "127.0.0.1", port, caPem: ca.caPem };
  } catch (err) {
    mitmLog(`mitm bridge start failed profile=${profileId} ${err.message || err}`);
    return null;
  }
}

function stopMitmBridge(profileId) {
  const entry = bridges.get(profileId);
  if (!entry) return;
  try { entry.server.close(); } catch (_) {}
  try { entry.cycleClient && entry.cycleClient.exit && entry.cycleClient.exit(); } catch (_) {}
  bridges.delete(profileId);
}

function stopAll() {
  for (const id of Array.from(bridges.keys())) stopMitmBridge(id);
}

function getCAForProfile(profileId) {
  if (!lazyLoadDeps()) return null;
  try {
    const ca = loadOrCreateCA(profileId);
    return ca.caPem;
  } catch (_) {
    return null;
  }
}

module.exports = { getMitmBridge, stopMitmBridge, stopAll, getCAForProfile };
