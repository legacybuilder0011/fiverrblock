"use strict";
// Privacy Shield cloud runner: starts/stops one sealed Docker box per profile and
// proxies its noVNC viewer. Listens on 127.0.0.1 only; Caddy terminates TLS.
// ponytail: one shared team token (PS_TOKEN file); per-user auth is Phase 2.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ROOT = "/opt/ps-cloud";
const PORT = 8320;
const IMAGE = "ps-runner";          // VNC box (still frames) — legacy
const RTC_IMAGE = "ps-runner-rtc";  // neko WebRTC box (real video + sound) — default
const PUBLIC_IP = process.env.PS_PUBLIC_IP || ""; // WebRTC media goes straight to this IP
const RTC_PORT_MIN = 52100, RTC_PORT_MAX = 52999;  // one UDP+TCP mux port per box
const TOKEN = fs.readFileSync(path.join(ROOT, "runner", "token"), "utf8").trim();
const PROFILES_DIR = path.join(ROOT, "profiles");

// Only fingerprint/locale flags may come from the client; everything that touches
// storage, extensions, proxy or sandboxing is fixed by the box.
const ALLOWED_ARG = /^--(fingerprint(-[a-z-]+)?|lang|accept-lang|timezone)=[^\s]{1,200}$/;

const docker = (args) => new Promise((resolve) => {
  execFile("docker", args, { timeout: 120000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || (err && err.message) || "").trim() }));
});

const safeId = (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(String(id || "")) ? String(id) : null;
const boxName = (id) => `ps-${id}`;

// ── Who is asking ──────────────────────────────────────────────────────────
// Each team member signs in to their OWN Privacy Shield (Supabase) account; the
// app sends that session's access token and we verify it with Supabase. A user
// only ever reaches boxes labelled with their own user id. The team token in
// runner/token is the admin key (sees everything). Viewer windows get a signed
// 24h pass cookie (ps_v) so assets/websockets don't carry the token.
const SUPABASE_URL = process.env.PS_SUPABASE_URL || "https://pnhzsteoouhngjdgsfeh.supabase.co";
const SUPABASE_KEY = process.env.PS_SUPABASE_KEY || "sb_publishable_8xJbMF4kr6yTALY-XJua-Q_XFT0iKe2"; // public client key
const jwtCache = new Map(); // access token -> { uid, until }

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function userFromJwt(t) {
  if (!t || t.split(".").length !== 3) return null;
  const c = jwtCache.get(t);
  if (c && c.until > Date.now()) return c.uid;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!/^[a-f0-9-]{36}$/.test(String(j.id || ""))) return null;
    if (jwtCache.size > 5000) jwtCache.clear();
    jwtCache.set(t, { uid: j.id, until: Date.now() + 60000 });
    return j.id;
  } catch (_) { return null; }
}

const signPass = (who, ms) => {
  const body = `${who}.${Date.now() + ms}`;
  return `${body}.${crypto.createHmac("sha256", TOKEN).update(body).digest("base64url")}`;
};
const readPass = (p) => {
  const m = /^([a-zA-Z0-9-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(p || "");
  if (!m || Number(m[2]) < Date.now()) return null;
  return same(crypto.createHmac("sha256", TOKEN).update(`${m[1]}.${m[2]}`).digest("base64url"), m[3]) ? m[1] : null;
};

// → "admin", a Supabase user id, or null.
async function identify(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) { const t = h.slice(7); return same(t, TOKEN) ? "admin" : userFromJwt(t); }
  const pass = /(?:^|;\s*)ps_v=([^;]+)/.exec(req.headers.cookie || "");
  if (pass) return readPass(decodeURIComponent(pass[1]));
  const legacy = /(?:^|;\s*)ps_t=([^;]+)/.exec(req.headers.cookie || "");
  return legacy && same(decodeURIComponent(legacy[1]), TOKEN) ? "admin" : null;
}

// Owner label of a box: null = no such box, "" = created before accounts.
async function boxOwner(id) {
  const r = await docker(["inspect", "-f", "{{index .Config.Labels \"ps.owner\"}}", boxName(id)]);
  return r.ok ? (r.out || "") : null;
}
// Admin → any box. A user → their own boxes, a not-yet-existing one (to start
// it), and unlabelled pre-accounts boxes (ponytail: those predate per-user
// ownership and get the label on their next start).
async function canAccess(who, id) {
  if (!who) return false;
  if (who === "admin") return true;
  const owner = await boxOwner(id);
  return owner === null || owner === "" || owner === who;
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 65536) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > limit) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve(null); } });
  });
}

