"use strict";

const api = window.electronAPI;
const tabsRow  = document.getElementById("tabs-row");
const newTab   = document.getElementById("new-tab");
const urlInput = document.getElementById("url-input");
const btnBack  = document.getElementById("btn-back");
const btnFwd   = document.getElementById("btn-fwd");
const btnReload = document.getElementById("btn-reload");
const btnHome  = document.getElementById("btn-home");
const btnDownloads = document.getElementById("btn-downloads");
const downloadStatus = document.getElementById("download-status");
const btnExtensions = document.getElementById("btn-extensions");
const extensionsPanel = document.getElementById("extensions-panel");
const btnLoadExtension = document.getElementById("btn-load-extension");
const extensionsList = document.getElementById("extensions-list");
const brandMark = document.getElementById("brand-mark");
const brandText = document.getElementById("brand-text");
const brandChip = document.getElementById("brand-chip");
const deviceChip = document.getElementById("device-chip");
const profilePillText = document.getElementById("profile-pill-text");
const profilePill = document.getElementById("profile-pill");
const phoneNavBack = document.getElementById("phone-nav-back");
const phoneNavHome = document.getElementById("phone-nav-home");
const phoneNavTabs = document.getElementById("phone-nav-tabs");

let tabs = [];        // [{ id, title, url, active }]
let activeTabId = null;
let browserMeta = null;
let suppressUrlSync = false;
let downloadStatusTimer = null;

function render() {
  // Wipe everything except the new-tab button
  Array.from(tabsRow.querySelectorAll(".tab")).forEach((t) => t.remove());

  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeTabId ? " active" : "");
    el.dataset.id = t.id;
    el.title = t.title || t.url || "Loading…";
    el.innerHTML = `
      <span class="tab-title">${escapeHtml(t.title || t.url || "New tab")}</span>
      <span class="tab-close" data-close>&times;</span>
    `;
    el.addEventListener("click", (e) => {
      if (e.target.dataset.close !== undefined) {
        api.invoke("TAB_CLOSE", { tabId: t.id });
      } else {
        api.invoke("TAB_ACTIVATE", { tabId: t.id });
      }
    });
    tabsRow.insertBefore(el, newTab);
  }

  // Sync URL bar to active tab
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && document.activeElement !== urlInput) {
    suppressUrlSync = true;
    urlInput.value = active.url || "";
    suppressUrlSync = false;
  }
  btnBack.disabled = !active || !active.canBack;
  btnFwd.disabled  = !active || !active.canForward;
  if (btnReload) {
    const loading = Boolean(active && active.loading);
    btnReload.classList.toggle("loading", loading);
    btnReload.title = loading ? "Stop loading" : "Reload";
    btnReload.innerHTML = loading ? "&#10005;" : "&#8634;";
  }
  renderMeta();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMeta() {
  if (!profilePillText || !browserMeta) return;
  const browser = browserMeta.browser || "privacy";
  const os = browserMeta.os || "windows";
  const deviceClass = browserMeta.deviceClass || "desktop";
  document.body.className = `browser-${browser} os-${os} device-${deviceClass}`;
  if (urlInput) {
    urlInput.placeholder = deviceClass === "mobile" ? "Search or enter website" : "Enter URL or search...";
  }
  if (brandText) brandText.textContent = browserMeta.browserLabel || browserMeta.appName || "Browser";
  if (brandMark) brandMark.textContent = browserInitials(browser, browserMeta.browserLabel || browserMeta.appName);
  if (brandChip) {
    brandChip.title = [
      `${browserMeta.browserLabel || "Browser"} identity`,
      `Runtime: ${browserMeta.runtimeName || "Privacy Shield Chromium"}`,
      "The selected browser changes the profile identity and browser shell skin."
    ].join("\n");
  }
  const location = [browserMeta.city, browserMeta.countryCode ? browserMeta.countryCode.toUpperCase() : ""].filter(Boolean).join(", ");
  const device = browserMeta.deviceClass === "mobile"
    ? (browserMeta.os === "ios"
        ? (browserMeta.mobileModel || "iPhone")
        : (browserMeta.mobileModel ? `Android ${browserMeta.mobileModel}` : "Android"))
    : (browserMeta.osLabel || browserMeta.os || "desktop");
  if (deviceChip) {
    const screen = browserMeta.screen ? ` ${browserMeta.screen}` : "";
    deviceChip.textContent = `${device}${screen}`;
    deviceChip.title = [
      `OS: ${browserMeta.osLabel || browserMeta.os || ""}`,
      browserMeta.screen ? `Screen: ${browserMeta.screen}` : "",
      browserMeta.dpr ? `DPR: ${browserMeta.dpr}` : ""
    ].filter(Boolean).join("\n");
  }
  const text = `${browserMeta.profileName || "Profile"} - ${device} - ${browserMeta.networkLabel || "Direct"}${location ? " - " + location : ""}`;
  profilePillText.textContent = text;
  if (profilePill) {
    profilePill.title = [
      browserMeta.appName || "Privacy Shield Browser",
      `Profile: ${browserMeta.profileName || ""}`,
      `Device: ${device}`,
      `Network: ${browserMeta.networkLabel || "Direct"}${browserMeta.proxyHost ? " " + browserMeta.proxyHost : ""}`,
      location ? `Location: ${location}` : "",
      browserMeta.timezone ? `Timezone: ${browserMeta.timezone}` : "",
      browserMeta.language ? `Language: ${browserMeta.language}` : ""
    ].filter(Boolean).join("\n");
  }
  if (btnExtensions) {
    const n = Number(browserMeta.extensionCount) || 0;
    btnExtensions.title = `Extensions${n ? " (" + n + " loaded)" : ""}`;
  }
}

