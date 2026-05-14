"use strict";

const crypto = require("crypto");
const http = require("http");
const { Client } = require("ssh2");
const proxyServerPayload = require("./vps-proxy-payload");

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SOCKS_PORT = 1080;
const DEFAULT_HTTP_PORT = 1081;
const DEFAULT_INFO_PORT = 8888;

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function envLine(key, value) {
  return `${key}=${shellQuote(value)}\n`;
}

function normalizeCountry(country) {
  return String(country || "").trim().toLowerCase().slice(0, 2);
}

function normalizePort(value, fallback) {
  const n = Number(value || fallback);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function normalizeVpsInput(input = {}) {
  const host = String(input.host || input.sshHost || "").trim();
  const username = String(input.username || input.sshUser || "root").trim();
  const country = normalizeCountry(input.country);
  if (!host) throw new Error("VPS host/IP is required");
  if (!country) throw new Error("Country is required");
  if (!username) throw new Error("SSH username is required");

  return {
    id: input.id || "",
    label: String(input.label || `${country.toUpperCase()} VPS Proxy`).trim(),
    country,
    ssh: {
      host,
      port: normalizePort(input.port || input.sshPort, DEFAULT_SSH_PORT),
      username,
      password: String(input.password || input.sshPassword || ""),
      privateKey: String(input.privateKey || input.sshPrivateKey || "")
    },
    proxy: {
      scheme: "socks5",
      host: String(input.proxyHost || host).trim(),
      port: normalizePort(input.proxyPort, DEFAULT_SOCKS_PORT),
      httpPort: normalizePort(input.httpPort, DEFAULT_HTTP_PORT),
      infoPort: normalizePort(input.infoPort, DEFAULT_INFO_PORT),
      username: String(input.proxyUsername || `ps_${crypto.randomBytes(4).toString("hex")}`),
      password: String(input.proxyPassword || randomToken(18)),
      bypassList: ["localhost", "127.0.0.1"]
    }
  };
}

function connectSsh(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      try { conn.end(); } catch (_) {}
      reject(new Error("SSH connection timed out"));
    }, 20000);

    conn.once("ready", () => {
      clearTimeout(timeout);
      resolve(conn);
    });
    conn.once("error", (err) => {
      clearTimeout(timeout);
      reject(new Error("SSH failed: " + (err.message || err)));
    });

    const options = {
      host: config.ssh.host,
      port: config.ssh.port,
      username: config.ssh.username,
      readyTimeout: 20000,
      keepaliveInterval: 10000
    };
    if (config.ssh.privateKey) options.privateKey = config.ssh.privateKey;
    if (config.ssh.password) options.password = config.ssh.password;
    conn.connect(options);
  });
}

function exec(conn, command, options = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: Boolean(options.pty) }, (err, stream) => {
      if (err) { reject(err); return; }
      let stdout = "";
      let stderr = "";
      let closed = false;
      const done = (code) => {
        if (closed) return;
        closed = true;
        if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr });
        else reject(new Error((stderr || stdout || `Command failed with exit ${code}`).trim()));
      };
      stream.on("close", done);
      stream.on("data", (d) => { stdout += d.toString(); });
      stream.stderr.on("data", (d) => { stderr += d.toString(); });
      if (options.stdin) stream.write(options.stdin);
      stream.end();
    });
  });
}

function rootExec(conn, config, command) {
  if (config.ssh.username === "root") return exec(conn, `sh -lc ${shellQuote(command)}`);
  if (config.ssh.password) {
    return exec(conn, `sudo -S -p '' sh -lc ${shellQuote(command)}`, {
      pty: true,
      stdin: config.ssh.password + "\n"
    });
  }
  return exec(conn, `sudo -n sh -lc ${shellQuote(command)}`);
}

function sftpWrite(conn, remotePath, content, mode = 0o600) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) { reject(err); return; }
      sftp.writeFile(remotePath, content, { mode }, (writeErr) => {
        try { sftp.end(); } catch (_) {}
        if (writeErr) reject(writeErr);
        else resolve();
      });
    });
  });
}

function buildEnv(config) {
  let out = "";
  out += envLine("PORT", String(config.proxy.port));
  out += envLine("HTTP_PORT", String(config.proxy.httpPort));
  out += envLine("INFO_PORT", String(config.proxy.infoPort));
  out += envLine("PROXY_USER", config.proxy.username);
  out += envLine("PROXY_PASS", config.proxy.password);
  out += envLine("COUNTRY", config.country);
  out += envLine("MAX_CONNS", "500");
  out += envLine("TIMEOUT", "30000");
  return out;
}

function buildSystemdService() {
  return `[Unit]
Description=Privacy Shield Proxy Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
ExecStart=/usr/bin/env node /opt/privacy-proxy/server.js
EnvironmentFile=/etc/privacy-proxy/.env
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=privacy-proxy
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
}

async function testSsh(input) {
  const config = normalizeVpsInput(input);
  const conn = await connectSsh(config);
  try {
    const result = await exec(conn, "uname -a && command -v node || true");
    return { ok: true, stdout: result.stdout.trim() };
  } finally {
    conn.end();
  }
}

async function installProxy(input) {
  const config = normalizeVpsInput(input);
  const conn = await connectSsh(config);
  try {
    await exec(conn, "mkdir -p /tmp/privacy-shield-proxy");
    await sftpWrite(conn, "/tmp/privacy-shield-proxy/server.js", proxyServerPayload, 0o755);
    await sftpWrite(conn, "/tmp/privacy-shield-proxy/.env", buildEnv(config), 0o600);
    await sftpWrite(conn, "/tmp/privacy-shield-proxy/privacy-proxy.service", buildSystemdService(), 0o644);

    const installCommand = `
set -e
if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs
  else
    echo "Node.js is not installed and no supported package manager was found" >&2
    exit 42
  fi
fi
mkdir -p /opt/privacy-proxy /etc/privacy-proxy
install -m 755 /tmp/privacy-shield-proxy/server.js /opt/privacy-proxy/server.js
install -m 600 /tmp/privacy-shield-proxy/.env /etc/privacy-proxy/.env
install -m 644 /tmp/privacy-shield-proxy/privacy-proxy.service /etc/systemd/system/privacy-proxy.service
systemctl daemon-reload
systemctl enable privacy-proxy
systemctl restart privacy-proxy
if command -v ufw >/dev/null 2>&1; then
  ufw allow ${config.proxy.port}/tcp >/dev/null 2>&1 || true
  ufw allow ${config.proxy.httpPort}/tcp >/dev/null 2>&1 || true
  ufw allow ${config.proxy.infoPort}/tcp >/dev/null 2>&1 || true
fi
systemctl is-active --quiet privacy-proxy
`;
    await rootExec(conn, config, installCommand);

    return {
      ok: true,
      record: {
        id: config.id || "",
        label: config.label,
        country: config.country,
        ssh: config.ssh,
        proxy: config.proxy,
        status: "installed",
        installedAt: Date.now()
      }
    };
  } finally {
    conn.end();
  }
}

function fetchInfo(host, infoPort) {
  return new Promise((resolve) => {
    const req = http.get({
      host,
      port: infoPort,
      path: "/",
      timeout: 7000
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ ok: true, info: JSON.parse(body) });
        } catch (_) {
          resolve({ ok: false, error: "Bad info response" });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message || String(err) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Info endpoint timed out" });
    });
  });
}

module.exports = {
  normalizeVpsInput,
  testSsh,
  installProxy,
  fetchInfo
};