function validateProxy(p) {
  if (!p || typeof p !== "object") return "A proxy is required — cloud profiles never use the server's own IP.";
  const scheme = String(p.scheme || "").toLowerCase();
  if (!["http", "https", "socks5", "socks4"].includes(scheme)) return "Unsupported proxy scheme.";
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(String(p.host || ""))) return "Invalid proxy host.";
  const port = Number(p.port);
  if (!(port >= 1 && port <= 65535)) return "Invalid proxy port.";
  if ((p.username || p.password) && scheme.startsWith("socks")) return "Authenticated SOCKS proxies aren't supported in cloud yet — use HTTP/HTTPS.";
  return "";
}

async function start(body, who) {
  const id = safeId(body.profileId);
  if (!id) return { code: 400, body: { ok: false, error: "Invalid profileId" } };
  // mode "pc": the box's only internet exit is a tunnel to the owner's PC (its
  // VPN). No tunnel → no internet, box paused. Never the server's own IP.
  const mode = body.mode === "pc" ? "pc" : "proxy";
  const proxyErr = mode === "pc" ? "" : validateProxy(body.proxy);
  if (proxyErr) return { code: 400, body: { ok: false, error: proxyErr } };
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const bad = args.find((a) => !ALLOWED_ARG.test(a));
  if (bad) return { code: 400, body: { ok: false, error: `Flag not allowed: ${bad.slice(0, 60)}` } };
  const w = Math.max(800, Math.min(3840, Number(body.width) || 1920));
  const h = Math.max(600, Math.min(2160, Number(body.height) || 1080));
  const url = /^https?:\/\/[^\s]{1,2000}$/.test(String(body.url || "")) ? String(body.url) : "";

  const running = await docker(["inspect", "-f", "{{.State.Running}}", boxName(id)]);
  if (running.ok && running.out === "true") {
    await restoreRelay(id);
    return { code: 200, body: { ok: true, profileId: id, already: true } };
  }
  closeRelay(id);
  await docker(["rm", "-f", boxName(id)]);

  // Own folder + own network per profile: boxes can't see each other's files or
  // reach each other over the network.
  const stream = body.stream === "vnc" || !PUBLIC_IP ? "vnc" : "rtc";
  const dataDir = path.join(PROFILES_DIR, id);
  fs.mkdirSync(dataDir, { recursive: true });
  // The VNC box runs Chrome as uid 1500, the neko box as uid 1000 — hand the
  // profile's data to whichever this box uses (an existing profile may switch).
  const uid = stream === "rtc" ? "1000" : "1500";
  await new Promise((r) => execFile("chown", ["-R", `${uid}:${uid}`, dataDir], () => r()));
  await docker(["network", "create", "--driver", "bridge", `psnet-${id}`]);

  let proxyJson, labels = [];
  if (mode === "pc") {
    const gw = await networkGateway(id);
    if (!gw) return { code: 500, body: { ok: false, error: "Could not read the box network gateway" } };
    const relay = await openRelay(id, gw, 0);
    proxyJson = JSON.stringify({ scheme: "http", host: gw, port: relay.port });
    labels = ["--label", "ps.mode=pc", "--label", `ps.relay=${gw}:${relay.port}`];
  } else {
    const p = body.proxy;
    proxyJson = JSON.stringify({ scheme: p.scheme, host: p.host, port: Number(p.port), username: p.username || "", password: p.password || "" });
  }
  let streamArgs;
  if (stream === "rtc") {
    const rtcPort = await freeRtcPort();
    if (!rtcPort) return { code: 503, body: { ok: false, error: "No free video ports on this server" } };
    const pw = crypto.randomBytes(12).toString("hex");
    // ponytail: neko's Xorg only has fixed modes — snap to the nearest common one.
    const screen = w >= 1900 ? "1920x1080" : w >= 1500 ? "1600x900" : "1280x720";
    streamArgs = [
      "-p", "127.0.0.1::8080", "-p", `${rtcPort}:${rtcPort}/udp`, "-p", `${rtcPort}:${rtcPort}/tcp`,
      "--shm-size", "1g",
      "--label", "ps.stream=rtc", "--label", `ps.rtcport=${rtcPort}`, "--label", `ps.nekopw=${pw}`,
      "-e", `NEKO_DESKTOP_SCREEN=${screen}@30`,
      "-e", "NEKO_MEMBER_PROVIDER=multiuser",
      "-e", `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${pw}`,
      "-e", `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${crypto.randomBytes(12).toString("hex")}`,
      "-e", "NEKO_SESSION_IMPLICIT_HOSTING=true",
      "-e", `NEKO_WEBRTC_UDPMUX=${rtcPort}`, "-e", `NEKO_WEBRTC_TCPMUX=${rtcPort}`,
      "-e", "NEKO_WEBRTC_ICELITE=true", "-e", `NEKO_WEBRTC_NAT1TO1=${PUBLIC_IP}`,
      RTC_IMAGE
    ];
  } else {
    streamArgs = ["-p", "127.0.0.1::6080", "--shm-size", "512m", "--label", "ps.stream=vnc", IMAGE];
  }
  const run = await docker([
    "run", "-d", "--name", boxName(id), "--network", `psnet-${id}`,
    "-v", `${dataDir}:/data`,
    "--memory", "2560m", "--cpus", "3",
    "--restart", "unless-stopped",
    "--label", "ps.profile=" + id, "--label", `ps.owner=${who || "admin"}`, ...labels,
    "-e", `PS_W=${w}`, "-e", `PS_H=${h}`, "-e", `PS_URL=${url}`,
    "-e", `PS_ARGS=${args.join("\n")}`, "-e", `PS_PROXY=${proxyJson}`,
    ...streamArgs
  ]);
  if (!run.ok) { closeRelay(id); return { code: 500, body: { ok: false, error: "Box failed to start: " + run.err.slice(0, 300) } }; }
  if (mode === "pc") await setPaused(id, true); // frozen until the PC tunnel connects
  return { code: 200, body: { ok: true, profileId: id, mode } };
}

