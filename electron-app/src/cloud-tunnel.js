"use strict";
// PC side of "VPN mode" cloud profiles. For every profile the VPN gate allows,
// keep a few reverse sockets open to the runner's /tunnel/<id>; the runner splices
// box connections onto them and this PC acts as the box's HTTP proxy, dialing out
// over its own network (= the VPN). Not allowed / app closed → sockets close →
// the box has no internet and the runner freezes it.

const tls = require("tls");
const net = require("net");
const dns = require("dns").promises;

const POOL_SIZE = 4;
const state = new Map(); // id -> { idle:Set, active:Set, opening:number, retryAt:number }
let settings = null;

// The box is a browser on the open web: refuse to let pages reach this PC or its
// LAN (router, NAS, localhost services) through the tunnel.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
}

async function dialPublic(host, port) {
  const { address } = await dns.lookup(host);
  if (isPrivateIp(address)) throw new Error(`blocked private address ${address}`);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, address, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(30000, () => s.destroy(new Error("connect timeout")));
  });
}

// Minimal HTTP proxy on one tunnel socket: CONNECT (HTTPS/WSS) or absolute-form
// plain HTTP (forced Connection: close so each request gets its own socket).
function serveProxy(sock, first) {
  let buf = first;
  const onData = (d) => { buf = Buffer.concat([buf, d]); tryHead(); };
  const fail = (code) => { try { sock.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch (_) {} };
  const tryHead = async () => {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) { if (buf.length > 65536) sock.destroy(); return; }
    sock.removeListener("data", onData);
    sock.pause();
    const head = buf.slice(0, end).toString("latin1");
    const rest = buf.slice(end + 4);
    const [line, ...headers] = head.split("\r\n");
    const [method, target] = line.split(" ");
    try {
      if (method === "CONNECT") {
        const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target || "");
        if (!m) return fail("400 Bad Request");
        const up = await dialPublic(m[1], Number(m[2]));
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) up.write(rest);
        up.pipe(sock); sock.pipe(up); sock.resume();
        up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
        up.on("close", () => sock.destroy()); sock.on("close", () => up.destroy());
        return;
      }
      const u = new URL(target);
      if (u.protocol !== "http:") return fail("400 Bad Request");
      const up = await dialPublic(u.hostname, Number(u.port) || 80);
      const kept = headers.filter((h) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(h));
      up.write(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${kept.join("\r\n")}\r\nConnection: close\r\n\r\n`);
      if (rest.length) up.write(rest);
      up.pipe(sock); sock.pipe(up); sock.resume();
      up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
      up.on("close", () => sock.destroy()); sock.on("close", () => up.destroy());
    } catch (_) {
      fail("502 Bad Gateway");
    }
  };
  sock.on("data", onData);
  tryHead();
}

function openOne(id) {
  const st = state.get(id);
  if (!st || !settings) return;
  st.opening++;
  const u = new URL(settings.url);
  const sock = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname });
  let upgraded = false, head = Buffer.alloc(0);
  const settle = () => { st.opening = Math.max(0, st.opening - 1); };
  sock.on("secureConnect", () => {
    sock.write(`GET /tunnel/${encodeURIComponent(id)} HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${settings.token}\r\nConnection: Upgrade\r\nUpgrade: ps-tunnel\r\n\r\n`);
  });
  const onData = (d) => {
    if (!upgraded) {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(head.toString("latin1"))) { sock.destroy(); return; }
      upgraded = true; settle();
      sock.setKeepAlive(true, 30000);
      st.idle.add(sock);
      const extra = head.slice(end + 4);
      if (!extra.length) return;
      d = extra;
    }
    // First bytes from the runner = a box connection arrived on this socket.
    sock.removeListener("data", onData);
    st.idle.delete(sock); st.active.add(sock);
    sock.once("close", () => st.active.delete(sock));
    fill(id);
    serveProxy(sock, d);
  };
  sock.on("data", onData);
  sock.on("error", () => {});
  sock.on("close", () => {
    if (!upgraded) { settle(); st.retryAt = Date.now() + 5000; }
    st.idle.delete(sock);
    if (state.get(id) === st) setTimeout(() => fill(id), Math.max(0, st.retryAt - Date.now()));
  });
}

function fill(id) {
  const st = state.get(id);
  if (!st || Date.now() < st.retryAt) return;
  while (st.idle.size + st.opening < POOL_SIZE) openOne(id);
}

function stop(id) {
  const st = state.get(id);
  if (!st) return;
  state.delete(id);
  for (const s of [...st.idle, ...st.active]) s.destroy();
}

// Called by the VPN gate: exactly these profiles may use this PC as their exit.
function setAllowed(nextSettings, ids) {
  const sameServer = settings && nextSettings && settings.url === nextSettings.url && settings.token === nextSettings.token;
  if (!sameServer) for (const id of [...state.keys()]) stop(id);
  settings = nextSettings && nextSettings.url && nextSettings.token ? nextSettings : null;
  const want = new Set(settings ? ids : []);
  for (const id of [...state.keys()]) if (!want.has(id)) stop(id);
  for (const id of want) {
    if (!state.has(id)) state.set(id, { idle: new Set(), active: new Set(), opening: 0, retryAt: 0 });
    fill(id);
  }
}

function activeIds() { return [...state.keys()]; }

module.exports = { setAllowed, activeIds, isPrivateIp };
