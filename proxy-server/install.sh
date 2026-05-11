#!/usr/bin/env bash
# =============================================================================
# Privacy Shield Proxy — One-command VPS installer
# Tested on: Ubuntu 20.04, 22.04, 24.04 / Debian 11, 12
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/YOUR_REPO/main/proxy-server/install.sh | bash
#
# Or upload install.sh to the server and run:
#   chmod +x install.sh && sudo ./install.sh
#
# After install, edit /etc/privacy-proxy/.env then:
#   sudo systemctl restart privacy-proxy
# =============================================================================

set -euo pipefail

INSTALL_DIR="/opt/privacy-proxy"
ENV_FILE="/etc/privacy-proxy/.env"
SERVICE_NAME="privacy-proxy"
NODE_VERSION="20"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo ./install.sh"

info "=== Privacy Shield Proxy Installer ==="

# ── 1. Install Node.js ────────────────────────────────────────────────────────
info "Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null; then
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    dnf install -y nodejs
  elif command -v yum &>/dev/null; then
    yum install -y nodejs
  else
    error "Unsupported package manager. Install Node.js manually from https://nodejs.org"
  fi
else
  info "Node.js already installed: $(node --version)"
fi

# ── 2. Install server files ───────────────────────────────────────────────────
info "Installing proxy server to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"

# Write server.js
cat > "${INSTALL_DIR}/server.js" << 'SERVERJS'
#!/usr/bin/env node
"use strict";
// Load .env
const fs = require("fs");
const envPath = "/etc/privacy-proxy/.env";
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    const eq = l.indexOf("=");
    if (eq < 1) return;
    const k = l.slice(0, eq).trim();
    const v = l.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  });
}

const net = require("net");
const http = require("http");
const dns = require("dns").promises;
const os = require("os");

const SOCKS_PORT   = parseInt(process.env.PORT      || "1080", 10);
const HTTP_PORT    = parseInt(process.env.HTTP_PORT || "8080", 10);
const INFO_PORT    = parseInt(process.env.INFO_PORT || "8888", 10);
const USERNAME     = process.env.PROXY_USER || "";
const PASSWORD     = process.env.PROXY_PASS || "";
const COUNTRY      = process.env.COUNTRY    || "";
const MAX_CONNS    = parseInt(process.env.MAX_CONNS || "500", 10);
const CONN_TIMEOUT = parseInt(process.env.TIMEOUT   || "30000", 10);
const USE_AUTH     = USERNAME.length > 0 && PASSWORD.length > 0;

const S5_VER=0x05,AUTH_NONE=0x00,AUTH_USERPASS=0x02,AUTH_NOACCEPT=0xFF;
const CMD_CONNECT=0x01,ATYP_IPV4=0x01,ATYP_DOMAIN=0x03,ATYP_IPV6=0x04;
const REP={OK:0,FAIL:1,FORBIDDEN:2,NET_UNREACH:3,HOST_UNREACH:4,REFUSED:5,TTL_EXPIRED:6,CMD_UNSUPPORTED:7,ATYP_UNSUPPORTED:8};

const stats={connections:0,active:0,bytes:0,startTime:Date.now()};

function log(lvl,...a){console[lvl==="error"?"error":"log"](`[${new Date().toISOString()}] [${lvl.toUpperCase()}]`,...a);}

function s5Reply(s,rep,atyp=ATYP_IPV4,addr=Buffer.alloc(4),port=0){
  const p=Buffer.alloc(2);p.writeUInt16BE(port);
  try{if(!s.destroyed)s.write(Buffer.concat([Buffer.from([S5_VER,rep,0,atyp]),addr,p]));}catch(_){}
}

function readData(s){
  return new Promise((res,rej)=>{
    s.once("data",res);s.once("error",rej);s.once("close",()=>rej(new Error("closed")));
  });
}

function relay(a,b){
  a.pipe(b,{end:false});b.pipe(a,{end:false});
  const clean=()=>{try{a.destroy();}catch(_){}try{b.destroy();}catch(_){}};
  a.once("close",clean);b.once("close",clean);a.once("error",clean);b.once("error",clean);
  a.on("data",(d)=>{stats.bytes+=d.length;});b.on("data",(d)=>{stats.bytes+=d.length;});
}

