"use strict";

const api = window.electronAPI;
const tabsRow  = document.getElementById("tabs-row");
const newTab   = document.getElementById("new-tab");
const urlInput = document.getElementById("url-input");
const btnBack  = document.getElementById("btn-back");
const btnFwd   = document.getElementById("btn-fwd");
const btnReload = document.getElementById("btn-reload");
const btnHome  = document.getElementById("btn-home");
const profilePillText = document.getElementById("profile-pill-text");
const profilePill = document.getElementById("profile-pill");

let tabs = [];        // [{ id, title, url, active }]
let activeTabId = null;
let browserMeta = null;
let suppressUrlSync = false;

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
  renderMeta();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMeta() {
  if (!profilePillText || !browserMeta) return;
  const location = [browserMeta.city, browserMeta.countryCode ? browserMeta.countryCode.toUpperCase() : ""].filter(Boolean).join(", ");
  const device = browserMeta.deviceClass === "mobile" ? "Android" : (browserMeta.os || "desktop");
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
}

// ── Receive state updates from main ──────────────────────────────────────────
api.onMainEvent((payload) => {
  if (!payload || payload.type !== "TAB_STATE") return;
  tabs = payload.tabs || [];
  activeTabId = payload.activeTabId;
  if (payload.meta) browserMeta = payload.meta;
  render();
});

// ── User actions ─────────────────────────────────────────────────────────────
newTab.addEventListener("click", () => {
  api.invoke("TAB_NEW", {});
});

btnBack.addEventListener("click",   () => api.invoke("TAB_BACK", {}));
btnFwd.addEventListener("click",    () => api.invoke("TAB_FORWARD", {}));
btnReload.addEventListener("click", () => api.invoke("TAB_RELOAD", {}));
btnHome.addEventListener("click",   () => api.invoke("TAB_NAVIGATE", { url: "home" }));

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
