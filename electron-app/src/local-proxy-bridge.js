"use strict";

// Local HTTP proxy bridge.
//
// Chromium/Electron proxy authentication can fail on HTTPS CONNECT with some
// commercial HTTP proxies. The bridge gives Chromium a no-auth localhost proxy
// and forwards each request to the real upstream with Proxy-Authorization.
//
// SOAX and similar providers also DNS-rotate proxy hosts. Some returned backend
// IPs can accept TCP slowly or not answer CONNECT at all. The bridge resolves
// multiple IPv4 candidates, retries them with short timeouts, and logs the
// upstream status without writing credentials.

const dns = require("dns");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");

const bridges = new Map(); // profileId -> { server, port, key }
const dnsCache = new Map(); // host -> { expiresAt, addresses }
const badTargets = new Map(); // host:port:address -> expiresAt
const goodTargets = new Map(); // host:port -> { expiresAt, address }
const bridgeLogRecent = new Map(); // repeated message -> next allowed timestamp

const DNS_TTL_MS = 30 * 1000;
const BAD_TARGET_TTL_MS = 30 * 1000;
const GOOD_TARGET_TTL_MS = 5 * 60 * 1000;
const REPEATED_LOG_THROTTLE_MS = 10 * 1000;
const DNS_TIMEOUT_MS = 1800;
const CONNECT_TIMEOUT_MS = 5000;
const PREFERRED_CONNECT_TIMEOUT_MS = 2500;
const CONNECT_RACE_STAGGER_MS = 750;
const PROXY_RESPONSE_TIMEOUT_MS = 12000;
const PLAIN_RESPONSE_TIMEOUT_MS = 12000;
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];

function bridgeLog(msg) {
  try {
    const text = String(msg);
    if (text.startsWith("proxy bridge backend bad ")) {
      const nextAllowed = bridgeLogRecent.get(text) || 0;
      if (nextAllowed > Date.now()) return;
      bridgeLogRecent.set(text, Date.now() + REPEATED_LOG_THROTTLE_MS);
      if (bridgeLogRecent.size > 500) {
        const now = Date.now();
        for (const [key, expiresAt] of bridgeLogRecent) {
          if (expiresAt <= now || bridgeLogRecent.size > 400) bridgeLogRecent.delete(key);
        }
      }
    }
    const { app } = require("electron");
    const dir = app && typeof app.getPath === "function" ? app.getPath("userData") : os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "privacy-shield-error.txt"), new Date().toISOString() + " " + text + "\n", "utf8");
  } catch (_) {}
}

function upstreamKey(upstream) {
  return [upstream.scheme || "http", upstream.host, upstream.port, upstream.username || "", upstream.password || ""].join("|");
}

function basicAuth(user, pass) {
  return "Basic " + Buffer.from(`${user || ""}:${pass || ""}`).toString("base64");
}

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise)
      .then((value) => resolve(value))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

function addAddress(out, value) {
  const ip = String(value || "").trim();
  if (net.isIP(ip) === 4 && !out.includes(ip)) out.push(ip);
}

function addCandidate(out, value) {
  const candidate = String(value || "").trim();
  if (!candidate) return;
  if (net.isIP(candidate) !== 4 && !/^[a-z0-9.-]+$/i.test(candidate)) return;
  if (!out.includes(candidate)) out.push(candidate);
}

async function resolve4WithServer(host, server) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers([server]);
  return withTimeout(resolver.resolve4(host), DNS_TIMEOUT_MS, []);
}

function badTargetKey(host, port, address) {
  return `${host}:${port}:${address}`;
}

function targetKey(host, port) {
  return `${host}:${port}`;
}

function isBadTarget(host, port, address) {
  const key = badTargetKey(host, port, address);
  const expiresAt = badTargets.get(key) || 0;
  if (expiresAt > Date.now()) return true;
  if (expiresAt) badTargets.delete(key);
  return false;
}

function markBadTarget(host, port, address, reason) {
  if (!address || address === host) return;
  badTargets.set(badTargetKey(host, port, address), Date.now() + BAD_TARGET_TTL_MS);
  bridgeLog(`proxy bridge backend bad host=${host}:${port} address=${address} reason=${reason || "unknown"}`);
}

function getGoodTarget(host, port) {
  const cached = goodTargets.get(targetKey(host, port));
  if (!cached) return "";
  if (cached.expiresAt > Date.now()) return cached.address;
  goodTargets.delete(targetKey(host, port));
  return "";
}

function markGoodTarget(host, port, address) {
  if (!address) return;
  const key = targetKey(host, port);
  const previous = goodTargets.get(key);
  goodTargets.set(key, { address, expiresAt: Date.now() + GOOD_TARGET_TTL_MS });
  if (!previous || previous.address !== address) {
    bridgeLog(`proxy bridge backend selected host=${host}:${port} address=${address}`);
  }
}

