#!/bin/bash
# Starts our Patched Chromium inside the neko box (supervisord restarts it if it
# exits). Env from the runner: PS_ARGS (fingerprint/locale flags, one per line),
# PS_PROXY (JSON, REQUIRED — never the server's own IP), PS_URL (first page).
set -u
export HOME=/home/neko

# A restarted box keeps stale Chrome locks (PIDs repeat in a fresh container).
rm -f /data/SingletonLock /data/SingletonSocket /data/SingletonCookie /data/DevToolsActivePort

pjson() { node -e "const p=JSON.parse(process.env.PS_PROXY||'{}');process.stdout.write(String($1))"; }
scheme=$(pjson "(p.scheme||'').toLowerCase()"); phost=$(pjson "p.host||''"); pport=$(pjson "p.port||''"); pauth=$(pjson "p.username||p.password?'1':''")
if [ -z "$phost" ] || [ -z "$pport" ]; then echo "no proxy — refusing to start"; sleep 30; exit 1; fi

proxy_args=()
if [ -n "$pauth" ] && { [ "$scheme" = "http" ] || [ "$scheme" = "https" ]; }; then
  # One bridge for the box's lifetime; reuse it across browser restarts.
  if [ ! -s /tmp/bridge.port ] || ! kill -0 "$(cat /tmp/bridge.pid 2>/dev/null)" 2>/dev/null; then
    rm -f /tmp/bridge.port
    node /opt/ps/start-bridge.js > /tmp/bridge.port & echo $! > /tmp/bridge.pid
    for i in $(seq 1 50); do [ -s /tmp/bridge.port ] && break; sleep 0.1; done
  fi
  bport=$(cat /tmp/bridge.port)
  [ -n "$bport" ] || { echo "proxy bridge failed"; sleep 10; exit 1; }
  proxy_args+=("--proxy-server=http://127.0.0.1:$bport" "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1")
else
  proxy_args+=("--proxy-server=$scheme://$phost:$pport" "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE $phost")
fi

mapfile -t fp_args < <(printf '%s\n' "${PS_ARGS:-}" | sed '/^$/d')

# Logins moved from the PC: load once via a box-loopback-only DevTools port.
if [ -s /data/ps-import-cookies.json ]; then
  /opt/chromium/chrome --user-data-dir=/data --no-first-run --no-sandbox --headless=new \
    --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 "${proxy_args[@]}" "${fp_args[@]}" about:blank >/dev/null 2>&1 &
  cpid=$!
  timeout 60 node /opt/ps/import-cookies.js
  kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null
  rm -f /data/ps-import-cookies.json /data/DevToolsActivePort /data/SingletonLock /data/SingletonSocket /data/SingletonCookie
fi

# Hard restarts mark the profile as crashed; avoid the "Restore pages?" nag.
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /data/Default/Preferences 2>/dev/null

exec /opt/chromium/chrome \
  --user-data-dir=/data --no-first-run --no-default-browser-check --no-sandbox \
  --window-position=0,0 --start-maximized --disable-dev-shm-usage \
  --use-angle=swiftshader --enable-unsafe-swiftshader \
  --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --load-extension=/opt/cws --extension-mime-request-handling=always-prompt-for-install \
  "${proxy_args[@]}" "${fp_args[@]}" ${PS_URL:+"$PS_URL"}