function browserInitials(browser, label) {
  const map = { privacy: "PS", chrome: "C", brave: "B", edge: "E", firefox: "F", safari: "S" };
  if (map[browser]) return map[browser];
  return String(label || "B").trim().slice(0, 2).toUpperCase();
}

// ── Receive state updates from main ──────────────────────────────────────────
api.onMainEvent((payload) => {
  if (!payload) return;
  if (payload.type === "DOWNLOAD_STATE") {
    renderDownloadState(payload);
    return;
  }
  if (payload.type !== "TAB_STATE") return;
  tabs = payload.tabs || [];
  activeTabId = payload.activeTabId;
  if (payload.meta) browserMeta = payload.meta;
  render();
});

function renderDownloadState(payload) {
  if (!btnDownloads || !downloadStatus) return;
  const total = Number(payload.totalBytes) || 0;
  const received = Number(payload.receivedBytes) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
  const fileName = payload.fileName || "download";
  const active = payload.state === "starting" || payload.state === "progressing";
  const failed = payload.state === "interrupted" || payload.state === "cancelled";
  btnDownloads.classList.toggle("download-active", active);
  btnDownloads.classList.toggle("download-failed", failed);

  let text;
  if (active) text = `${percent == null ? "Downloading" : percent + "%"} ${fileName}`;
  else if (payload.state === "completed") text = `Downloaded ${fileName}`;
  else if (failed) text = `Download failed: ${fileName}`;
  else text = `${payload.state || "Download"}: ${fileName}`;

  downloadStatus.textContent = text;
  downloadStatus.title = payload.savePath || payload.error || text;
  downloadStatus.classList.add("visible");
  btnDownloads.title = payload.savePath ? `${text}\n${payload.savePath}` : text;
  clearTimeout(downloadStatusTimer);
  if (!active) {
    downloadStatusTimer = setTimeout(() => downloadStatus.classList.remove("visible"), 7000);
  }
}

// ── User actions ─────────────────────────────────────────────────────────────
newTab.addEventListener("click", () => {
  api.invoke("TAB_NEW", {});
});