async function stop(body) {
  const id = safeId(body.profileId);
  if (!id) return { code: 400, body: { ok: false, error: "Invalid profileId" } };
  closeRelay(id);
  await docker(["rm", "-f", boxName(id)]);
  await docker(["network", "rm", `psnet-${id}`]);
  return { code: 200, body: { ok: true } };
}

// Logins moved from the PC: drop them in the box's data folder and restart the
// box; its entrypoint loads them before the normal browser start.
async function importCookies(body) {
  const id = safeId(body.profileId);
  if (!id) return { code: 400, body: { ok: false, error: "Invalid profileId" } };
  if (!Array.isArray(body.cookies) || body.cookies.length > 20000) return { code: 400, body: { ok: false, error: "cookies must be an array" } };
  const running = await docker(["inspect", "-f", "{{.State.Status}}", boxName(id)]);
  if (!running.ok) return { code: 404, body: { ok: false, error: "profile is not running in the cloud" } };
  const file = path.join(PROFILES_DIR, id, "ps-import-cookies.json");
  fs.writeFileSync(file, JSON.stringify(body.cookies), { mode: 0o600 });
  fs.chownSync(file, 1500, 1500);
  const wasPaused = running.out === "paused";
  if (wasPaused) await docker(["unpause", boxName(id)]);
  // Boxes created from an older image lack the import step — refresh the startup
  // scripts inside the box (its filesystem survives a restart).
  // ponytail: script-level upgrade only; image-level changes still need stop+start.
  for (const f of ["entrypoint.sh", "import-cookies.js"]) await docker(["cp", path.join(ROOT, "image", f), `${boxName(id)}:/opt/ps/${f}`]);
  await docker(["restart", "-t", "5", boxName(id)]);
  const relay = relays.get(id);
  if (relay) relay.paused = false; // the pause loop re-freezes it if the PC tunnel is still down
  return { code: 200, body: { ok: true, imported: body.cookies.length } };
}

