# One sealed box per cloud profile: Patched Chromium on a virtual screen, viewed
# through noVNC. Build context = /opt/ps-cloud on the server (see deploy.sh).
FROM node:22-bookworm-slim

# Chromium runtime libs + virtual display + VNC/noVNC. NO Linux font packages:
# only the Windows fonts below may exist, or "Windows" profiles leak DejaVu etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fontconfig ca-certificates openbox \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 \
      libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
      libcups2 libpango-1.0-0 libcairo2 libatspi2.0-0 libdbus-1-3 \
    && apt-get purge -y fonts-dejavu-core fonts-liberation 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/* /usr/share/fonts/truetype/dejavu

COPY chromium /opt/chromium
COPY winfonts /usr/share/fonts/windows
COPY image/vendor/chromium-web-store /opt/cws
COPY image/local-proxy-bridge.js image/start-bridge.js image/entrypoint.sh image/openbox-rc.xml image/import-cookies.js /opt/ps/
# Windows-like font resolution: drop Linux alias rules (Liberation/DejaVu
# substitution answers "installed" for fonts Windows would not have).
COPY image/fonts.conf /etc/fonts/fonts.conf
RUN rm -rf /etc/fonts/conf.d/*
RUN fc-cache -f >/dev/null && chmod +x /opt/ps/entrypoint.sh \
    && useradd -m -u 1500 ps && mkdir -p /data && chown ps:ps /data

USER ps
EXPOSE 6080
ENTRYPOINT ["/opt/ps/entrypoint.sh"]
