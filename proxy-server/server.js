#!/usr/bin/env node
/**
 * Privacy Shield — SOCKS5 + HTTP Proxy Server
 * Implements RFC 1928 (SOCKS5) and RFC 1929 (username/password auth).
 * No external dependencies — uses only Node.js built-in modules.
 *
 * Usage:
 *   PORT=1080 HTTP_PORT=8080 PROXY_USER=myuser PROXY_PASS=mypass node server.js
 *
 * Or with a .env file:
 *   node server.js
 */

"use strict";

const net  = require("net");
const http = require("http");
const dns  = require("dns").promises;
const os   = require("os");

// ─── Config ───────────────────────────────────────────────────────────────────
const SOCKS_PORT  = parseInt(process.env.PORT       || "1080",  10);
const HTTP_PORT   = parseInt(process.env.HTTP_PORT  || "8080",  10);
const INFO_PORT   = parseInt(process.env.INFO_PORT  || "8888",  10);
const USERNAME    = process.env.PROXY_USER || "";
const PASSWORD    = process.env.PROXY_PASS || "";
const COUNTRY     = process.env.COUNTRY    || "";       // e.g. "us", "ng"
const MAX_CONNS   = parseInt(process.env.MAX_CONNS  || "500",   10);
const CONN_TIMEOUT= parseInt(process.env.TIMEOUT    || "30000", 10); // ms

const USE_AUTH = USERNAME.length > 0 && PASSWORD.length > 0;

// ─── SOCKS5 constants ────────────────────────────────────────────────────────
const S5_VER          = 0x05;
const AUTH_NONE       = 0x00;
const AUTH_USERPASS   = 0x02;
const AUTH_NOACCEPT   = 0xFF;
const CMD_CONNECT     = 0x01;
const ATYP_IPV4       = 0x01;
const ATYP_DOMAIN     = 0x03;
const ATYP_IPV6       = 0x04;

const REP = {
  OK:             0x00,
  FAIL:           0x01,
  FORBIDDEN:      0x02,
  NET_UNREACH:    0x03,
  HOST_UNREACH:   0x04,
  REFUSED:        0x05,
  TTL_EXPIRED:    0x06,
  CMD_UNSUPPORTED:0x07,
  ATYP_UNSUPPORTED:0x08,
};