async function list(who) {
  const r = await docker(["ps", "--filter", "label=ps.profile", "--format", "{{.Label \"ps.profile\"}}\t{{.Status}}\t{{.Label \"ps.mode\"}}\t{{.Label \"ps.owner\"}}"]);
  const boxes = r.out ? r.out.split("\n").map((l) => {
    const [profileId, status, mode, owner] = l.split("\t");
    const relay = relays.get(profileId);
    return { profileId, owner: owner || "", status, mode: mode || "proxy", paused: /Paused/.test(status), tunnels: relay ? relay.pool.length : 0 };
  }).filter((b) => who === "admin" || b.owner === who) : []; // each user sees only their own boxes
  return { code: 200, body: { ok: true, boxes } };
}

// ── PC tunnel relay (mode "pc") ─────────────────────────────────────────────
// The box's proxy is a relay on its own network's gateway IP (unreachable from
// the internet and from other boxes' networks). Each box connection is spliced
// onto one idle reverse socket the owner's PC opened via /tunnel/<id>; the PC
// then acts as the HTTP proxy and dials out over its own network (VPN). No idle
// socket → the box connection is dropped (fail-closed) and, after a grace
// period, the box is frozen with `docker pause` until the PC is back.
const relays = new Map(); // id -> { server, gw, port, pool: [], active, paused, lastTunnelAt }

async function networkGateway(id) {
  const r = await docker(["network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", `psnet-${id}`]);
  return /^\d+\.\d+\.\d+\.\d+$/.test(r.out) ? r.out : "";
}

function openRelay(id, gw, port) {
  return new Promise((resolve, reject) => {
    const relay = { gw, port, pool: [], waiters: [], active: 0, paused: false, lastTunnelAt: Date.now() };
    relay.server = net.createServer((boxSock) => {
      // Splice onto an idle PC tunnel; if none is ready, queue and get the next one
      // the moment the PC opens it (no polling). 5s without one → no internet.
      const splice = (up) => {
        up._psActive = true;
        relay.active++;
        boxSock.pipe(up); up.pipe(boxSock);
        const done = () => { boxSock.destroy(); up.destroy(); };
        boxSock.on("close", done); up.on("close", done);
        boxSock.on("error", done); up.on("error", done);
        boxSock.once("close", () => { relay.active = Math.max(0, relay.active - 1); });
      };
      let up;
      while ((up = relay.pool.shift()) && (up.destroyed || up.readableEnded)) {}
      if (up) return splice(up);
      const waiter = { give: (sock) => { clearTimeout(waiter.timer); splice(sock); } };
      waiter.timer = setTimeout(() => { relay.waiters.splice(relay.waiters.indexOf(waiter), 1); boxSock.destroy(); }, 5000);
      boxSock.once("close", () => { const i = relay.waiters.indexOf(waiter); if (i >= 0) { clearTimeout(waiter.timer); relay.waiters.splice(i, 1); } });
      relay.waiters.push(waiter);
    });
    relay.server.on("error", reject);
    relay.server.listen(port, gw, () => { relay.port = relay.server.address().port; relays.set(id, relay); resolve(relay); });
  });
}

function closeRelay(id) {
  const relay = relays.get(id);
  if (!relay) return;
  try { relay.server.close(); } catch (_) {}
  for (const s of relay.pool) s.destroy();
  relays.delete(id);
}

async function restoreRelay(id) {
  if (relays.has(id)) return;
  const r = await docker(["inspect", "-f", "{{index .Config.Labels \"ps.relay\"}}", boxName(id)]);
  const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(r.out);
  if (m) await openRelay(id, m[1], Number(m[2])).catch((e) => console.error("relay restore", id, e.message));
}

