"use strict";

// Minimal dependency-free SOCKS5 + HTTP CONNECT proxy used by VPS installs.
// It is uploaded to /opt/privacy-proxy/server.js by vps-proxy-manager.js.
module.exports = `#!/usr/bin/env node
"use strict";

const net = require("net");
const http = require("http");
const dns = require("dns").promises;
const os = require("os");

const SOCKS_PORT = parseInt(process.env.PORT || "1080", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8080", 10);
const INFO_PORT = parseInt(process.env.INFO_PORT || "8888", 10);
const USERNAME = process.env.PROXY_USER || "";
const PASSWORD = process.env.PROXY_PASS || "";
const COUNTRY = process.env.COUNTRY || "";
const MAX_CONNS = parseInt(process.env.MAX_CONNS || "500", 10);
const CONN_TIMEOUT = parseInt(process.env.TIMEOUT || "30000", 10);
const USE_AUTH = Boolean(USERNAME && PASSWORD);

const S5 = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_NOACCEPT = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP = { OK:0, FAIL:1, FORBIDDEN:2, NET_UNREACH:3, HOST_UNREACH:4, REFUSED:5, TTL_EXPIRED:6, CMD_UNSUPPORTED:7, ATYP_UNSUPPORTED:8 };
const stats = { connections: 0, active: 0, bytes: 0, startTime: Date.now() };

function log(level, ...args) {
  const target = level === "error" ? console.error : console.log;
  target("[privacy-proxy]", new Date().toISOString(), level, ...args);
}

function s5Reply(socket, rep, atyp = ATYP_IPV4, addr = Buffer.alloc(4), port = 0) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  try {
    if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from([S5, rep, 0, atyp]), addr, portBuf]));
  } catch (_) {}
}

function readOnce(socket) {
  return new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed")));
  });
}

function relay(a, b) {
  a.pipe(b, { end: false });
  b.pipe(a, { end: false });
  const cleanup = () => {
    try { a.destroy(); } catch (_) {}
    try { b.destroy(); } catch (_) {}
  };
  a.once("close", cleanup);
  b.once("close", cleanup);
  a.once("error", cleanup);
  b.once("error", cleanup);
  a.on("data", (d) => { stats.bytes += d.length; });
  b.on("data", (d) => { stats.bytes += d.length; });
}

async function handleSocks5(socket) {
  socket.setTimeout(CONN_TIMEOUT);
  socket.on("timeout", () => socket.destroy());
  socket.on("error", () => {});

  try {
    const greeting = await readOnce(socket);
    if (greeting[0] !== S5) { socket.destroy(); return; }
    const methods = Array.from(greeting.slice(2, 2 + greeting[1]));

    if (USE_AUTH) {
      if (!methods.includes(AUTH_USERPASS)) {
        socket.write(Buffer.from([S5, AUTH_NOACCEPT]));
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([S5, AUTH_USERPASS]));
      const auth = await readOnce(socket);
      const uLen = auth[1];
      const user = auth.slice(2, 2 + uLen).toString("utf8");
      const pLen = auth[2 + uLen];
      const pass = auth.slice(3 + uLen, 3 + uLen + pLen).toString("utf8");
      if (user !== USERNAME || pass !== PASSWORD) {
        socket.write(Buffer.from([1, 1]));
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([1, 0]));
    } else {
      socket.write(Buffer.from([S5, AUTH_NONE]));
    }

    const req = await readOnce(socket);
    if (req[0] !== S5 || req[1] !== CMD_CONNECT) {
      s5Reply(socket, REP.CMD_UNSUPPORTED);
      socket.destroy();
      return;
    }

    let host = "";
    let port = 0;
    let addrBuf = Buffer.alloc(4);
    const atyp = req[3];
    if (atyp === ATYP_IPV4) {
      addrBuf = req.slice(4, 8);
      host = addrBuf.join(".");
      port = req.readUInt16BE(8);
    } else if (atyp === ATYP_DOMAIN) {
      const len = req[4];
      host = req.slice(5, 5 + len).toString("utf8");
      port = req.readUInt16BE(5 + len);
      try {
        const addrs = await dns.resolve4(host);
        addrBuf = Buffer.from(addrs[0].split(".").map(Number));
      } catch (_) {}
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

    const target = net.createConnection({ host, port, allowHalfOpen: false });
    target.once("connect", () => {
      s5Reply(socket, REP.OK, ATYP_IPV4, addrBuf, port);
      socket.setTimeout(0);
      target.setTimeout(0);
      stats.active++;
      target.once("close", () => { stats.active = Math.max(0, stats.active - 1); });
      relay(socket, target);
    });
    target.once("error", (err) => {
      const rep = err.code === "ECONNREFUSED" ? REP.REFUSED
        : err.code === "EHOSTUNREACH" ? REP.HOST_UNREACH
        : err.code === "ENETUNREACH" ? REP.NET_UNREACH
        : REP.FAIL;
      s5Reply(socket, rep);
      socket.destroy();
    });
    target.setTimeout(CONN_TIMEOUT, () => {
      s5Reply(socket, REP.TTL_EXPIRED);
      target.destroy();
      socket.destroy();
    });
  } catch (_) {
    try { socket.destroy(); } catch (_) {}
  }
}

function checkBasicAuth(header) {
  try {
    const b64 = String(header || "").replace(/^Basic\\s+/i, "");
    const [user, ...rest] = Buffer.from(b64, "base64").toString().split(":");
    return user === USERNAME && rest.join(":") === PASSWORD;
  } catch (_) {
    return false;
  }
}

function handleHttpConnect(req, clientSocket, head) {
  clientSocket.on("error", () => {});
  if (USE_AUTH && !checkBasicAuth(req.headers["proxy-authorization"])) {
    clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\\r\\nProxy-Authenticate: Basic realm=\\"PrivacyShield\\"\\r\\nContent-Length: 0\\r\\n\\r\\n");
    clientSocket.destroy();
    return;
  }
  const [host, portRaw] = req.url.split(":");
  const port = parseInt(portRaw || "443", 10);
  const target = net.createConnection({ host, port }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) target.write(head);
    relay(clientSocket, target);
  });
  target.on("error", () => {
    try { clientSocket.write("HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n"); } catch (_) {}
    clientSocket.destroy();
  });
  target.setTimeout(CONN_TIMEOUT, () => target.destroy());
}

const socksServer = net.createServer({ allowHalfOpen: false }, (socket) => {
  if (stats.connections >= MAX_CONNS) { socket.destroy(); return; }
  stats.connections++;
  socket.on("close", () => { stats.connections = Math.max(0, stats.connections - 1); });
  handleSocks5(socket);
});
socksServer.listen(SOCKS_PORT, "0.0.0.0", () => log("info", "SOCKS5 listening", SOCKS_PORT, "country", COUNTRY));
socksServer.on("error", (err) => log("error", "SOCKS5", err.message));

const httpServer = http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Privacy Shield Proxy\\n");
});
httpServer.on("connect", handleHttpConnect);
httpServer.listen(HTTP_PORT, "0.0.0.0", () => log("info", "HTTP CONNECT listening", HTTP_PORT));
httpServer.on("error", (err) => log("error", "HTTP", err.message));

const infoServer = http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({
    status: "ok",
    server: "Privacy Shield Proxy",
    version: "1.1.0",
    socks5_port: SOCKS_PORT,
    http_port: HTTP_PORT,
    country: COUNTRY,
    auth: USE_AUTH,
    connections: stats.connections,
    active: stats.active,
    bytes_total: stats.bytes,
    uptime_sec: Math.floor((Date.now() - stats.startTime) / 1000),
    hostname: os.hostname()
  }, null, 2));
});
infoServer.listen(INFO_PORT, "0.0.0.0", () => log("info", "Info listening", INFO_PORT));

process.on("SIGTERM", () => {
  socksServer.close();
  httpServer.close();
  infoServer.close();
  process.exit(0);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
`;