btnBack.addEventListener("click",   () => api.invoke("TAB_BACK", {}));
btnFwd.addEventListener("click",    () => api.invoke("TAB_FORWARD", {}));
btnReload.addEventListener("click", () => {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && active.loading) api.invoke("TAB_STOP", {});
  else api.invoke("TAB_RELOAD", {});
});
btnHome.addEventListener("click",   () => api.invoke("TAB_NAVIGATE", { url: "home" }));
btnDownloads?.addEventListener("click", () => api.invoke("BROWSER_OPEN_DOWNLOADS", {}));
phoneNavBack?.addEventListener("click", () => api.invoke("TAB_BACK", {}));
phoneNavHome?.addEventListener("click", () => api.invoke("TAB_NAVIGATE", { url: "home" }));
phoneNavTabs?.addEventListener("click", () => api.invoke("TAB_NEW", {}));

async function refreshExtensions() {
  if (!extensionsList) return;
  extensionsList.textContent = "Loading...";
  const r = await api.invoke("BROWSER_LIST_EXTENSIONS", {});
  if (!r.ok) {
    extensionsList.textContent = r.error || "Could not load extensions";
    return;
  }
  const items = (r.saved && r.saved.length ? r.saved : r.extensions) || [];
  if (!items.length) {
    extensionsList.innerHTML = '<div class="panel-hint">No extensions loaded for this profile yet.</div>';
    return;
  }
  extensionsList.innerHTML = items.map((ext) => `
    <div class="ext-item">
      <div>${escapeHtml(ext.name || ext.id || "Extension")}</div>
      <div class="ext-path">${escapeHtml(ext.path || "")}</div>
    </div>
  `).join("");
}

btnExtensions?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const r = await api.invoke("BROWSER_EXTENSIONS_MENU", {});
  if (!r.ok) {
    api.invoke("BROWSER_SHOW_MESSAGE", { type: "error", title: "Extension manager", message: r.error || "Could not open extension manager" });
  }
});

btnLoadExtension?.addEventListener("click", async () => {
  const r = await api.invoke("BROWSER_LOAD_EXTENSION", {});
  if (r.canceled) return;
  if (!r.ok) {
    const msg = r.error || "Extension load failed";
    if (extensionsList) extensionsList.textContent = msg;
    api.invoke("BROWSER_SHOW_MESSAGE", { type: "error", title: "Extension load failed", message: msg });
    return;
  }
  await refreshExtensions();
});

document.addEventListener("click", (e) => {
  if (!extensionsPanel || extensionsPanel.hidden) return;
  if (!e.target.closest("#extensions-wrap")) extensionsPanel.hidden = true;
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const v = urlInput.value.trim();
  if (!v) return;
  let url = v;
  if (!/^https?:\/\//i.test(v) && !v.startsWith("file://")) {
    if (v.includes(".") && !v.includes(" ")) url = "https://" + v;
    else url = "https://www.google.com/search?q=" + encodeURIComponent(v);
  }
  api.invoke("TAB_NAVIGATE", { url });
});

// Keyboard shortcuts (handled by the strip + accelerators on main)
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "t") { e.preventDefault(); api.invoke("TAB_NEW", {}); }
  if ((e.ctrlKey || e.metaKey) && e.key === "w") { e.preventDefault(); if (activeTabId) api.invoke("TAB_CLOSE", { tabId: activeTabId }); }
  if ((e.ctrlKey || e.metaKey) && e.key === "l") { e.preventDefault(); urlInput.focus(); urlInput.select(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "r") { e.preventDefault(); api.invoke("TAB_RELOAD", {}); }
});

// Request initial state when ready
api.invoke("TAB_GET_STATE", {}).then((r) => {
  if (r && r.tabs) {
    tabs = r.tabs;
    activeTabId = r.activeTabId;
    browserMeta = r.meta || browserMeta;
    render();
  }
});

api.invoke("BROWSER_PROFILE_META", {}).then((r) => {
  if (r && r.meta) {
    browserMeta = r.meta;
    renderMeta();
  }
});