async function setPaused(id, paused) {
  const relay = relays.get(id);
  if (relay && relay.paused === paused) return;
  await docker([paused ? "pause" : "unpause", boxName(id)]);
  if (relay) relay.paused = paused;
}

function acceptTunnel(id, socket) {
  const relay = relays.get(id);
  if (!relay) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: ps-tunnel\r\nConnection: Upgrade\r\n\r\n");
  socket.setKeepAlive(true, 30000);
  relay.lastTunnelAt = Date.now();
  const waiter = relay.waiters.shift();
  if (waiter) { waiter.give(socket); if (relay.paused) setPaused(id, false); return; }
  relay.pool.push(socket);
  relay.lastTunnelAt = Date.now();
  // Caddy relays the PC's close as a half-close ("end"), so treat end as gone too.
  const drop = () => { const i = relay.pool.indexOf(socket); if (i >= 0) relay.pool.splice(i, 1); };
  socket.on("close", drop); socket.on("error", drop);
  socket.on("end", () => { drop(); if (!socket.destroyed && relay.pool.indexOf(socket) < 0 && !socket._psActive) socket.destroy(); });
  if (relay.paused) setPaused(id, false);
}

// Freeze boxes whose PC tunnel is gone (PC off, app closed, VPN gate failed).
setInterval(() => {
  for (const [id, relay] of relays) {
    if (relay.pool.length) relay.lastTunnelAt = Date.now();
    else if (!relay.active && !relay.paused && Date.now() - relay.lastTunnelAt > 10000) setPaused(id, true);
  }
}, 5000);

// After a runner restart: re-open relays for running PC-mode boxes, frozen until
// their PC reconnects.
(async () => {
  const r = await docker(["ps", "-a", "--filter", "label=ps.mode=pc", "--format", "{{.Label \"ps.profile\"}}"]);
  for (const id of (r.out ? r.out.split("\n") : [])) {
    if (!safeId(id)) continue;
    await restoreRelay(id);
    await setPaused(id, true);
  }
})();

// A box that was just started or restarted (e.g. right after logins are moved
// in) needs a few seconds before noVNC listens. Wait up to 20s for it to accept
// a connection instead of failing the viewer with "viewer unavailable".
async function readyViewerPort(id) {
  for (let i = 0; i < 40; i++) {
    const port = await viewerPort(id);
    // Must be an HTTP answer from noVNC itself: Docker's port forwarder accepts
    // TCP even while the box's websockify isn't listening yet.
    if (port && await new Promise((ok) => {
      const r = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => { res.resume(); ok(res.statusCode < 500); });
      r.on("error", () => ok(false));
      r.on("timeout", () => { r.destroy(); ok(false); });
    })) return port;
    await new Promise((r) => setTimeout(r, 500));
  }
  return 0;
}