async function resolveCandidates(host, port) {
  const upstreamHost = String(host || "").trim();
  if (!upstreamHost) return [];
  if (net.isIP(upstreamHost)) return [upstreamHost];

  const cached = dnsCache.get(upstreamHost);
  if (cached && cached.expiresAt > Date.now() && cached.addresses.length) {
    return orderCandidates(upstreamHost, port, cached.addresses);
  }

  const addresses = [];

  const lookup = await withTimeout(dns.promises.lookup(upstreamHost, { all: true, family: 4 }), DNS_TIMEOUT_MS, []);
  for (const entry of lookup || []) addAddress(addresses, entry.address);

  const resolved = await withTimeout(dns.promises.resolve4(upstreamHost), DNS_TIMEOUT_MS, []);
  for (const address of resolved || []) addAddress(addresses, address);

  for (const server of PUBLIC_RESOLVERS) {
    const fromServer = await resolve4WithServer(upstreamHost, server);
    for (const address of fromServer || []) addAddress(addresses, address);
  }

  dnsCache.set(upstreamHost, { expiresAt: Date.now() + DNS_TTL_MS, addresses });
  if (addresses.length) {
    bridgeLog(`proxy bridge dns host=${upstreamHost} candidates=${addresses.join(",")}`);
  } else {
    bridgeLog(`proxy bridge dns host=${upstreamHost} no IPv4 candidates; using hostname fallback`);
  }

  const ordered = orderCandidates(upstreamHost, port, addresses);
  if (!ordered.length) return [upstreamHost];
  return ordered;
}

function orderCandidates(host, port, addresses) {
  const preferred = getGoodTarget(host, port);
  const unique = [];
  if (preferred) addCandidate(unique, preferred);
  for (const address of addresses) addCandidate(unique, address);
  if (!unique.length) addCandidate(unique, host);
  return unique.sort((a, b) => {
    if (a === preferred && b !== preferred) return -1;
    if (b === preferred && a !== preferred) return 1;
    return Number(isBadTarget(host, port, a)) - Number(isBadTarget(host, port, b));
  });
}

function connectSocket(upstream, address, onSocket, timeoutMs = CONNECT_TIMEOUT_MS) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const scheme = String(upstream.scheme || "http").toLowerCase();

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(socket);
    };

    const opts = {
      host: address,
      port: upstreamPort,
      servername: upstreamHost
    };
    const socket = scheme === "https"
      ? tls.connect({ ...opts, rejectUnauthorized: true }, () => finish(null, socket))
      : net.connect(opts, () => finish(null, socket));
    if (typeof onSocket === "function") onSocket(socket);

    const timer = setTimeout(() => {
      try { socket.destroy(); } catch (_) {}
      finish(new Error("connect timeout"));
    }, timeoutMs);

    socket.once("error", (err) => finish(err || new Error("socket error")));
  });
}

function connectAnySocket(upstream, candidates, clientSocket) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const list = candidates.length ? candidates : [upstreamHost];

  return new Promise((resolve, reject) => {
    let settled = false;
    let launched = 0;
    let pending = 0;
    let lastErr = null;
    const sockets = new Set();
    const timers = [];

    const cleanup = (winner) => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) {
        if (socket !== winner) {
          try { socket.destroy(); } catch (_) {}
        }
      }
    };

    const maybeReject = () => {
      if (!settled && launched >= list.length && pending === 0) {
        settled = true;
        cleanup();
        reject(lastErr || new Error("connect failed"));
      }
    };

    for (const address of list) {
      const timer = setTimeout(() => {
        if (settled || (clientSocket && clientSocket.destroyed)) {
          launched++;
          maybeReject();
          return;
        }
        launched++;
        pending++;
        connectSocket(upstream, address, (socket) => sockets.add(socket))
          .then((socket) => {
            pending--;
            if (settled || (clientSocket && clientSocket.destroyed)) {
              try { socket.destroy(); } catch (_) {}
              maybeReject();
              return;
            }
            settled = true;
            cleanup(socket);
            resolve({ socket, address });
          })
          .catch((err) => {
            pending--;
            lastErr = err || new Error("connect failed");
            markBadTarget(upstreamHost, upstreamPort, address, lastErr.code || lastErr.message || "connect failed");
            maybeReject();
          });
      }, timers.length * CONNECT_RACE_STAGGER_MS);
      timers.push(timer);
    }
  });
}

