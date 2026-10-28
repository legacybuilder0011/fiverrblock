#!/bin/bash
# Box entrypoint. Env (set by the runner):
#   PS_W, PS_H   screen size          PS_URL    first page (optional)
#   PS_ARGS      fingerprint/locale Chromium flags, one per line
#   PS_PROXY     JSON {scheme,host,port,username,password} — REQUIRED (cloud
#                profiles must never browse on the server's own IP)
set -u
W="${PS_W:-1920}"; H="${PS_H:-1080}"
export DISPLAY=:1

# A restarted box keeps its old /tmp and profile locks: a stale X lock stops Xvfb
# ("display already active"), a stale SingletonLock makes Chrome think the profile
# is open elsewhere (PIDs repeat in a fresh container), and a stale bridge.port
# would point Chrome at a dead proxy port. Nothing else runs here, so clear them.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 /tmp/bridge.port /data/SingletonLock /data/SingletonSocket /data/SingletonCookie /data/DevToolsActivePort

proxy_args=()
scheme=$(node -e 'const p=JSON.parse(process.env.PS_PROXY||"{}");process.stdout.write(String(p.scheme||"").toLowerCase())')
phost=$(node -e 'const p=JSON.parse(process.env.PS_PROXY||"{}");process.stdout.write(String(p.host||""))')
pport=$(node -e 'const p=JSON.parse(process.env.PS_PROXY||"{}");process.stdout.write(String(p.port||""))')
pauth=$(node -e 'const p=JSON.parse(process.env.PS_PROXY||"{}");process.stdout.write(p.username||p.password?"1":"")')
if [ -z "$phost" ] || [ -z "$pport" ]; then echo "no proxy — refusing to start"; exit 1; fi
if [ -n "$pauth" ] && { [ "$scheme" = "http" ] || [ "$scheme" = "https" ]; }; then
  node /opt/ps/start-bridge.js > /tmp/bridge.port &
  for i in $(seq 1 50); do [ -s /tmp/bridge.port ] && break; sleep 0.1; done
  bport=$(cat /tmp/bridge.port)
  [ -n "$bport" ] || { echo "proxy bridge failed"; exit 1; }
  proxy_args+=("--proxy-server=http://127.0.0.1:$bport" "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1")
else
  proxy_args+=("--proxy-server=$scheme://$phost:$pport" "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE $phost")
fi

Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
# Openbox reserves a 40px bottom strip so screen.availHeight = height - 40 like a
# Windows taskbar (no WM = availHeight == height, a server tell).
openbox --config-file /opt/ps/openbox-rc.xml >/dev/null 2>&1 &
sleep 1
# VNC only on the box's loopback; noVNC on 6080 is the only exposed port and the
# runner binds it to the host's loopback behind token auth.
x11vnc -display :1 -localhost -forever -shared -nopw -quiet -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

mapfile -t fp_args < <(printf '%s\n' "${PS_ARGS:-}" | sed '/^$/d')
seed=$(printf '%s\n' "${PS_ARGS:-}" | sed -n 's/^--fingerprint=\([0-9][0-9]*\).*/\1/p' | head -1)
if node /opt/ps/cloud-fonts.js "${seed:-1}" > /tmp/ps-fonts.conf; then
  export FONTCONFIG_FILE=/tmp/ps-fonts.conf
fi
case "${PS_ARGS:-}" in
  *"--disable-spoofing=font"*) ;;
  *) fp_args+=("--disable-spoofing=font") ;;
esac
# Block location and lock WebRTC in the profile, matching the local browser.
node /opt/ps/cloud-privacy.js /data || true

# Logins moved from the PC: load them once with a box-loopback-only DevTools port,
# then delete the file. The normal browser below never has a debug port.
if [ -s /data/ps-import-cookies.json ]; then
  rm -f /data/DevToolsActivePort
  /opt/chromium/chrome --user-data-dir=/data --no-first-run --no-sandbox --headless=new \
    --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 "${proxy_args[@]}" "${fp_args[@]}" about:blank >/dev/null 2>&1 &
  cpid=$!
  timeout 60 node /opt/ps/import-cookies.js
  kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null
  rm -f /data/ps-import-cookies.json /data/DevToolsActivePort
fi

# Keep the browser up 24/7: relaunch if it exits or crashes.
while true; do
  # A box restart kills Chrome hard; mark the last exit clean so it doesn't nag
  # with "Restore pages?" (tabs still come back via session restore).
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /data/Default/Preferences 2>/dev/null
  /opt/chromium/chrome \
    --user-data-dir=/data --no-first-run --no-default-browser-check --no-sandbox \
    --window-position=0,0 "--window-size=$W,$H" --start-maximized \
    --use-angle=swiftshader --enable-unsafe-swiftshader \
    --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
    --load-extension=/opt/cws --extension-mime-request-handling=always-prompt-for-install \
    "${proxy_args[@]}" "${fp_args[@]}" ${PS_URL:+"$PS_URL"}
  sleep 3
done
