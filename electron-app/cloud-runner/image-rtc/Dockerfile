# Cloud profile box, WebRTC edition: neko (Apache-2.0, github.com/m1k1o/neko)
# streams the screen + sound as real video instead of VNC still frames. The
# browser inside is still our Patched Chromium with the same fingerprint flags,
# Windows-only fonts, taskbar margin, proxy bridge and login import.
# Build context = /opt/ps-cloud (see deploy.sh).
FROM node:22-bookworm-slim AS node
FROM ghcr.io/m1k1o/neko/base:latest

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig ca-certificates openbox \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 \
      libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
      libcups2 libpango-1.0-0 libcairo2 libatspi2.0-0 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

COPY chromium /opt/chromium
COPY winfonts /usr/share/fonts/windows
COPY image/vendor/chromium-web-store /opt/cws
COPY image/local-proxy-bridge.js image/start-bridge.js image/import-cookies.js image-rtc/run-browser.sh /opt/ps/
# Windows-like font resolution: only the Windows fonts, no Linux alias rules.
COPY image/fonts.conf /etc/fonts/fonts.conf
RUN rm -rf /etc/fonts/conf.d/*
# Our Openbox config: 40px "taskbar" margin (screen.availHeight like Windows).
COPY image/openbox-rc.xml /etc/neko/openbox.xml
COPY image-rtc/browser.conf /etc/neko/supervisord/browser.conf
RUN fc-cache -f >/dev/null && chmod +x /opt/ps/run-browser.sh \
    && mkdir -p /data && chown 1000:1000 /data