// File dropped on the cloud window on the PC → drop it into the box's browser at
// the same spot (neko /api/room/upload/drop drags it in with xdotool), so a
// site's upload area receives it as if dragged from the user's own desktop.
async function nekoToken(id) {
  const { stream, pw } = await boxStream(id);
  if (stream !== "rtc") throw new Error("Drag-and-drop upload needs the new video viewer — ☁ Stop then ☁ Cloud this profile once.");
  const port = await readyViewerPort(id);
  if (!port) throw new Error("profile not running");
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "runner", password: pw }) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error("box login failed");
  return { port, token: j.token };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); reject(new Error("file too large (max 200 MB)")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function dropFile(id, x, y, name, data) {
  const { port, token } = await nekoToken(id);
  const form = new FormData();
  form.append("x", String(Math.max(0, Math.round(x))));
  form.append("y", String(Math.max(0, Math.round(y))));
  form.append("files", new Blob([data]), name);
  const r = await fetch(`http://127.0.0.1:${port}/api/room/upload/drop`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!r.ok) throw new Error(`drop failed (${r.status})`);
}

// "Upload from PC" (picked with the PC's own file dialog) → the box's
// ~/Downloads, where the cloud browser's file picker can then choose it.
async function putFile(id, name, data) {
  const tmp = path.join(require("os").tmpdir(), `ps-put-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  try {
    await docker(["exec", boxName(id), "mkdir", "-p", "/home/neko/Downloads"]);
    const r = await docker(["cp", tmp, `${boxName(id)}:/home/neko/Downloads/${name}`]);
    if (!r.ok) throw new Error("copy into the cloud profile failed: " + r.err.slice(0, 120));
    await docker(["exec", boxName(id), "chown", "-R", "1000:1000", "/home/neko/Downloads"]);
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function freeRtcPort() {
  const r = await docker(["ps", "-a", "--filter", "label=ps.rtcport", "--format", "{{.Label \"ps.rtcport\"}}"]);
  const used = new Set((r.out ? r.out.split("\n") : []).map(Number));
  for (let p = RTC_PORT_MIN; p <= RTC_PORT_MAX; p++) if (!used.has(p)) return p;
  return 0;
}

// Which viewer a box has: neko (rtc, port 8080, auto-login password) or noVNC.
async function boxStream(id) {
  const r = await docker(["inspect", "-f", "{{index .Config.Labels \"ps.stream\"}}|{{index .Config.Labels \"ps.nekopw\"}}", boxName(id)]);
  const [stream, pw] = (r.out || "").split("|");
  return { stream: stream === "rtc" ? "rtc" : "vnc", pw: pw || "" };
}

async function viewerPort(id) {
  const { stream } = await boxStream(id);
  const r = await docker(["port", boxName(id), stream === "rtc" ? "8080/tcp" : "6080/tcp"]);
  const m = /127\.0\.0\.1:(\d+)/.exec(r.out);
  return m ? Number(m[1]) : 0;
}

// /view/<id>/... → that box's noVNC (HTTP + websocket), path prefix stripped.
function viewTarget(url) {
  const m = /^\/view\/([a-zA-Z0-9_-]{1,64})(\/.*)?$/.exec(url.split("?")[0]);
  if (!m) return null;
  const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  return { id: m[1], rest: (m[2] || "/") + q };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    // First viewer load passes ?t=<token>; turn it into an HttpOnly cookie so the
    // noVNC assets + websocket are authorized without the token in every URL.
    const tq = /[?&]t=([^&]+)/.exec(url);
    if (tq && url.startsWith("/view/")) {
      const t = decodeURIComponent(tq[1]);
      const who = same(t, TOKEN) ? "admin" : await userFromJwt(t);
      if (who) {
        const clean = url.replace(/([?&])t=[^&]+&?/, "$1").replace(/[?&]$/, "");
        res.writeHead(302, { "Set-Cookie": `ps_v=${encodeURIComponent(signPass(who, 24 * 3600e3))}; Path=/; HttpOnly; Secure; SameSite=Strict`, Location: clean });
        return res.end();
      }
    }
    const who = await identify(req);
    if (!who) return send(res, 401, { ok: false, error: "unauthorized — sign in to your Privacy Shield account" });
    const forbidden = () => send(res, 403, { ok: false, error: "This cloud profile belongs to another account." });

    if (req.method === "POST" && url === "/api/start") {
      const body = await readJson(req);
      if (!body) return send(res, 400, { ok: false, error: "bad json" });
      if (!(await canAccess(who, safeId(body.profileId)))) return forbidden();
      const r = await start(body, who); return send(res, r.code, r.body);
    }
    if (req.method === "POST" && url === "/api/stop") {
      const body = await readJson(req);
      if (!body) return send(res, 400, { ok: false, error: "bad json" });
      if (!(await canAccess(who, safeId(body.profileId)))) return forbidden();
      const r = await stop(body); return send(res, r.code, r.body);
    }
    if (req.method === "POST" && url === "/api/cookies") {
      const body = await readJson(req, 25 * 1024 * 1024);
      if (!body) return send(res, 400, { ok: false, error: "bad json" });
      if (!(await canAccess(who, safeId(body.profileId)))) return forbidden();
      const r = await importCookies(body); return send(res, r.code, r.body);
    }
    if (req.method === "GET" && url === "/api/list") { const r = await list(who); return send(res, r.code, r.body); }
    if (req.method === "POST" && url.startsWith("/api/put?")) {
      const q = new URL(url, "http://x").searchParams;
      const id = safeId(q.get("profileId"));
      const name = String(q.get("name") || "file").replace(/[\/\\\0]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "file";
      if (!id) return send(res, 400, { ok: false, error: "Invalid profileId" });
      if (!(await canAccess(who, id))) return forbidden();
      try {
        if ((await boxStream(id)).stream !== "rtc") throw new Error("Needs the new video viewer — ☁ Stop then ☁ Cloud this profile once.");
        await putFile(id, name, await readBody(req, 200 * 1024 * 1024));
        return send(res, 200, { ok: true, name });
      } catch (err) { return send(res, 400, { ok: false, error: String(err.message || err) }); }
    }
    if (req.method === "POST" && url.startsWith("/api/drop?")) {
      const q = new URL(url, "http://x").searchParams;
      const id = safeId(q.get("profileId"));
      const name = String(q.get("name") || "file").replace(/[\/\\\0]/g, "_").slice(0, 200) || "file";
      if (!id) return send(res, 400, { ok: false, error: "Invalid profileId" });
      if (!(await canAccess(who, id))) return forbidden();
      try {
        const data = await readBody(req, 200 * 1024 * 1024);
        await dropFile(id, Number(q.get("x")) || 0, Number(q.get("y")) || 0, name, data);
        return send(res, 200, { ok: true });
      } catch (err) { return send(res, 400, { ok: false, error: String(err.message || err) }); }
    }

    const t = viewTarget(url);
    if (t) {
      if (!(await canAccess(who, t.id))) return forbidden();
      // The app always opens /view/<id>/ — send it to the right viewer, logged in.
      // Older apps open the noVNC page directly; a WebRTC box has none.
      if (req.method === "GET" && /^\/vnc\.html/.test(t.rest) && (await boxStream(t.id)).stream === "rtc") {
        res.writeHead(302, { Location: `/view/${t.id}/` });
        return res.end();
      }
      if (req.method === "GET" && /^\/(\?.*)?$/.test(t.rest)) {
        const { stream, pw } = await boxStream(t.id);
        if (stream === "rtc" && !/[?&]usr=/.test(t.rest)) {
          res.writeHead(302, { Location: `/view/${t.id}/?usr=Team&pwd=${encodeURIComponent(pw)}&embed=1` });
          return res.end();
        }
        if (stream === "vnc" && t.rest === "/") {
          res.writeHead(302, { Location: `/view/${t.id}/vnc.html?autoconnect=1&reconnect=1&resize=scale&quality=4&compression=6&path=${encodeURIComponent(`view/${t.id}/websockify`)}` });
          return res.end();
        }
      }
      const port = await readyViewerPort(t.id);
      if (!port) return send(res, 404, { ok: false, error: "profile not running (or still starting) — try again in a moment" });
      const up = http.request({ host: "127.0.0.1", port, path: t.rest, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (ur) => {
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", () => send(res, 502, { ok: false, error: "viewer unavailable" }));
      return req.pipe(up);
    }
    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

// Websocket upgrade for the noVNC stream.
server.on("upgrade", async (req, socket, head) => {
  const tun = /^\/tunnel\/([a-zA-Z0-9_-]{1,64})$/.exec(req.url || "");
  if (tun) {
    if (!(await canAccess(await identify(req), tun[1]))) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
    await restoreRelay(tun[1]);
    if (head && head.length) socket.unshift(head);
    acceptTunnel(tun[1], socket);
    return;
  }
  const t = viewTarget(req.url || "");
  if (!t || !(await canAccess(await identify(req), t.id))) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const port = await readyViewerPort(t.id);
  if (!port) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${t.rest} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${k === "host" ? `127.0.0.1:${port}` : v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`ps-cloud runner on 127.0.0.1:${PORT}`));
