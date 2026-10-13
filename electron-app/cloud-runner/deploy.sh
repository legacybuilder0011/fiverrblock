#!/bin/bash
# Deploy the cloud runner to a server. Usage (from electron-app/):
#   cloud-runner/deploy.sh root@HOST [ssh-key]
# Expects /opt/ps-cloud/chromium (Linux fingerprint-chromium) and
# /opt/ps-cloud/winfonts already on the server.
set -euo pipefail
HOST="$1"; KEY="${2:-$HOME/.ssh/id_ed25519}"
SSH=(ssh -o BatchMode=yes -i "$KEY" "$HOST")
cd "$(dirname "$0")/.."

"${SSH[@]}" 'mkdir -p /opt/ps-cloud/image/vendor /opt/ps-cloud/runner /opt/ps-cloud/profiles'
scp -q -i "$KEY" cloud-runner/image/Dockerfile cloud-runner/image/entrypoint.sh cloud-runner/image/start-bridge.js \
  src/local-proxy-bridge.js "$HOST:/opt/ps-cloud/image/"
scp -q -r -i "$KEY" vendor/chromium-web-store "$HOST:/opt/ps-cloud/image/vendor/"
scp -q -i "$KEY" cloud-runner/runner/server.js "$HOST:/opt/ps-cloud/runner/"

"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/ps-cloud
printf 'profiles\nnode_modules\nrunner\nprobe.js\npackage*.json\n' > .dockerignore
[ -s runner/token ] || { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > runner/token; chmod 600 runner/token; }
docker build -q -t ps-runner -f image/Dockerfile . >/dev/null

cat > /etc/systemd/system/ps-cloud-runner.service <<'UNIT'
[Unit]
Description=Privacy Shield cloud runner
After=docker.service
Requires=docker.service
[Service]
ExecStart=/usr/bin/node /opt/ps-cloud/runner/server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ps-cloud-runner >/dev/null 2>&1
systemctl restart ps-cloud-runner

cat > /etc/caddy/sites/ps-cloud.caddy <<'SITE'
ps-cloud.2-25-126-125.sslip.io {
    reverse_proxy 127.0.0.1:8320
}
SITE
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy
echo "deployed; runner: $(systemctl is-active ps-cloud-runner)"
REMOTE
