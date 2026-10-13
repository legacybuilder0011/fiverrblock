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
const IMAGE = "ps-runner";
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

function authed(req) {
  const h = req.headers.authorization || "";
  const cookie = /(?:^|;\s*)ps_t=([^;]+)/.exec(req.headers.cookie || "");
  const given = h.startsWith("Bearer ") ? h.slice(7) : cookie ? decodeURIComponent(cookie[1]) : "";
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 65536) req.destroy(); });
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

async function start(body) {
  const id = safeId(body.profileId);
  if (!id) return { code: 400, body: { ok: false, error: "Invalid profileId" } };
  const proxyErr = validateProxy(body.proxy);
  if (proxyErr) return { code: 400, body: { ok: false, error: proxyErr } };
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const bad = args.find((a) => !ALLOWED_ARG.test(a));
  if (bad) return { code: 400, body: { ok: false, error: `Flag not allowed: ${bad.slice(0, 60)}` } };
  const w = Math.max(800, Math.min(3840, Number(body.width) || 1920));
  const h = Math.max(600, Math.min(2160, Number(body.height) || 1080));
  const url = /^https?:\/\/[^\s]{1,2000}$/.test(String(body.url || "")) ? String(body.url) : "";

  const running = await docker(["inspect", "-f", "{{.State.Running}}", boxName(id)]);
  if (running.ok && running.out === "true") return { code: 200, body: { ok: true, profileId: id, already: true } };
  await docker(["rm", "-f", boxName(id)]);

  // Own folder + own network per profile: boxes can't see each other's files or
  // reach each other over the network.
  const dataDir = path.join(PROFILES_DIR, id);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.chownSync(dataDir, 1500, 1500);
  await docker(["network", "create", "--driver", "bridge", `psnet-${id}`]);

  const p = body.proxy;
  const proxyJson = JSON.stringify({ scheme: p.scheme, host: p.host, port: Number(p.port), username: p.username || "", password: p.password || "" });
  const run = await docker([
    "run", "-d", "--name", boxName(id), "--network", `psnet-${id}`,
    "-p", "127.0.0.1::6080",
    "-v", `${dataDir}:/data`,
    "--memory", "1536m", "--cpus", "1.5", "--shm-size", "512m",
    "--restart", "unless-stopped",
    "--label", "ps.profile=" + id,
    "-e", `PS_W=${w}`, "-e", `PS_H=${h}`, "-e", `PS_URL=${url}`,
    "-e", `PS_ARGS=${args.join("\n")}`, "-e", `PS_PROXY=${proxyJson}`,
    IMAGE
  ]);
  if (!run.ok) return { code: 500, body: { ok: false, error: "Box failed to start: " + run.err.slice(0, 300) } };
  return { code: 200, body: { ok: true, profileId: id } };
}

async function stop(body) {
  const id = safeId(body.profileId);
  if (!id) return { code: 400, body: { ok: false, error: "Invalid profileId" } };
  await docker(["rm", "-f", boxName(id)]);
  await docker(["network", "rm", `psnet-${id}`]);
  return { code: 200, body: { ok: true } };
}

async function list() {
  const r = await docker(["ps", "--filter", "label=ps.profile", "--format", "{{.Label \"ps.profile\"}}\t{{.Status}}"]);
  const boxes = r.out ? r.out.split("\n").map((l) => { const [profileId, status] = l.split("\t"); return { profileId, status }; }) : [];
  return { code: 200, body: { ok: true, boxes } };
}

async function viewerPort(id) {
  const r = await docker(["port", boxName(id), "6080/tcp"]);
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
      if (t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))) {
        const clean = url.replace(/([?&])t=[^&]+&?/, "$1").replace(/[?&]$/, "");
        res.writeHead(302, { "Set-Cookie": `ps_t=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict`, Location: clean });
        return res.end();
      }
    }
    if (!authed(req)) return send(res, 401, { ok: false, error: "unauthorized" });

    if (req.method === "POST" && url === "/api/start") {
      const body = await readJson(req);
      if (!body) return send(res, 400, { ok: false, error: "bad json" });
      const r = await start(body); return send(res, r.code, r.body);
    }
    if (req.method === "POST" && url === "/api/stop") {
      const body = await readJson(req);
      if (!body) return send(res, 400, { ok: false, error: "bad json" });
      const r = await stop(body); return send(res, r.code, r.body);
    }
    if (req.method === "GET" && url === "/api/list") { const r = await list(); return send(res, r.code, r.body); }

    const t = viewTarget(url);
    if (t) {
      const port = await viewerPort(t.id);
      if (!port) return send(res, 404, { ok: false, error: "profile not running" });
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
  const t = viewTarget(req.url || "");
  if (!t || !authed(req)) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const port = await viewerPort(t.id);
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