async function handleSocks5(socket){
  socket.setTimeout(CONN_TIMEOUT);
  socket.on("timeout",()=>socket.destroy());
  socket.on("error",()=>{});
  try{
    const gr=await readData(socket);
    if(gr[0]!==S5_VER){socket.destroy();return;}
    const methods=Array.from(gr.slice(2,2+gr[1]));
    if(USE_AUTH){
      if(!methods.includes(AUTH_USERPASS)){socket.write(Buffer.from([S5_VER,AUTH_NOACCEPT]));socket.destroy();return;}
      socket.write(Buffer.from([S5_VER,AUTH_USERPASS]));
      const ap=await readData(socket);
      const uLen=ap[1];const user=ap.slice(2,2+uLen).toString();
      const pLen=ap[2+uLen];const pass=ap.slice(3+uLen,3+uLen+pLen).toString();
      if(user!==USERNAME||pass!==PASSWORD){socket.write(Buffer.from([1,1]));socket.destroy();log("warn","Auth failed",socket.remoteAddress);return;}
      socket.write(Buffer.from([1,0]));
    }else{socket.write(Buffer.from([S5_VER,AUTH_NONE]));}

    const req=await readData(socket);
    if(req[0]!==S5_VER){socket.destroy();return;}
    const cmd=req[1],atyp=req[3];
    if(cmd!==CMD_CONNECT){s5Reply(socket,REP.CMD_UNSUPPORTED);socket.destroy();return;}

    let host,port,addrBuf;
    if(atyp===ATYP_IPV4){addrBuf=req.slice(4,8);host=addrBuf.join(".");port=req.readUInt16BE(8);}
    else if(atyp===ATYP_DOMAIN){
      const len=req[4];host=req.slice(5,5+len).toString();port=req.readUInt16BE(5+len);
      try{const r=await dns.resolve4(host);addrBuf=Buffer.from(r[0].split(".").map(Number));}catch(_){addrBuf=Buffer.alloc(4);}
    }else if(atyp===ATYP_IPV6){
      addrBuf=req.slice(4,20);const pts=[];for(let i=0;i<16;i+=2)pts.push(addrBuf.readUInt16BE(i).toString(16));
      host=pts.join(":");port=req.readUInt16BE(20);
    }else{s5Reply(socket,REP.ATYP_UNSUPPORTED);socket.destroy();return;}

    const target=net.createConnection({host,port,allowHalfOpen:false});
    target.once("connect",()=>{
      s5Reply(socket,REP.OK,ATYP_IPV4,addrBuf,port);
      socket.setTimeout(0);target.setTimeout(0);
      relay(socket,target);stats.active++;
      target.once("close",()=>stats.active--);
      log("info",`CONNECT ${host}:${port} from ${socket.remoteAddress}`);
    });
    target.once("error",(err)=>{
      const r=err.code==="ECONNREFUSED"?REP.REFUSED:err.code==="EHOSTUNREACH"?REP.HOST_UNREACH:err.code==="ENETUNREACH"?REP.NET_UNREACH:REP.FAIL;
      s5Reply(socket,r);socket.destroy();
    });
    target.setTimeout(CONN_TIMEOUT,()=>{s5Reply(socket,REP.TTL_EXPIRED);target.destroy();socket.destroy();});
  }catch(_){try{socket.destroy();}catch(__){}}
}

function checkBasicAuth(h){
  try{const[u,...r]=Buffer.from(h.replace(/^Basic\s+/i,""),"base64").toString().split(":");return u===USERNAME&&r.join(":")===PASSWORD;}catch(_){return false;}
}