// ─── Stats ───────────────────────────────────────────────────────────────────
const stats = { connections: 0, active: 0, bytes: 0, startTime: Date.now() };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${ts}] [${level.toUpperCase()}]`, ...args);
}

function s5Reply(socket, rep, atyp = ATYP_IPV4, addr = Buffer.alloc(4), port = 0) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const pkt = Buffer.concat([Buffer.from([S5_VER, rep, 0x00, atyp]), addr, portBuf]);
  try { if (!socket.destroyed) socket.write(pkt); } catch (_) {}
}

function readData(socket) {
  return new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed")));
  });
}

function relay(a, b) {
  a.pipe(b, { end: false });
  b.pipe(a, { end: false });
  const cleanup = () => { try { a.destroy(); } catch (_) {} try { b.destroy(); } catch (_) {} };
  a.once("close", cleanup);
  b.once("close", cleanup);
  a.once("error", cleanup);
  b.once("error", cleanup);
  // Track bytes
  a.on("data", (d) => { stats.bytes += d.length; });
  b.on("data", (d) => { stats.bytes += d.length; });
}

// ─── SOCKS5 handler ──────────────────────────────────────────────────────────
async function handleSocks5(socket) {
  socket.setTimeout(CONN_TIMEOUT);
  socket.on("timeout", () => socket.destroy());
  socket.on("error", () => {});

  try {
    // ── Phase 1: Method negotiation ──────────────────────────────────────────
    const greeting = await readData(socket);
    if (greeting[0] !== S5_VER) { socket.destroy(); return; }

    const nMethods = greeting[1];
    const methods  = Array.from(greeting.slice(2, 2 + nMethods));

    if (USE_AUTH) {
      if (!methods.includes(AUTH_USERPASS)) {
        socket.write(Buffer.from([S5_VER, AUTH_NOACCEPT]));
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([S5_VER, AUTH_USERPASS]));

      // ── Phase 2: Username/password sub-negotiation (RFC 1929) ────────────
      const authPkt = await readData(socket);
      // authPkt[0] = 0x01 (subneg version)
      const uLen = authPkt[1];
      const user  = authPkt.slice(2, 2 + uLen).toString("utf8");
      const pLen  = authPkt[2 + uLen];
      const pass  = authPkt.slice(3 + uLen, 3 + uLen + pLen).toString("utf8");

      if (user !== USERNAME || pass !== PASSWORD) {
        socket.write(Buffer.from([0x01, 0x01])); // auth failed
        socket.destroy();
        log("warn", "Auth failed from", socket.remoteAddress);
        return;
      }
      socket.write(Buffer.from([0x01, 0x00])); // auth success
    } else {
      socket.write(Buffer.from([S5_VER, AUTH_NONE]));
    }

    // ── Phase 3: Request ─────────────────────────────────────────────────────
    const req = await readData(socket);
    if (req[0] !== S5_VER) { socket.destroy(); return; }

    const cmd  = req[1];
    // req[2] === 0x00  (reserved)
    const atyp = req[3];

    if (cmd !== CMD_CONNECT) {
      s5Reply(socket, REP.CMD_UNSUPPORTED);
      socket.destroy();
      return;
    }

    let host, port, addrBuf;

    if (atyp === ATYP_IPV4) {
      addrBuf = req.slice(4, 8);
      host    = addrBuf.join(".");
      port    = req.readUInt16BE(8);
    } else if (atyp === ATYP_DOMAIN) {
      const len = req[4];
      host    = req.slice(5, 5 + len).toString("utf8");
      port    = req.readUInt16BE(5 + len);
      // Resolve domain → pick IPv4
      try {
        const addrs = await dns.resolve4(host);
        addrBuf = Buffer.from(addrs[0].split(".").map(Number));
      } catch (_) {
        addrBuf = Buffer.alloc(4);
      }
    } else if (atyp === ATYP_IPV6) {
      addrBuf = req.slice(4, 20);
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(addrBuf.readUInt16BE(i).toString(16));
      host = parts.join(":");
      port = req.readUInt16BE(20);
    } else {
      s5Reply(socket, REP.ATYP_UNSUPPORTED);
      socket.destroy();
      return;
    }

    // ── Phase 4: Connect to target ───────────────────────────────────────────
    const target = net.createConnection({ host, port, allowHalfOpen: false });

    target.once("connect", () => {
      s5Reply(socket, REP.OK, ATYP_IPV4, addrBuf, port);
      socket.setTimeout(0);
      target.setTimeout(0);
      relay(socket, target);
      stats.active++;
      target.once("close", () => stats.active--);
      log("info", `SOCKS5 CONNECT ${host}:${port} from ${socket.remoteAddress}`);
    });

    target.once("error", (err) => {
      const rep = err.code === "ECONNREFUSED" ? REP.REFUSED
                : err.code === "EHOSTUNREACH"  ? REP.HOST_UNREACH
                : err.code === "ENETUNREACH"   ? REP.NET_UNREACH
                : REP.FAIL;
      s5Reply(socket, rep);
      socket.destroy();
      log("warn", `SOCKS5 target error ${host}:${port} — ${err.code}`);
    });

    target.setTimeout(CONN_TIMEOUT, () => {
      s5Reply(socket, REP.TTL_EXPIRED);
      target.destroy();
      socket.destroy();
    });

  } catch (err) {
    try { socket.destroy(); } catch (_) {}
  }
}

// ─── HTTP CONNECT handler ────────────────────────────────────────────────────
function handleHttpConnect(req, clientSocket, head) {
  clientSocket.on("error", () => {});

  if (USE_AUTH) {
    const proxyAuth = req.headers["proxy-authorization"];
    if (!proxyAuth || !checkBasicAuth(proxyAuth)) {
      clientSocket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
        "Proxy-Authenticate: Basic realm=\"PrivacyShield\"\r\n" +
        "Content-Length: 0\r\n\r\n"
      );
      clientSocket.destroy();
      log("warn", "HTTP auth failed from", clientSocket.remoteAddress);
      return;
    }
  }

  const parts = req.url.split(":");
  const host  = parts[0];
  const port  = parseInt(parts[1] || "443", 10);

  const target = net.createConnection({ host, port }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) target.write(head);
    relay(clientSocket, target);
    log("info", `HTTP CONNECT ${host}:${port} from ${clientSocket.remoteAddress}`);
  });

  target.on("error", (err) => {
    log("warn", `HTTP CONNECT target error ${host}:${port} — ${err.message}`);
    try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch (_) {}
    clientSocket.destroy();
  });

  target.setTimeout(CONN_TIMEOUT, () => target.destroy());
}

function checkBasicAuth(header) {
  try {
    const b64 = header.replace(/^Basic\s+/i, "");
    const [user, ...rest] = Buffer.from(b64, "base64").toString().split(":");
    const pass = rest.join(":");
    return user === USERNAME && pass === PASSWORD;
  } catch (_) { return false; }
}

// ─── Info / health endpoint ──────────────────────────────────────────────────
function startInfoServer() {
  const info = http.createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }

    const uptime  = Math.floor((Date.now() - stats.startTime) / 1000);
    const payload = JSON.stringify({
      status:      "ok",
      server:      "Privacy Shield Proxy",
      version:     "1.0.0",
      socks5_port: SOCKS_PORT,
      http_port:   HTTP_PORT,
      country:     COUNTRY,
      auth:        USE_AUTH,
      connections: stats.connections,
      active:      stats.active,
      bytes_total: stats.bytes,
      uptime_sec:  uptime,
      hostname:    os.hostname()
    }, null, 2);

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(payload);
  });

  info.listen(INFO_PORT, "0.0.0.0", () =>
    log("info", `Info/health endpoint listening on :${INFO_PORT}`)
  );
}

// ─── SOCKS5 server ───────────────────────────────────────────────────────────
const socksServer = net.createServer({ allowHalfOpen: false }, (socket) => {
  if (stats.connections >= MAX_CONNS) { socket.destroy(); return; }
  stats.connections++;
  socket.on("close", () => stats.connections--);
  handleSocks5(socket);
});

socksServer.listen(SOCKS_PORT, "0.0.0.0", () =>
  log("info", `SOCKS5 proxy listening on :${SOCKS_PORT} | auth=${USE_AUTH} | country=${COUNTRY || "not set"}`)
);
socksServer.on("error", (err) => log("error", "SOCKS5 server error:", err.message));

// ─── HTTP CONNECT server ─────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Privacy Shield Proxy — use CONNECT method or SOCKS5\n");
});
httpServer.on("connect", handleHttpConnect);
httpServer.on("error", (err) => log("error", "HTTP server error:", err.message));

httpServer.listen(HTTP_PORT, "0.0.0.0", () =>
  log("info", `HTTP CONNECT proxy listening on :${HTTP_PORT}`)
);

// ─── Info server ─────────────────────────────────────────────────────────────
startInfoServer();

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  log("info", "Shutting down...");
  socksServer.close();
  httpServer.close();
  process.exit(0);
});
process.on("SIGINT", () => process.emit("SIGTERM"));

log("info", `Auth: ${USE_AUTH ? `user="${USERNAME}"` : "none (open proxy)"}`);
log("info", "Privacy Shield Proxy Server ready.");