async function connectUpstreamSocket(upstream, candidates, clientSocket) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const preferred = getGoodTarget(upstreamHost, upstreamPort);
  if (preferred && candidates.includes(preferred) && !isBadTarget(upstreamHost, upstreamPort, preferred)) {
    try {
      const socket = await connectSocket(upstream, preferred, null, PREFERRED_CONNECT_TIMEOUT_MS);
      return { socket, address: preferred };
    } catch (err) {
      markBadTarget(upstreamHost, upstreamPort, preferred, err && (err.code || err.message) || "preferred connect failed");
    }
  }

  const remaining = preferred ? candidates.filter((address) => address !== preferred) : candidates;
  return connectAnySocket(upstream, remaining.length ? remaining : candidates, clientSocket);
}

function sendClientFailure(clientSocket, code, msg) {
  try {
    const safeCode = Number(code) || 502;
    const safeMsg = String(msg || "Proxy bridge failed").replace(/[\r\n]+/g, " ").slice(0, 180);
    clientSocket.write(`HTTP/1.1 ${safeCode} ${safeMsg}\r\nConnection: close\r\n\r\n`);
  } catch (_) {}
  try { clientSocket.end(); } catch (_) {}
}

function waitForConnectResponse(socket, connectReq, clientSocket, head, upstream, address) {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };
    const establish = (tail) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: PrivacyShield-Bridge\r\n\r\n");
        if (head && head.length) socket.write(head);
        if (tail && tail.length) clientSocket.write(tail);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
      } catch (err) {
        try { socket.destroy(); } catch (_) {}
        resolve({ ok: false, retry: false, reason: err.message || String(err) });
        return;
      }
      socket.on("error", () => { try { clientSocket.destroy(); } catch (_) {} });
      resolve({ ok: true });
    };
    const timer = setTimeout(() => {
      bridgeLog(`proxy bridge CONNECT timeout host=${upstream.host}:${upstream.port} address=${address}`);
      finish({ ok: false, retry: true, reason: "upstream CONNECT timed out" });
    }, PROXY_RESPONSE_TIMEOUT_MS);

    function onError(err) {
      finish({ ok: false, retry: true, reason: err && (err.code || err.message) || "socket error" });
    }
    function onEnd() {
      finish({ ok: false, retry: true, reason: "upstream closed before CONNECT response" });
    }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) {
        if (buf.length > 16384) finish({ ok: false, retry: false, code: 502, reason: "upstream header too large" });
        return;
      }

      const headerText = buf.slice(0, sep).toString("utf8");
      const tail = buf.slice(sep + 4);
      const statusLine = headerText.split("\r\n")[0] || "";
      const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/i);
      const status = match ? Number(match[1]) : 0;

      if (status === 200) {
        establish(tail);
        return;
      }

      const reason = statusLine.replace(/^HTTP\/\d\.\d\s+\d+\s*/i, "").trim() || `upstream status ${status || "?"}`;
      bridgeLog(`proxy bridge CONNECT rejected host=${upstream.host}:${upstream.port} address=${address} status=${status || "?"} reason=${reason}`);

      if (status === 407 || status === 401 || status === 400 || status === 403 || status === 422) {
        finish({ ok: false, retry: false, code: status || 502, reason });
      } else {
        finish({ ok: false, retry: true, reason });
      }
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.write(connectReq);
  });
}

async function handleConnect(upstream, auth, req, clientSocket, head) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const targetHostPort = req.url;
  const connectReqLines = [
    `CONNECT ${targetHostPort} HTTP/1.1`,
    `Host: ${targetHostPort}`
  ];
  if (auth) connectReqLines.push(`Proxy-Authorization: ${auth}`);
  connectReqLines.push("Proxy-Connection: Keep-Alive");
  connectReqLines.push("User-Agent: Mozilla/5.0");
  connectReqLines.push("", "");
  const connectReq = connectReqLines.join("\r\n");

  let currentSocket = null;
  clientSocket.on("close", () => {
    if (currentSocket) {
      try { currentSocket.destroy(); } catch (_) {}
    }
  });

  const candidates = await resolveCandidates(upstreamHost, upstreamPort);
  let lastReason = "no upstream candidates";

  while (candidates.length) {
    if (clientSocket.destroyed) return;
    try {
      const connected = await connectUpstreamSocket(upstream, candidates, clientSocket);
      currentSocket = connected.socket;
      const address = connected.address;
      const result = await waitForConnectResponse(currentSocket, connectReq, clientSocket, head, upstream, address);
      if (result.ok) {
        markGoodTarget(upstreamHost, upstreamPort, address);
        return;
      }

      lastReason = result.reason || "CONNECT failed";
      try { currentSocket.destroy(); } catch (_) {}
      currentSocket = null;

      if (!result.retry) {
        sendClientFailure(clientSocket, result.code || 502, result.reason || "upstream rejected CONNECT");
        return;
      }
      markBadTarget(upstreamHost, upstreamPort, address, lastReason);
      const index = candidates.indexOf(address);
      if (index !== -1) candidates.splice(index, 1);
    } catch (err) {
      lastReason = err && (err.code || err.message) || "connect failed";
      break;
    }
  }

  bridgeLog(`proxy bridge CONNECT exhausted host=${upstreamHost}:${upstreamPort} target=${targetHostPort} reason=${lastReason}`);
  sendClientFailure(clientSocket, 502, "Bridge upstream failed: " + lastReason);
}