function handleHttpConnect(req,cs,head){
  cs.on("error",()=>{});
  if(USE_AUTH&&!checkBasicAuth(req.headers["proxy-authorization"]||"")){
    cs.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Proxy\"\r\nContent-Length: 0\r\n\r\n");
    cs.destroy();return;
  }
  const[host,portS]=req.url.split(":");const port=parseInt(portS||"443",10);
  const t=net.createConnection({host,port},()=>{
    cs.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if(head&&head.length)t.write(head);relay(cs,t);
    log("info",`HTTP CONNECT ${host}:${port} from ${cs.remoteAddress}`);
  });
  t.on("error",()=>{try{cs.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");}catch(_){}cs.destroy();});
  t.setTimeout(CONN_TIMEOUT,()=>t.destroy());
}

const socksServer=net.createServer({allowHalfOpen:false},(s)=>{
  if(stats.connections>=MAX_CONNS){s.destroy();return;}
  stats.connections++;s.on("close",()=>stats.connections--);handleSocks5(s);
});
socksServer.listen(SOCKS_PORT,"0.0.0.0",()=>log("info",`SOCKS5 :${SOCKS_PORT} auth=${USE_AUTH} country=${COUNTRY||"?"}`));
socksServer.on("error",(e)=>log("error","SOCKS5:",e.message));

const httpServer=http.createServer((_,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("Privacy Shield Proxy\n");});
httpServer.on("connect",handleHttpConnect);
httpServer.listen(HTTP_PORT,"0.0.0.0",()=>log("info",`HTTP CONNECT :${HTTP_PORT}`));
httpServer.on("error",(e)=>log("error","HTTP:",e.message));

const infoServer=http.createServer((req,res)=>{
  if(req.method!=="GET"){res.writeHead(405).end();return;}
  res.writeHead(200,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
  res.end(JSON.stringify({status:"ok",server:"Privacy Shield Proxy",version:"1.0.0",socks5_port:SOCKS_PORT,http_port:HTTP_PORT,country:COUNTRY,auth:USE_AUTH,connections:stats.connections,active:stats.active,bytes_total:stats.bytes,uptime_sec:Math.floor((Date.now()-stats.startTime)/1000),hostname:os.hostname()},null,2));
});
infoServer.listen(INFO_PORT,"0.0.0.0",()=>log("info",`Info endpoint :${INFO_PORT}`));

process.on("SIGTERM",()=>{socksServer.close();httpServer.close();infoServer.close();process.exit(0);});
process.on("SIGINT",()=>process.emit("SIGTERM"));
log("info","Privacy Shield Proxy Server ready.");
SERVERJS

chmod +x "${INSTALL_DIR}/server.js"

# Write package.json
cat > "${INSTALL_DIR}/package.json" << 'EOF'
{"name":"privacy-shield-proxy","version":"1.0.0","main":"server.js"}
EOF

# ── 3. Create config directory and default .env ───────────────────────────────
info "Creating config at ${ENV_FILE}..."
mkdir -p "$(dirname ${ENV_FILE})"

if [[ ! -f "${ENV_FILE}" ]]; then
  # Generate a random password
  RAND_PASS=$(tr -dc 'A-Za-z0-9!@#$%' < /dev/urandom | head -c 20)

  # Detect public IP
  PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "unknown")

  cat > "${ENV_FILE}" << ENVEOF
# Privacy Shield Proxy Configuration
# Edit this file then: sudo systemctl restart ${SERVICE_NAME}

PORT=1080
HTTP_PORT=8080
INFO_PORT=8888

PROXY_USER=psuser
PROXY_PASS=${RAND_PASS}

# Set this to your server's country code (us, gb, de, nl, ng, etc.)
COUNTRY=

MAX_CONNS=500
TIMEOUT=30000
ENVEOF

  info "Generated random password. Your config:"
  echo ""
  echo "  IP:       ${PUBLIC_IP}"
  echo "  SOCKS5:   ${PUBLIC_IP}:1080"
  echo "  HTTP:     ${PUBLIC_IP}:8080"
  echo "  User:     psuser"
  echo "  Pass:     ${RAND_PASS}"
  echo ""
  warn "SAVE THESE CREDENTIALS! Edit COUNTRY in ${ENV_FILE}"
else
  info "Config already exists at ${ENV_FILE} — not overwriting."
fi

# ── 4. Create systemd service ─────────────────────────────────────────────────
info "Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Privacy Shield Proxy Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
ExecStart=$(which node) ${INSTALL_DIR}/server.js
EnvironmentFile=${ENV_FILE}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# ── 5. Enable and start ───────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# Give it a moment to start
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  info "Service is running!"
else
  warn "Service may not have started. Check: sudo journalctl -u ${SERVICE_NAME} -n 30"
fi

# ── 6. Firewall ───────────────────────────────────────────────────────────────
info "Opening firewall ports (ufw)..."
if command -v ufw &>/dev/null; then
  ufw allow 1080/tcp comment "SOCKS5 proxy"   >/dev/null 2>&1 || true
  ufw allow 8080/tcp comment "HTTP proxy"     >/dev/null 2>&1 || true
  ufw allow 8888/tcp comment "Proxy info API" >/dev/null 2>&1 || true
  info "ufw rules added"
fi

# ── 7. Summary ────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "YOUR_SERVER_IP")

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Privacy Shield Proxy installed successfully!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Server IP  : ${PUBLIC_IP}"
echo "  SOCKS5     : ${PUBLIC_IP}:1080"
echo "  HTTP       : ${PUBLIC_IP}:8080"
echo "  Info API   : http://${PUBLIC_IP}:8888/"
echo ""
echo "  Config file: ${ENV_FILE}"
echo "  Logs       : sudo journalctl -u ${SERVICE_NAME} -f"
echo "  Restart    : sudo systemctl restart ${SERVICE_NAME}"
echo "  Stop       : sudo systemctl stop ${SERVICE_NAME}"
echo ""
echo "  Next steps:"
echo "  1. Edit ${ENV_FILE} and set COUNTRY (e.g. COUNTRY=us)"
echo "  2. sudo systemctl restart ${SERVICE_NAME}"
echo "  3. Add this proxy to your Privacy Shield extension:"
echo "     Host: ${PUBLIC_IP}  Port: 1080  Type: SOCKS5"
echo "════════════════════════════════════════════════════════"
