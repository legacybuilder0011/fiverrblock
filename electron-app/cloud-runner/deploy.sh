#!/bin/bash
# Deploy the cloud runner to a server. Usage (from electron-app/):
#   cloud-runner/deploy.sh root@HOST [ssh-key]
# Expects /opt/ps-cloud/chromium (Linux fingerprint-chromium) and
# /opt/ps-cloud/winfonts already on the server. The build runs detached on the
# server (nohup) so a flaky local connection can't kill it; we poll for the end.
set -euo pipefail
HOST="$1"; KEY="${2:-$HOME/.ssh/id_ed25519}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$HOST")
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep 10; done; return 1; }
cd "$(dirname "$0")/.."

retry "${SSH[@]}" 'mkdir -p /opt/ps-cloud/image/vendor /opt/ps-cloud/image-rtc /opt/ps-cloud/runner /opt/ps-cloud/profiles'
retry scp -q -o ConnectTimeout=15 -i "$KEY" cloud-runner/image/Dockerfile cloud-runner/image/entrypoint.sh cloud-runner/image/start-bridge.js \
  cloud-runner/image/fonts.conf cloud-runner/image/openbox-rc.xml cloud-runner/image/import-cookies.js \
  src/local-proxy-bridge.js "$HOST:/opt/ps-cloud/image/"
retry scp -q -o ConnectTimeout=15 -i "$KEY" cloud-runner/image-rtc/Dockerfile cloud-runner/image-rtc/browser.conf cloud-runner/image-rtc/run-browser.sh "$HOST:/opt/ps-cloud/image-rtc/"
retry scp -q -r -o ConnectTimeout=15 -i "$KEY" vendor/chromium-web-store "$HOST:/opt/ps-cloud/image/vendor/"
retry scp -q -o ConnectTimeout=15 -i "$KEY" cloud-runner/runner/server.js "$HOST:/opt/ps-cloud/runner/"

retry "${SSH[@]}" 'cat > /opt/ps-cloud/deploy-remote.sh' <<'REMOTE'
set -euo pipefail
cd /opt/ps-cloud
printf 'profiles\nnode_modules\nrunner\nprobe.js\npackage*.json\n' > .dockerignore
[ -s runner/token ] || { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40 > runner/token; chmod 600 runner/token; }
docker build -q -t ps-runner -f image/Dockerfile . >/dev/null
docker build -q -t ps-runner-rtc -f image-rtc/Dockerfile . >/dev/null
PUBLIC_IP=$(curl -s --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')

cat > /etc/systemd/system/ps-cloud-runner.service <<UNIT
[Unit]
Description=Privacy Shield cloud runner
After=docker.service
Requires=docker.service
[Service]
Environment=PS_PUBLIC_IP=${PUBLIC_IP}
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
echo "DEPLOY-OK runner=$(systemctl is-active ps-cloud-runner) public_ip=${PUBLIC_IP}"
REMOTE

retry "${SSH[@]}" 'cd /opt/ps-cloud && rm -f deploy.log && (nohup bash deploy-remote.sh > deploy.log 2>&1 || echo DEPLOY-FAIL >> deploy.log) >/dev/null 2>&1 &'
for i in $(seq 1 120); do
  r=$("${SSH[@]}" 'tail -1 /opt/ps-cloud/deploy.log 2>/dev/null' 2>/dev/null || true)
  case "$r" in *DEPLOY-OK*|*DEPLOY-FAIL*) echo "$r"; break;; esac
  sleep 15
done