function collectRequestBody(req, callback) {
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total <= 2 * 1024 * 1024) chunks.push(chunk);
  });
  req.on("end", () => callback(Buffer.concat(chunks)));
}

async function forwardPlainRequest(upstream, auth, req, res, body) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const candidates = await resolveCandidates(upstreamHost, upstreamPort);
  const scheme = String(upstream.scheme || "http").toLowerCase();
  const requestModule = scheme === "https" ? https : http;
  let lastReason = "no upstream candidates";

  for (const address of candidates) {
    const result = await new Promise((resolve) => {
      const headers = { ...req.headers };
      if (auth) headers["Proxy-Authorization"] = auth;
      delete headers["proxy-connection"];

      const opts = {
        host: address,
        port: upstreamPort,
        servername: upstreamHost,
        method: req.method,
        path: req.url,
        headers
      };

      const upReq = requestModule.request(opts, (upRes) => {
        resolve({ ok: true, response: upRes });
      });
      upReq.on("error", (err) => {
        resolve({ ok: false, reason: err && (err.code || err.message) || "request error" });
      });
      upReq.setTimeout(PLAIN_RESPONSE_TIMEOUT_MS, () => {
        try { upReq.destroy(new Error("plain request timed out")); } catch (_) {}
      });
      if (body && body.length) upReq.write(body);
      upReq.end();
    });

    if (result.ok) {
      markGoodTarget(upstreamHost, upstreamPort, address);
      try {
        res.writeHead(result.response.statusCode || 502, result.response.headers);
        result.response.pipe(res);
      } catch (_) {
        try { res.end(); } catch (__) {}
      }
      return;
    }

    lastReason = result.reason || "request failed";
    markBadTarget(upstreamHost, upstreamPort, address, lastReason);
  }

  bridgeLog(`proxy bridge HTTP exhausted host=${upstreamHost}:${upstreamPort} url=${req.url} reason=${lastReason}`);
  try {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bridge upstream error: " + lastReason);
  } catch (_) {
    try { res.end(); } catch (__) {}
  }
}

function createServer(upstream) {
  const upstreamHost = String(upstream.host || "");
  const upstreamPort = Number(upstream.port) || 0;
  const auth = (upstream.username || upstream.password) ? basicAuth(upstream.username, upstream.password) : "";

  const server = http.createServer();

  server.on("request", (req, res) => {
    collectRequestBody(req, (body) => {
      forwardPlainRequest(upstream, auth, req, res, body).catch((err) => {
        bridgeLog(`proxy bridge HTTP threw host=${upstreamHost}:${upstreamPort} error=${err && (err.stack || err)}`);
        try {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bridge upstream error");
        } catch (_) {}
      });
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    handleConnect(upstream, auth, req, clientSocket, head).catch((err) => {
      bridgeLog(`proxy bridge CONNECT threw host=${upstreamHost}:${upstreamPort} target=${req.url} error=${err && (err.stack || err)}`);
      sendClientFailure(clientSocket, 502, "Bridge upstream error");
    });
  });

  return server;
}

function startServer(upstream) {
  return new Promise((resolve, reject) => {
    const server = createServer(upstream);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function getBridge(profileId, upstream) {
  if (!upstream || !upstream.host || !upstream.port) return null;
  const scheme = String(upstream.scheme || "http").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;

  const key = upstreamKey(upstream);
  const existing = bridges.get(profileId);
  if (existing && existing.key === key) return { host: "127.0.0.1", port: existing.port };
  if (existing) stopBridge(profileId);

  try {
    const { server, port } = await startServer({ ...upstream, scheme });
    bridges.set(profileId, { server, port, key });
    return { host: "127.0.0.1", port };
  } catch (err) {
    bridgeLog(`proxy bridge start failed profile=${profileId} host=${upstream.host}:${upstream.port} error=${err && (err.message || err)}`);
    return null;
  }
}

function stopBridge(profileId) {
  const entry = bridges.get(profileId);
  if (!entry) return;
  try { entry.server.close(); } catch (_) {}
  bridges.delete(profileId);
}

function stopAll() {
  for (const id of Array.from(bridges.keys())) stopBridge(id);
}

module.exports = { getBridge, stopBridge, stopAll };
