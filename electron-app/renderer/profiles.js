// profiles.js — Profile Manager for Privacy Shield (Electron App)

"use strict";

// =========================================================
// Helpers
// =========================================================
const $ = (id) => document.getElementById(id);

// In Electron, window.electronAPI.invoke is exposed by the renderer-preload.js
// contextBridge. Each call goes to ipcMain.handle(type, ...) in ipc-handlers.js.
const msg = async (type, data) => {
  try {
    const result = await window.electronAPI.invoke(type, data || {});
    return result || {};
  } catch (err) {
    console.error("IPC error:", type, err);
    return { ok: false, error: String(err) };
  }
};

function toast(text, ms = 2200) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function osChip(os) {
  const map = { windows: ["os-windows", "Win"], macos: ["os-macos", "Mac"], linux: ["os-linux", "Linux"], android: ["os-linux", "Android"] };
  const [cls, label] = map[os] || ["os-windows", "Win"];
  return `<span class="chip ${cls}">${label}</span>`;
}

function browserLabel(browser) {
  const map = {
    privacy: "Privacy Shield",
    chrome: "Chrome",
    brave: "Brave",
    edge: "Edge",
    firefox: "Firefox",
    safari: "Safari"
  };
  return map[browser] || map.chrome;
}

function statusChip(s) {
  return `<span class="chip status-${s || "new"}">${(s || "new").charAt(0).toUpperCase() + (s || "new").slice(1)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function randDeviceName() {
  const prefixes = ["DESKTOP", "LAPTOP", "PC", "WORKSTATION", "HOME"];
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "";
  for (let i = 0; i < 7; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return prefixes[Math.floor(Math.random() * prefixes.length)] + "-" + r;
}

// =========================================================
// State
// =========================================================
let profiles = [];
let selectedId = null;
let activeTabId = null;
let tabAssignedProfileId = null;
const selected = new Set();

// WebGL presets list loaded from background
let webglPresets = [];

// Proxy library (global, shared across profiles)
let proxyLibrary = [];
let vpsProxyRecords = [];
let proxyProviderConfig = { endpoint: "", authMode: "bearer", hasToken: false };
let cloudPhones = [];
let cloudPhoneProviderConfig = { endpoint: "", authMode: "bearer", hasToken: false };

// Currently selected country code (for proxy picker)
let selectedCountry = null;
let currentFingerprintMeta = {};

// =========================================================
// Boot
// =========================================================
async function init() {
  // In Electron there are no browser tabs — activeTabId stays null
  // Tab assignment UI buttons will be hidden (no-op in Electron)

  // Load WebGL presets
  const wRes = await msg("PROFILE_WEBGL_PRESETS");
  webglPresets = wRes.presets || [];
  buildWebglVendorSelect();

  // Load open windows map
  await refreshOpenWindows();

  // Load proxy library
  const libRes = await msg("PROXY_LIB_GET");
  proxyLibrary = libRes.library || [];
  await loadVpsProxyRecords();
  renderProxyProviderConfig();
  renderVpsProxyRecords();
  renderProxyLibrary();
  renderCountryProxies(null, null); // show all proxies in picker on load
  await loadCloudPhones();
  renderCloudPhoneProviderConfig();
  renderCloudPhones();

  await loadProfiles();
  bindSidebarEvents();
  bindFormEvents();
  bindSessionEvents();
  renderList();

  // Listen for window-change events pushed from main process
  if (window.electronAPI && window.electronAPI.onMainEvent) {
    window.electronAPI.onMainEvent(async (payload) => {
      if (payload.type === "WINDOWS_CHANGED") {
        await refreshOpenWindows();
        renderList();
        if (selectedId) updateSessionTab();
      } else if (payload.type === "CLOUD_PHONES_CHANGED") {
        await loadCloudPhones();
        renderCloudPhones();
      }
    });
  }

  // Also poll every 10 seconds as fallback
  setInterval(async () => {
    await refreshOpenWindows();
    renderList();
    if (selectedId) updateSessionTab();
  }, 10000);
}

function buildWebglVendorSelect() {
  const sel = $("fp-webglVendor");
  if (!sel) return;
  sel.innerHTML = "";
  const vendors = [...new Set(webglPresets.map((p) => p.vendor))];
  for (const v of vendors) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    const vendor = sel.value;
    const match = webglPresets.find((p) => p.vendor === vendor);
    if (match) $("fp-webglRenderer").value = match.renderer;
  });
}

// =========================================================
// Data
// =========================================================
async function loadProfiles() {
  const r = await msg("PROFILE_LIST");
  profiles = r.profiles || [];
}

let creatingNew = false;

function startNewProfile() {
  // Open an empty setup form WITHOUT saving until the user clicks "Create profile".
  creatingNew = true;
  selectedId = null;
  currentFingerprintMeta = {};
  $("emptyState").hidden = true;
  $("formWrap").hidden = false;
  // Build a synthetic placeholder so populateForm can fill defaults
  const placeholder = {
    id: "__new__",
    name: "New Profile " + (profiles.length + 1),
    status: "new",
    os: "windows",
    browserApp: "chrome",
    windowMode: "normal",
    tags: [],
    notes: "",
    fingerprint: {},
    proxy: { enabled: false, scheme: "socks5", host: "", port: 1080, username: "", password: "", bypassList: [] },
    cookies: [],
    session: null
  };
  populateForm(placeholder);
  // Update the save button label
  const saveBtn = $("btnSave");
  if (saveBtn) saveBtn.textContent = "Create profile";
  renderList();
}

async function saveCurrentProfile() {
  let data;
  try { data = collectForm(); } catch (e) { toast("Form error: " + e.message); return; }

  if (creatingNew) {
    const r = await msg("PROFILE_CREATE", { data });
    if (!r.ok) { toast("Create failed: " + (r.error || "unknown")); return; }
    profiles.push(r.profile);
    creatingNew = false;
    selectedId = r.profile.id;
    const saveBtn = $("btnSave");
    if (saveBtn) saveBtn.textContent = "Save";
    renderList();
    toast("Profile created");
    return;
  }

  if (!selectedId) { toast("Select a profile first"); return; }
  const r = await msg("PROFILE_UPDATE", { id: selectedId, data });
  if (!r.ok) { toast("Save failed: " + (r.error || "unknown error")); return; }
  await loadProfiles();
  renderList();
  toast("Profile saved");
}

async function deleteProfile(id) {
  if (!confirm("Delete this profile?")) return;
  const r = await msg("PROFILE_DELETE", { id });
  if (!r.ok) { toast("Delete failed"); return; }
  profiles = profiles.filter((p) => p.id !== id);
  if (selectedId === id) {
    selectedId = null;
    $("emptyState").hidden = false;
    $("formWrap").hidden = true;
  }
  renderList();
  toast("Deleted");
}

async function duplicateProfile(id) {
  const r = await msg("PROFILE_DUPLICATE", { id });
  if (!r.ok) { toast("Duplicate failed"); return; }
  profiles.push(r.profile);
  renderList();
  selectProfile(r.profile.id);
  toast("Duplicated");
  loadProfiles().then(() => renderList()).catch(() => {});
}

async function assignToTab(profileId) {
  if (!activeTabId) { toast("No active tab"); return; }
  const alreadyAssigned = tabAssignedProfileId === profileId;
  await msg("PROFILE_ASSIGN_TAB", { tabId: activeTabId, profileId: alreadyAssigned ? null : profileId });
  tabAssignedProfileId = alreadyAssigned ? null : profileId;
  renderList();
  updateAssignedTabInfo();
  toast(alreadyAssigned ? "Profile removed from tab" : "Profile applied to tab — reload tab to see changes");
}

// =========================================================
// Sidebar rendering
// =========================================================
function renderList() {
  const list = $("profileList");
  const search = $("searchInput").value.toLowerCase();
  const fStatus = $("filterStatus").value;
  const fOS = $("filterOS").value;

  let filtered = profiles.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search) && !(p.tags || []).join(" ").includes(search)) return false;
    if (fStatus && p.status !== fStatus) return false;
    if (fOS && p.os !== fOS) return false;
    return true;
  });

  list.innerHTML = "";

  if (!filtered.length) {
    list.innerHTML = '<div class="pm-list-empty" id="listEmpty">No profiles yet.<br>Click <b>+ New Profile</b> to start.</div>';
    return;
  }

  for (const p of filtered) {
    const isActive = p.id === selectedId;
    const isAssigned = p.id === tabAssignedProfileId;
    const card = document.createElement("div");
    card.className = "pm-card" + (isActive ? " active" : "");
    card.dataset.id = p.id;

    const isRunning = p.id in openWindows;
    const proxyBadge   = p.proxy?.enabled ? `<span class="chip proxy-on">Proxy</span>` : "";
    const assignedBadge = isAssigned ? `<span class="chip status-active">On Tab</span>` : "";
    const runningBadge  = isRunning ? `<span class="chip status-active">Live</span>` : "";
    const tags = (p.tags || []).slice(0, 3).map((t) => `<span class="chip status-new">${escHtml(t)}</span>`).join("");
    const browserIcons = { privacy: "PS", chrome: "&#9689;", brave: "&#129321;", edge: "&#127919;", firefox: "FF", safari: "SF" };
    const browserName = p.browserApp || "chrome";
    const browserBadge = `<span class="chip browser-chip" title="${browserLabel(browserName)}">${browserIcons[browserName] || "&#9689;"} ${browserLabel(browserName)}</span>`;
    const incogBadge   = p.windowMode === "incognito" ? `<span class="chip incog-chip">Incognito</span>` : "";

    card.innerHTML = `
      <input type="checkbox" class="pm-card-check" data-id="${p.id}" />
      <div class="pm-card-body">
        <div class="pm-card-name">${escHtml(p.name)}</div>
        <div class="pm-card-meta">
          ${browserBadge}
          ${osChip(p.os)}
          ${statusChip(p.status)}
          ${proxyBadge}
          ${incogBadge}
          ${runningBadge}
          ${assignedBadge}
          ${tags}
        </div>
      </div>
      <div class="pm-card-actions">
        ${isRunning
          ? `<button class="pm-btn-xs danger" data-action="stop" data-id="${p.id}" title="Stop and save the session">Stop</button>`
          : `<button class="pm-btn-xs success" data-action="start" data-id="${p.id}" title="Start browser with this profile">Start</button>`}
        <button class="pm-btn-xs" data-action="dup" data-id="${p.id}" title="Duplicate">Dup</button>
        <button class="pm-btn-xs danger" data-action="del" data-id="${p.id}" title="Delete">Del</button>
      </div>
    `;
    list.appendChild(card);
  }

  // Restore checkbox state
  for (const id of selected) {
    const cb = list.querySelector(`input[data-id="${id}"]`);
    if (cb) cb.checked = true;
  }
  // Mark running profile windows with green border
  for (const pid of Object.keys(openWindows)) {
    const card = list.querySelector(`.pm-card[data-id="${pid}"]`);
    if (card) card.classList.add("running");
  }
  updateBulkBar();
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// =========================================================
// Profile selection & form
// =========================================================
async function selectProfile(id) {
  creatingNew = false;
  const saveBtn = $("btnSave");
  if (saveBtn) saveBtn.textContent = "Save";
  selectedId = id;
  let p = profiles.find((p) => p.id === id);
  if (!p) {
    // Local cache miss — re-fetch from disk before giving up
    await loadProfiles();
    p = profiles.find((p) => p.id === id);
    if (!p) return;
  }
  $("emptyState").hidden = true;
  $("formWrap").hidden = false;
  populateForm(p);
  renderList();
  updateSessionTab();
}

function populateForm(p) {
  $("fp-name").value = p.name || "";
  $("fp-status").value = p.status || "new";
  $("fp-os").value = p.os || "windows";
  setVal("fp-browserApp",  p.browserApp  || "chrome");
  setVal("fp-windowMode",  p.windowMode  || "normal");
  $("fp-tags").value = (p.tags || []).join(", ");
  $("fp-notes").value = p.notes || "";
  updateAssignedTabInfo();

  const fp = p.fingerprint || {};
  currentFingerprintMeta = {
    countryCode: fp.countryCode || "",
    country: fp.country || "",
    continent: fp.continent || "",
    organization: fp.organization || fp.ispOrg || "",
    ip: fp.ip || "",
    domain: fp.domain || "",
    hardwareId: fp.hardwareId || "",
    fontProfile: fp.fontProfile || p.os || "windows",
    installedFonts: Array.isArray(fp.installedFonts) ? fp.installedFonts : [],
    colorDepth: fp.colorDepth || 24,
    pixelDepth: fp.pixelDepth || 24,
    devicePixelRatio: fp.devicePixelRatio || 1,
    deviceClass: fp.deviceClass || (p.os === "android" ? "mobile" : "desktop"),
    mobileModel: fp.mobileModel || "",
    mobileManufacturer: fp.mobileManufacturer || "",
    platformVersion: fp.platformVersion || "",
    androidBuild: fp.androidBuild || "",
    architecture: fp.architecture || (p.os === "android" ? "arm" : "x86"),
    bitness: fp.bitness || "64",
    maxTouchPoints: fp.maxTouchPoints || (p.os === "android" ? 5 : 0),
    screenOrientation: fp.screenOrientation || (p.os === "android" ? "portrait-primary" : "landscape-primary"),
    touchEmulation: fp.touchEmulation ?? (p.os === "android"),
    sensorEmulation: fp.sensorEmulation ?? (p.os === "android"),
    viewportMobile: fp.viewportMobile ?? (p.os === "android"),
    pointerType: fp.pointerType || (p.os === "android" ? "coarse" : "fine"),
    hoverType: fp.hoverType || (p.os === "android" ? "none" : "hover"),
    deviceMotion: fp.deviceMotion || null,
    deviceOrientation: fp.deviceOrientation || null,
    connectionType: fp.connectionType || "wifi",
    downlink: fp.downlink || 10,
    rtt: fp.rtt || 50
  };
  setVal("fp-browser", fp.browser || p.browserApp || "chrome");
  updateBrowserVersionOptions();
  setVal("fp-userAgent", fp.userAgent || "auto");
  setVal("fp-userAgentValue", fp.userAgentValue || "");
  setVal("fp-canvas", fp.canvas || "noise");
  setVal("fp-webgl", fp.webgl || "noise");
  setVal("fp-webglInfo", fp.webglInfo || "manual");
  setVal("fp-webglVendor", fp.webglVendor || webglPresets[0]?.vendor || "");
  setVal("fp-webglRenderer", fp.webglRenderer || webglPresets[0]?.renderer || "");
  setVal("fp-webgpu", String(fp.webgpu === true));
  setVal("fp-audio", fp.audio || "noise");
  setVal("fp-clientRects", fp.clientRects || "real");
  setVal("fp-timezone", fp.timezone || "auto");
  setVal("fp-timezoneValue", fp.timezoneValue || "America/New_York");
  setVal("fp-timezoneOffset", fp.timezoneOffset ?? 300);
  setVal("fp-language", fp.language || "auto");
  setVal("fp-languageValue", fp.languageValue || "en-US");
  setVal("fp-geolocation", fp.geolocation || "auto");
  setVal("fp-geoLat", fp.geoLat ?? 40.7128);
  setVal("fp-geoLng", fp.geoLng ?? -74.006);
  setVal("fp-geoAccuracy", fp.geoAccuracy ?? 50);
  setVal("fp-cpuCores", fp.cpuCores || "manual");
  setVal("fp-cpuCoresValue", fp.cpuCoresValue || 4);
  setVal("fp-ram", fp.ram || "manual");
  setVal("fp-ramValue", fp.ramValue || 8);
  setVal("fp-screen", fp.screen || "manual");
  setVal("fp-screenWidth", fp.screenWidth || 1920);
  setVal("fp-screenHeight", fp.screenHeight || 1080);
  setVal("fp-mediaDevices", fp.mediaDevices || "real");
  setVal("fp-cameras", fp.cameras ?? 1);
  setVal("fp-microphones", fp.microphones ?? 1);
  setVal("fp-speakers", fp.speakers ?? 1);
  setVal("fp-fonts", fp.fonts || "real");
  setVal("fp-deviceName", fp.deviceName || "off");
  setVal("fp-deviceNameValue", fp.deviceNameValue || "");
  setVal("fp-ports", fp.ports || "block");
  setVal("fp-blockedPorts", (fp.blockedPorts || [3389, 5938]).join(", "));
  setVal("fp-doNotTrack", String(Boolean(fp.doNotTrack)));
  setVal("fp-webrtc", fp.webrtc || "altered");
  setVal("fp-webrtcIP", fp.webrtcIP || "");
  setVal("fp-blockCookies", String(Boolean(fp.blockCookies)));
  setVal("fp-blockStorage", String(Boolean(fp.blockStorage)));

  // Browser + ISP
  const bv = fp.browserVersion || "148";
  const knownVersions = ["120", "122", "124", "131", "136", "148"];
  if (knownVersions.includes(bv)) {
    setVal("fp-browserVersion", bv);
    setVal("fp-browserVersionCustom", "");
  } else {
    setVal("fp-browserVersion", "custom");
    setVal("fp-browserVersionCustom", bv);
  }
  const bvcRow = $("browserVersionCustomRow");
  if (bvcRow) bvcRow.hidden = knownVersions.includes(bv);
  setVal("fp-city", fp.city || "");
  setVal("fp-state", fp.state || "");
  setVal("fp-ispName", fp.ispName || "");
  setVal("fp-ispAsn", fp.ispAsn || "");
  setVal("fp-ispOrg", fp.ispOrg || "");

  const px = p.proxy || {};
  setVal("px-networkMode", px.networkMode || (px.enabled ? "proxy" : "direct"));
  setVal("px-enabled", String(Boolean(px.enabled)));
  setVal("px-scheme", px.scheme || "socks5");
  setVal("px-host", px.host || "");
  setVal("px-port", px.port || 1080);
  setVal("px-username", px.username || "");
  setVal("px-password", px.password || "");
  setVal("px-rotationUrl", px.rotationUrl || "");
  setVal("px-bypassList", (px.bypassList || []).join(", "));

  updateConditionalRows();
  updateCookiePanel(p);
  updateUAPreview();
}

function setVal(id, val) {
  const el = $(id);
  if (!el) return;
  el.value = String(val ?? "");
}

function collectForm() {
  return {
    name: $("fp-name").value.trim() || "Unnamed",
    status: $("fp-status").value,
    os: $("fp-os").value,
    browserApp: $("fp-browserApp")?.value || "chrome",
    windowMode: $("fp-windowMode")?.value || "normal",
    tags: $("fp-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    notes: $("fp-notes").value,
    fingerprint: {
      browser: $("fp-browser")?.value || "chrome",
      userAgent: $("fp-userAgent").value,
      userAgentValue: $("fp-userAgentValue").value.trim(),
      canvas: $("fp-canvas").value,
      webgl: $("fp-webgl").value,
      webglInfo: $("fp-webglInfo").value,
      webglVendor: $("fp-webglVendor").value,
      webglRenderer: $("fp-webglRenderer").value.trim(),
      webgpu: $("fp-webgpu").value === "true",
      audio: $("fp-audio").value,
      clientRects: $("fp-clientRects").value,
      timezone: $("fp-timezone").value,
      timezoneValue: $("fp-timezoneValue").value.trim(),
      timezoneOffset: Number($("fp-timezoneOffset").value) || 0,
      language: $("fp-language").value,
      languageValue: $("fp-languageValue").value,
      geolocation: $("fp-geolocation").value,
      geoLat: Number($("fp-geoLat").value) || 0,
      geoLng: Number($("fp-geoLng").value) || 0,
      geoAccuracy: Number($("fp-geoAccuracy").value) || 50,
      cpuCores: $("fp-cpuCores").value,
      cpuCoresValue: Number($("fp-cpuCoresValue").value) || 4,
      ram: $("fp-ram").value,
      ramValue: Number($("fp-ramValue").value) || 8,
      screen: $("fp-screen").value,
      screenWidth: Number($("fp-screenWidth").value) || 1920,
      screenHeight: Number($("fp-screenHeight").value) || 1080,
      mediaDevices: $("fp-mediaDevices").value,
      cameras: Number($("fp-cameras").value) || 1,
      microphones: Number($("fp-microphones").value) || 1,
      speakers: Number($("fp-speakers").value) || 1,
      fonts: $("fp-fonts").value,
      deviceName: $("fp-deviceName").value,
      deviceNameValue: $("fp-deviceNameValue").value.trim(),
      ports: $("fp-ports").value,
      blockedPorts: $("fp-blockedPorts").value.split(",").map((x) => Number(x.trim())).filter(Boolean),
      doNotTrack: $("fp-doNotTrack").value === "true",
      webrtc: $("fp-webrtc").value,
      webrtcIP: $("fp-webrtcIP").value.trim(),
      blockCookies: $("fp-blockCookies").value === "true",
      blockStorage: $("fp-blockStorage").value === "true",
      browserVersion: (() => {
        const sel = $("fp-browserVersion")?.value || "148";
        if (sel === "custom") return ($("fp-browserVersionCustom")?.value.trim() || "148");
        return sel;
      })(),
      city: ($("fp-city")?.value || "").trim(),
      state: ($("fp-state")?.value || "").trim(),
      ispName: ($("fp-ispName")?.value || "").trim(),
      ispAsn: ($("fp-ispAsn")?.value || "").trim(),
      ispOrg: ($("fp-ispOrg")?.value || "").trim(),
      countryCode: currentFingerprintMeta.countryCode || selectedCountry || "",
      country: currentFingerprintMeta.country || "",
      continent: currentFingerprintMeta.continent || "",
      organization: currentFingerprintMeta.organization || ($("fp-ispOrg")?.value || "").trim(),
      ip: currentFingerprintMeta.ip || "",
      domain: currentFingerprintMeta.domain || "",
      hardwareId: currentFingerprintMeta.hardwareId || "",
      fontProfile: currentFingerprintMeta.fontProfile || $("fp-os")?.value || "windows",
      installedFonts: Array.isArray(currentFingerprintMeta.installedFonts) ? currentFingerprintMeta.installedFonts : [],
      colorDepth: Number(currentFingerprintMeta.colorDepth) || 24,
      pixelDepth: Number(currentFingerprintMeta.pixelDepth) || 24,
      devicePixelRatio: Number(currentFingerprintMeta.devicePixelRatio) || 1,
      deviceClass: ($("fp-os")?.value === "android") ? "mobile" : (currentFingerprintMeta.deviceClass || "desktop"),
      mobileModel: currentFingerprintMeta.mobileModel || "",
      mobileManufacturer: currentFingerprintMeta.mobileManufacturer || "",
      platformVersion: currentFingerprintMeta.platformVersion || "",
      androidBuild: currentFingerprintMeta.androidBuild || "",
      architecture: ($("fp-os")?.value === "android") ? "arm" : (currentFingerprintMeta.architecture || "x86"),
      bitness: currentFingerprintMeta.bitness || "64",
      maxTouchPoints: Number(currentFingerprintMeta.maxTouchPoints) || (($("fp-os")?.value === "android") ? 5 : 0),
      screenOrientation: ($("fp-os")?.value === "android") ? "portrait-primary" : (currentFingerprintMeta.screenOrientation || "landscape-primary"),
      touchEmulation: ($("fp-os")?.value === "android") || Boolean(currentFingerprintMeta.touchEmulation),
      sensorEmulation: ($("fp-os")?.value === "android") || Boolean(currentFingerprintMeta.sensorEmulation),
      viewportMobile: ($("fp-os")?.value === "android") || Boolean(currentFingerprintMeta.viewportMobile),
      pointerType: ($("fp-os")?.value === "android") ? "coarse" : (currentFingerprintMeta.pointerType || "fine"),
      hoverType: ($("fp-os")?.value === "android") ? "none" : (currentFingerprintMeta.hoverType || "hover"),
      deviceMotion: currentFingerprintMeta.deviceMotion || null,
      deviceOrientation: currentFingerprintMeta.deviceOrientation || null,
      connectionType: currentFingerprintMeta.connectionType || "wifi",
      downlink: Number(currentFingerprintMeta.downlink) || 10,
      rtt: Number(currentFingerprintMeta.rtt) || 50
    },
    proxy: {
      networkMode: $("px-networkMode")?.value || (($("px-enabled")?.value === "true") ? "proxy" : "direct"),
      enabled: $("px-enabled").value === "true",
      scheme: $("px-scheme").value,
      host: $("px-host").value.trim(),
      port: Number($("px-port").value) || 1080,
      username: $("px-username").value,
      password: $("px-password").value,
      rotationUrl: $("px-rotationUrl").value.trim(),
      bypassList: $("px-bypassList").value.split(",").map((s) => s.trim()).filter(Boolean)
    }
  };
}

// =========================================================
// Conditional row visibility
// =========================================================
function updateConditionalRows() {
  const show = (id, visible) => { const el = $(id); if (el) el.hidden = !visible; };

  const ua = $("fp-userAgent")?.value;
  show("uaManualRow", ua === "manual");
  updateUAPreview();

  const webglInfo = $("fp-webglInfo")?.value;
  const webglManualRow = $("webglManualRow");
  if (webglManualRow) webglManualRow.hidden = webglInfo !== "manual";

  const tz = $("fp-timezone")?.value;
  const tzRow = $("tzManualRow");
  if (tzRow) tzRow.hidden = tz !== "manual";

  const lang = $("fp-language")?.value;
  show("langManualRow", lang === "manual");

  const geo = $("fp-geolocation")?.value;
  show("geoManualRow", geo === "manual");

  const devName = $("fp-deviceName")?.value;
  show("deviceNameManualRow", devName !== "off");

  const ports = $("fp-ports")?.value;
  show("portsBlockRow", ports === "block");

  const webrtc = $("fp-webrtc")?.value;
  show("webrtcManualRow", webrtc === "manual");

  const media = $("fp-mediaDevices")?.value;
  show("mediaManualRow", media === "manual");

  const screenMode = $("fp-screen")?.value;
  const screenRow = $("screenManualRow");
  if (screenRow) screenRow.hidden = screenMode !== "manual";

  const bvSel = $("fp-browserVersion")?.value;
  show("browserVersionCustomRow", bvSel === "custom");

  const networkMode = $("px-networkMode")?.value || "proxy";
  const pxEnabled = $("px-enabled")?.value === "true";
  show("proxyFields", networkMode === "proxy" && pxEnabled);
}

function updateUAPreview() {
  const mode = $("fp-userAgent")?.value;
  const os   = $("fp-os")?.value || "windows";
  const br   = $("fp-browser")?.value || "chrome";
  const preview = $("uaPreview");
  if (!preview) return;
  if (mode === "manual") { preview.textContent = ""; return; }
  const bvSel = $("fp-browserVersion")?.value;
  const bv = bvSel === "custom"
    ? ($("fp-browserVersionCustom")?.value.trim() || "148")
    : (bvSel || "148");
  const full = bv.includes(".") ? bv : bv + ".0.0.0";
  const fv   = full.split(".")[0];

  const osStr = { windows: "Windows NT 10.0; Win64; x64", macos: "Macintosh; Intel Mac OS X 10_15_7", linux: "X11; Linux x86_64", android: "Linux; Android 14; Pixel 8 Build/UP1A.231005.007" }[os] || "Windows NT 10.0; Win64; x64";
  let ua;
  if (br === "firefox")     ua = `Mozilla/5.0 (${osStr}; rv:${fv}.0) Gecko/20100101 Firefox/${fv}.0`;
  else if (br === "safari") ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${full} Safari/605.1.15`;
  else if (br === "privacy" && os === "android") ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Mobile Safari/537.36 PrivacyShield/${full}`;
  else if (os === "android") ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Mobile Safari/537.36`;
  else if (br === "edge")   ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 Edg/${full}`;
  else if (br === "privacy") ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36 PrivacyShield/${full}`;
  else                      ua = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;

  preview.textContent = "Auto: " + ua;
}

function updateBrowserVersionOptions() {
  const br = $("fp-browser")?.value || "chrome";
  const verRow  = $("browserVersionRow");
  const hint    = $("browserVersionHint");
  const verSel  = $("fp-browserVersion");
  if (!verSel) return;

  if (br === "firefox") {
    verSel.innerHTML = `
      <option value="115">115 (ESR)</option>
      <option value="120">120</option>
      <option value="122">122</option>
      <option value="124">124</option>
      <option value="128">128 (ESR)</option>
      <option value="136">136</option>
      <option value="137">137 (latest)</option>
      <option value="custom">Custom…</option>`;
    if (!verSel.value) verSel.value = "137";
    if (hint) hint.textContent = "Sets the Firefox version in the auto-generated User-Agent string.";
  } else if (br === "safari") {
    verSel.innerHTML = `
      <option value="16.6">16.6</option>
      <option value="17.0">17.0</option>
      <option value="17.4">17.4</option>
      <option value="17.5">17.5 (latest)</option>
      <option value="custom">Custom…</option>`;
    if (!verSel.value) verSel.value = "17.5";
    if (hint) hint.textContent = "Sets the Safari version in the auto-generated User-Agent string.";
  } else {
    verSel.innerHTML = `
      <option value="120">120</option>
      <option value="122">122</option>
      <option value="124">124</option>
      <option value="131">131</option>
      <option value="136">136</option>
      <option value="148">148 (latest)</option>
      <option value="custom">Custom…</option>`;
    const name = browserLabel(br);
    if (hint) hint.textContent = `Sets the ${name} version in the auto-generated User-Agent string.`;
  }
  updateUAPreview();
}

function setBrowserVersionValue(version) {
  const value = String(version || "148");
  const sel = $("fp-browserVersion");
  if (!sel) return;
  const hasOption = Array.from(sel.options || []).some((option) => option.value === value);
  if (hasOption) {
    setVal("fp-browserVersion", value);
    setVal("fp-browserVersionCustom", "");
  } else {
    setVal("fp-browserVersion", "custom");
    setVal("fp-browserVersionCustom", value);
  }
  const bvcRow = $("browserVersionCustomRow");
  if (bvcRow) bvcRow.hidden = hasOption;
  updateUAPreview();
}

// =========================================================
// Cookie panel
// =========================================================
function updateCookiePanel(p) {
  const cookies = p.cookies || [];
  const summary = $("cookieSummary");
  const list = $("cookieList");
  if (!summary || !list) return;

  summary.textContent = `${cookies.length} cookie${cookies.length !== 1 ? "s" : ""} stored in this profile`;

  list.innerHTML = "";
  if (!cookies.length) {
    list.innerHTML = '<div class="pm-list-empty">No cookies stored in this profile.</div>';
    return;
  }
  const limit = Math.min(cookies.length, 60);
  for (let i = 0; i < limit; i++) {
    const c = cookies[i];
    const item = document.createElement("div");
    item.className = "pm-cookie-item";
    item.innerHTML = `
      <span class="pm-cookie-name">${escHtml(c.name)}</span>
      <span class="pm-cookie-domain">${escHtml(c.domain)}</span>
    `;
    list.appendChild(item);
  }
  if (cookies.length > limit) {
    const more = document.createElement("div");
    more.className = "pm-list-empty";
    more.textContent = `… and ${cookies.length - limit} more`;
    list.appendChild(more);
  }
}

function updateAssignedTabInfo() {
  const el = $("assignedTabInfo");
  if (!el) return;
  if (selectedId && tabAssignedProfileId === selectedId) {
    el.hidden = false;
    el.textContent = "This profile is currently applied to the active tab.";
  } else {
    el.hidden = true;
  }
}

// =========================================================
// Bulk actions
// =========================================================
function updateBulkBar() {
  const bar = $("bulkBar");
  const count = $("selectedCount");
  bar.hidden = selected.size === 0;
  count.textContent = `${selected.size} selected`;
}

// =========================================================
// Import / Export
// =========================================================
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  downloadJson(profiles, "privacy-shield-profiles.json");
  toast("Exported " + profiles.length + " profiles");
}

async function importProfiles(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { toast("Invalid JSON"); return; }
  const list = Array.isArray(data) ? data : [data];
  let n = 0;
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const r = await msg("PROFILE_CREATE", { data: { ...p, id: undefined, createdAt: undefined } });
    if (r.ok) n++;
  }
  await loadProfiles();
  renderList();
  toast(`Imported ${n} profile${n !== 1 ? "s" : ""}`);
}

async function exportCookies(profileId) {
  const r = await msg("PROFILE_EXPORT_COOKIES", { profileId });
  if (!r.ok) { toast("Export failed"); return; }
  downloadJson(r.cookies, "cookies-" + profileId + ".json");
  toast("Exported " + r.cookies.length + " cookies");
}

async function importCookiesFile(profileId, file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { toast("Invalid JSON"); return; }
  const cookies = Array.isArray(data) ? data : [];
  const r = await msg("PROFILE_IMPORT_COOKIES", { profileId, cookies });
  if (!r.ok) { toast("Import failed"); return; }
  await loadProfiles();
  const p = profiles.find((p) => p.id === profileId);
  if (p) updateCookiePanel(p);
  toast("Imported " + cookies.length + " cookies");
}

async function captureCookies(profileId) {
  const r = await msg("PROFILE_CAPTURE_COOKIES", { profileId });
  if (!r.ok) { toast(r.error || "No open window for this profile"); return; }
  await loadProfiles();
  const p = profiles.find((p) => p.id === profileId);
  if (p) updateCookiePanel(p);
  toast(`Captured ${r.count} cookies from profile window`);
}

async function injectCookies(profileId) {
  const r = await msg("PROFILE_INJECT_COOKIES", { profileId });
  if (!r.ok) { toast(r.error || "Failed to inject"); return; }
  toast(`Injected ${r.count} cookies into profile session`);
}

// =========================================================
// Proxy test
// =========================================================
async function testProxy() {
  const res = $("proxyTestResult");
  res.textContent = "Testing…";
  res.className = "pm-proxy-result";
  // Save profile first, then test via existing CONNECT_PROXY flow
  const data = collectForm();
  if (selectedId) await msg("PROFILE_UPDATE", { id: selectedId, data });
  const px = data.proxy;
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  if (mode === "vpn") {
    const captured = await captureCurrentVpnLocation(res);
    if (captured?.ok) {
      res.textContent = `VPN mode OK - current IP: ${captured.network.ip}${captured.network.country ? " - " + captured.network.country : ""}`;
      res.className = "pm-proxy-result ok";
    }
    return;
  }
  if (mode === "direct") {
    res.textContent = "Direct mode uses this computer's current connection. Use VPN mode to capture an active VPN IP.";
    res.className = "pm-proxy-result ok";
    return;
  }
  if (!px.host || !px.port) {
    res.textContent = "Enter host and port first.";
    res.className = "pm-proxy-result err";
    return;
  }
  const r = await msg("TEST_PROXY", { host: px.host, port: px.port, scheme: px.scheme, username: px.username, password: px.password });
  if (r.ok) {
    res.textContent = "OK — IP: " + r.ip;
    res.className = "pm-proxy-result ok";
  } else {
    res.textContent = "Failed: " + (r.error || "unknown");
    res.className = "pm-proxy-result err";
  }
}

async function captureCurrentVpnLocation(targetResult) {
  const res = targetResult || $("vpnCaptureResult");
  const btn = $("btnCaptureVpn");
  if (res) {
    res.textContent = "Capturing current IP...";
    res.className = "pm-proxy-result";
  }
  if (btn) btn.disabled = true;

  const r = await msg("NETWORK_CAPTURE_CURRENT");
  if (!r.ok || !r.network) {
    if (res) {
      res.textContent = "Failed: " + (r.error || "could not capture current IP");
      res.className = "pm-proxy-result err";
    }
    if (btn) btn.disabled = false;
    return { ok: false, error: r.error || "could not capture current IP" };
  }

  const n = r.network;
  setVal("px-networkMode", "vpn");
  setVal("px-enabled", "false");
  setVal("fp-timezone", "manual");
  if (n.timezone) setVal("fp-timezoneValue", n.timezone);
  setVal("fp-language", "manual");
  if (n.countryCode) setVal("fp-languageValue", languageForCountry(n.countryCode));
  setVal("fp-geolocation", "manual");
  if (n.latitude) setVal("fp-geoLat", n.latitude);
  if (n.longitude) setVal("fp-geoLng", n.longitude);
  setVal("fp-geoAccuracy", 50);
  if (n.city) setVal("fp-city", n.city);
  if (n.state) setVal("fp-state", n.state);
  if (n.ispName) setVal("fp-ispName", n.ispName);
  if (n.ispAsn) setVal("fp-ispAsn", n.ispAsn);
  if (n.ispOrg || n.organization) setVal("fp-ispOrg", n.ispOrg || n.organization);
  currentFingerprintMeta = {
    ...currentFingerprintMeta,
    countryCode: n.countryCode || currentFingerprintMeta.countryCode || "",
    country: n.country || currentFingerprintMeta.country || "",
    continent: n.continent || currentFingerprintMeta.continent || "",
    organization: n.organization || n.ispOrg || currentFingerprintMeta.organization || "",
    ip: n.ip || currentFingerprintMeta.ip || ""
  };

  updateConditionalRows();
  updateUAPreview();
  if (selectedId) {
    await msg("PROFILE_UPDATE", { id: selectedId, data: collectForm() });
    await loadProfiles();
    renderList();
  }
  if (res) {
    res.textContent = `VPN/IP captured: ${n.ip}${n.country ? " - " + n.country : ""}${n.city ? ", " + n.city : ""}`;
    res.className = "pm-proxy-result ok";
  }
  toast("Current VPN/IP location applied");
  if (btn) btn.disabled = false;
  return { ok: true, network: n };
}

function languageForCountry(countryCode) {
  const map = {
    us: "en-US", gb: "en-GB", ca: "en-CA", au: "en-AU", de: "de-DE", nl: "nl-NL",
    fr: "fr-FR", ch: "de-DE", se: "sv-SE", jp: "ja-JP", sg: "en-SG", br: "pt-BR",
    in: "hi-IN", ae: "ar-AE", ru: "ru-RU", tr: "tr-TR", ng: "en-US"
  };
  return map[String(countryCode || "").toLowerCase()] || "en-US";
}

// =========================================================
// Event binding
// =========================================================
function bindSidebarEvents() {
  $("btnNewProfile").addEventListener("click", startNewProfile);
  $("btnNewProfileEmpty")?.addEventListener("click", startNewProfile);

  $("searchInput").addEventListener("input", renderList);
  $("filterStatus").addEventListener("change", renderList);
  $("filterOS").addEventListener("change", renderList);

  $("profileList").addEventListener("click", (e) => {
    const card = e.target.closest(".pm-card");
    if (!card) return;
    const id = card.dataset.id;

    // Action buttons
    const action = e.target.dataset.action;
    if (action === "del") { e.stopPropagation(); deleteProfile(id); return; }
    if (action === "dup") { e.stopPropagation(); duplicateProfile(id); return; }
    if (action === "apply") { e.stopPropagation(); assignToTab(id); return; }
    if (action === "open" || action === "start") { e.stopPropagation(); openProfileWindow(id); return; }
    if (action === "stop") { e.stopPropagation(); stopProfile(id); return; }

    // Checkbox
    if (e.target.classList.contains("pm-card-check")) {
      if (e.target.checked) selected.add(id);
      else selected.delete(id);
      updateBulkBar();
      return;
    }

    // Select profile
    selectProfile(id);
  });

  $("bulkDelete").addEventListener("click", async () => {
    if (!confirm(`Delete ${selected.size} profiles?`)) return;
    for (const id of [...selected]) await msg("PROFILE_DELETE", { id });
    selected.clear();
    await loadProfiles();
    if (selected.has(selectedId)) { selectedId = null; $("emptyState").hidden = false; $("formWrap").hidden = true; }
    renderList();
    toast("Deleted");
  });

  $("bulkExport").addEventListener("click", () => {
    const toExport = profiles.filter((p) => selected.has(p.id));
    downloadJson(toExport, "privacy-shield-profiles-selected.json");
    toast("Exported " + toExport.length + " profiles");
  });

  $("bulkClear").addEventListener("click", () => { selected.clear(); renderList(); });

  $("btnExportAll").addEventListener("click", exportAll);
  $("btnImport").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => { if (e.target.files[0]) importProfiles(e.target.files[0]); e.target.value = ""; });

  // Account / logout
  msg("AUTH_SESSION").then((r) => {
    if (r.session && r.session.email) {
      const el = $("accountEmail");
      if (el) el.textContent = r.session.email;
    }
  }).catch(() => {});

  $("btnLogout").addEventListener("click", async () => {
    if (!confirm("Sign out of your account?\nYour profiles will be saved.")) return;
    await msg("AUTH_DO_LOGOUT");
  });

  $("btnTrash").addEventListener("click", async () => {
    const r = await msg("PROFILE_LIST", { showDeleted: true });
    const trashed = (r.profiles || []).filter((p) => p.deletedAt);
    if (!trashed.length) { toast("Trash is empty"); return; }
    if (!confirm(`Permanently delete ${trashed.length} trashed profile(s)?`)) return;
    for (const p of trashed) await msg("PROFILE_DELETE", { id: p.id, hard: true });
    toast("Trash emptied");
  });
}

function bindFormEvents() {
  $("btnSave").addEventListener("click", saveCurrentProfile);
  $("btnDelete").addEventListener("click", () => selectedId && deleteProfile(selectedId));
  $("btnDuplicate").addEventListener("click", () => selectedId && duplicateProfile(selectedId));
  $("btnAssignTab").addEventListener("click", () => selectedId && assignToTab(selectedId));
  $("btnTestProxy").addEventListener("click", testProxy);
  $("btnRandDeviceName").addEventListener("click", () => { $("fp-deviceNameValue").value = randDeviceName(); });

  // Cookie buttons
  $("btnCaptureCookies").addEventListener("click", () => selectedId && captureCookies(selectedId));
  $("btnInjectCookies").addEventListener("click", () => selectedId && injectCookies(selectedId));
  $("btnExportCookies").addEventListener("click", () => selectedId && exportCookies(selectedId));
  $("btnImportCookies").addEventListener("click", () => $("cookieImportFile").click());
  $("cookieImportFile").addEventListener("change", (e) => {
    if (e.target.files[0] && selectedId) importCookiesFile(selectedId, e.target.files[0]);
    e.target.value = "";
  });

  // Conditional row toggles
  const condTriggers = ["fp-userAgent", "fp-webglInfo", "fp-timezone", "fp-language", "fp-geolocation", "fp-deviceName", "fp-ports", "fp-webrtc", "fp-mediaDevices", "fp-screen", "fp-os", "fp-browserVersion", "fp-browser", "px-enabled", "px-networkMode"];
  for (const id of condTriggers) {
    const el = $(id);
    if (el) el.addEventListener("change", () => { updateConditionalRows(); updateUAPreview(); updateBrowserVersionOptions(); });
  }
  $("px-networkMode")?.addEventListener("change", () => {
    const mode = $("px-networkMode")?.value || "proxy";
    if (mode === "proxy") setVal("px-enabled", "true");
    if (mode === "vpn" || mode === "direct") setVal("px-enabled", "false");
    updateConditionalRows();
  });
  $("btnCaptureVpn")?.addEventListener("click", captureCurrentVpnLocation);

  // Browser version custom input — live-update UA preview
  const bvcInput = $("fp-browserVersionCustom");
  if (bvcInput) bvcInput.addEventListener("input", updateUAPreview);

  // Screen preset
  $("screenPresetSel").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    const [w, h] = v.split(",").map(Number);
    if (w && h) { $("fp-screenWidth").value = w; $("fp-screenHeight").value = h; }
  });

  // Geo preset
  $("geoPresetSel").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    const [lat, lng] = v.split(",").map(Number);
    if (lat != null) { $("fp-geoLat").value = lat; $("fp-geoLng").value = lng; }
  });

  // Proxy preset buttons
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [scheme, host, port] = btn.dataset.preset.split(",");
      setVal("px-scheme", scheme);
      setVal("px-host", host);
      setVal("px-port", port);
      setVal("px-enabled", "true");
    });
  });

  // Tabs
  document.querySelectorAll(".pm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".pm-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".pm-tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = $("tab-" + tab.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });
}

// =========================================================
// Session event binding
// =========================================================
function openBulkModal() {
  const modal = $("bulkModal");
  const errBox = $("bulkError");
  const goBtn = $("btnBulkGo");
  if (errBox) {
    errBox.textContent = "";
    errBox.style.display = "none";
  }
  if (goBtn) {
    goBtn.disabled = false;
    goBtn.textContent = "Create";
  }
  if (modal) modal.hidden = false;
}

function closeBulkModal() {
  const modal = $("bulkModal");
  const errBox = $("bulkError");
  const goBtn = $("btnBulkGo");
  if (errBox) {
    errBox.textContent = "";
    errBox.style.display = "none";
  }
  if (goBtn) {
    goBtn.disabled = false;
    goBtn.textContent = "Create";
  }
  if (modal) modal.hidden = true;
}

function bindSessionEvents() {
  $("btnOpenWindow")?.addEventListener("click", () => selectedId && openProfileWindow(selectedId));

  // Test fingerprint — opens profile pointing to a fingerprint-detection site
  $("btnTestFingerprint")?.addEventListener("click", async () => {
    if (!selectedId) { toast("Select a profile first"); return; }
    toast("Opening fingerprint test…");
    await msg("PROFILE_OPEN_WINDOW", { profileId: selectedId, url: "https://pixelscan.net/" });
  });

  // Bulk create modal
  $("btnBulkCreate")?.addEventListener("click", openBulkModal);
  $("btnBulkCancel")?.addEventListener("click", closeBulkModal);
  $("bulkModal")?.addEventListener("click", (ev) => {
    if (ev.target === $("bulkModal")) closeBulkModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("bulkModal")?.hidden) closeBulkModal();
  });
  $("btnBulkGo")?.addEventListener("click", async () => {
    const btn = $("btnBulkGo");
    const errBox = $("bulkError");
    errBox.style.display = "none";
    btn.disabled = true; btn.textContent = "Creating…";
    const count = parseInt($("bulkCount").value, 10) || 10;
    const country = $("bulkCountry").value;
    const rawNetworkMode = $("bulkProxies").value || "direct";
    const networkMode = rawNetworkMode === "1" ? "proxy" : rawNetworkMode === "0" ? "direct" : rawNetworkMode;
    const assignProxies = networkMode === "proxy";
    const deviceClass = $("bulkDeviceClass")?.value || "desktop";
    const browserApp = $("bulkBrowserApp")?.value || "random";
    const r = await msg("PROFILE_BULK_CREATE", { count, country, assignProxies, networkMode, deviceClass, browserApp });
    btn.disabled = false; btn.textContent = "Create";
    if (!r.ok) {
      errBox.textContent = "Error: " + (r.error || "unknown — check Desktop/privacy-shield-error.txt");
      errBox.style.display = "block";
      btn.disabled = false; btn.textContent = "Create";
      return;
    }
    closeBulkModal();
    await loadProfiles();
    renderList();
    toast(`Created ${r.created} profiles`);
  });
  $("btnSaveSession")?.addEventListener("click", () => selectedId && saveSession(selectedId));
  $("btnCloseWindow")?.addEventListener("click", () => selectedId && closeProfileWindow(selectedId));
  $("btnClearSession")?.addEventListener("click", () => selectedId && clearSession(selectedId));
  $("btnClearBrowserData")?.addEventListener("click", () => selectedId && clearBrowserData(selectedId));
  document.querySelectorAll(".pm-country-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyCountryPreset(btn.dataset.country));
  });

  // Proxy picker
  $("btnApplyCountryProxy")?.addEventListener("click", applySelectedLibraryProxy);
  $("btnGenerateCountryProxy")?.addEventListener("click", () => {
    if (!selectedCountry) { toast("Choose a country first"); return; }
    generatePrivateProxyForCountry(selectedCountry);
  });
  $("btnAddCountryProxy")?.addEventListener("click", () => {
    if (selectedCountry) setVal("vps-country", selectedCountry);
    $("vpsProxyForm")?.scrollIntoView({ behavior: "smooth" });
    $("vps-host")?.focus();
  });

  // Proxy library form
  $("btnSaveProxyProvider")?.addEventListener("click", saveProxyProviderSettings);
  $("btnVpsTestSsh")?.addEventListener("click", testVpsSsh);
  $("btnVpsInstall")?.addEventListener("click", installVpsProxy);
  $("btnVpsClear")?.addEventListener("click", resetVpsForm);
  $("vpsProxyList")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-vps-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.vpsAction === "test") await testVpsProxy(id);
    else if (btn.dataset.vpsAction === "edit") editVpsProxy(id);
    else if (btn.dataset.vpsAction === "del") await deleteVpsProxy(id);
  });
  $("btnSaveProxyLib")?.addEventListener("click", saveProxyLibEntry);
  $("btnCancelProxyLib")?.addEventListener("click", resetProxyLibForm);
  $("btnToggleProxyLib")?.addEventListener("click", () => {
    const panel = $("proxyLibPanel");
    if (panel) panel.hidden = !panel.hidden;
  });

  // Android cloud phones
  $("btnSaveCloudProvider")?.addEventListener("click", saveCloudPhoneProviderSettings);
  $("btnSaveCloudPhone")?.addEventListener("click", saveCloudPhoneRecord);
  $("btnResetCloudPhone")?.addEventListener("click", resetCloudPhoneForm);
  $("cloudPhoneList")?.addEventListener("click", handleCloudPhoneListClick);

  // Auto-detect from own server
  $("btnDetectProxy")?.addEventListener("click", autoDetectProxy);
}

// =========================================================
// Window / Session management
// =========================================================

// Map of { profileId: windowId } for currently open profile windows
let openWindows = {};

async function refreshOpenWindows() {
  const r = await msg("PROFILE_GET_WINDOWS");
  openWindows = r.windows || {};
}

function isProfileRunning(profileId) {
  return profileId in openWindows;
}

async function openProfileWindow(profileId) {
  const btn = $("btnOpenWindow");
  if (btn) { btn.textContent = "Starting…"; btn.disabled = true; }
  const r = await msg("PROFILE_OPEN_WINDOW", { profileId });
  if (!r.ok) {
    toast("Failed to start: " + (r.error || "unknown"));
  } else if (r.preview) {
    toast("Preview window opened. Run the desktop app for real isolated browsing.");
  } else if (r.existing) {
    toast("Already running — focused");
  } else {
    toast("Started — browser is now running");
  }
  await refreshOpenWindows();
  renderList();
  updateSessionTab();
  if (btn) { btn.textContent = "Start"; btn.disabled = false; }
}

async function stopProfile(profileId) {
  const r = await msg("PROFILE_CLOSE_WINDOW", { profileId });
  if (!r.ok) { toast("Stop failed: " + (r.error || "no open window")); return; }
  toast("Stopped — session saved");
  await refreshOpenWindows();
  renderList();
  updateSessionTab();
}

async function saveSession(profileId) {
  const r = await msg("PROFILE_SAVE_SESSION", { profileId });
  if (!r.ok) { toast("Save failed: " + (r.error || "no open window")); return; }
  await loadProfiles();
  toast(`Session saved — ${r.count} tab(s)`);
  updateSessionTab();
}

async function closeProfileWindow(profileId) {
  if (!confirm("Close this profile's window? Session will be saved first.")) return;
  const r = await msg("PROFILE_CLOSE_WINDOW", { profileId });
  if (!r.ok) { toast("Close failed: " + (r.error || "unknown")); return; }
  await refreshOpenWindows();
  await loadProfiles();
  renderList();
  updateSessionTab();
  toast("Window closed and session saved");
}

async function clearSession(profileId) {
  if (!confirm("Clear the saved session? This will forget all saved tabs.")) return;
  await msg("PROFILE_UPDATE", { id: profileId, data: { session: null } });
  await loadProfiles();
  updateSessionTab();
  toast("Session cleared");
}

async function clearBrowserData(profileId) {
  if (!confirm("Clear cookies, storage, cache, auth, and saved tabs for this profile?")) return;
  const r = await msg("PROFILE_CLEAR_BROWSER_DATA", { profileId });
  if (!r.ok) {
    toast("Clear failed: " + (r.error || "unknown"));
    return;
  }
  await loadProfiles();
  updateSessionTab();
  updateCookiePanel(profiles.find((p) => p.id === profileId) || {});
  toast("Profile browser data cleared");
}

function updateSessionTab() {
  const profileId = selectedId;
  const p = profiles.find((p) => p.id === profileId);
  if (!p) return;

  const running = isProfileRunning(profileId);
  const dot = $("windowDot");
  const statusText = $("windowStatusText");
  const openBtn = $("btnOpenWindow");
  const saveBtn = $("btnSaveSession");
  const closeBtn = $("btnCloseWindow");
  const hint = $("windowHint");

  if (dot) {
    dot.className = "pw-dot " + (running ? "running" : "closed");
  }
  if (statusText) statusText.textContent = running ? "Window is running" : "Window closed";
  if (openBtn) openBtn.textContent = running ? "Bring to front" : "Open in new window";
  if (saveBtn) saveBtn.hidden = !running;
  if (closeBtn) closeBtn.hidden = !running;
  if (hint) {
    hint.innerHTML = running
      ? "Profile window is open. Use <b>Save session</b> to snapshot your current tabs so they restore next time."
      : "Click <b>Open in new window</b> to launch a dedicated browser window with this profile's proxy and fingerprint applied.";
  }

  // Session tabs list
  renderSessionTabs(p);
}

function renderSessionTabs(p) {
  const list = $("sessionTabList");
  const meta = $("sessionMeta");
  const session = p.session;

  if (!session || !session.tabs || !session.tabs.length) {
    if (list) list.innerHTML = '<div class="pm-list-empty">No session saved yet.<br>Open a window, browse, then click <b>Save session</b>.</div>';
    if (meta) meta.textContent = "";
    return;
  }

  const savedAt = new Date(session.lastSaved);
  if (meta) meta.textContent = `${session.tabs.length} tab(s) saved · Last saved ${savedAt.toLocaleString()}`;

  if (!list) return;
  list.innerHTML = "";
  for (const t of session.tabs) {
    let domain = "";
    try { domain = new URL(t.url).hostname; } catch (_) {}
    const item = document.createElement("div");
    item.className = "pm-session-item";
    item.innerHTML = `
      <img class="pm-session-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16" onerror="this.style.display='none'" />
      <div style="flex:1;min-width:0;">
        <div class="pm-session-title">${escHtml(t.title || t.url)}</div>
        <div class="pm-session-url">${escHtml(t.url)}</div>
      </div>
      ${t.active ? '<span class="chip status-active" style="font-size:9px;">Active</span>' : ""}
    `;
    list.appendChild(item);
  }
}

// =========================================================
// Country presets — auto-fill timezone, language, geo, UA
// =========================================================
const COUNTRY_PRESETS = {
  us: { name: "United States", timezone: "America/New_York", offset: 300, language: "en-US", lat: 40.7128, lng: -74.0060, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "New York", state: "New York", ispName: "Comcast Cable Communications", ispAsn: "7922", ispOrg: "Comcast Cable" },
  gb: { name: "United Kingdom", timezone: "Europe/London", offset: 0, language: "en-GB", lat: 51.5074, lng: -0.1278, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "London", state: "England", ispName: "BT Group plc", ispAsn: "2856", ispOrg: "BT Group plc" },
  de: { name: "Germany", timezone: "Europe/Berlin", offset: -60, language: "de-DE", lat: 52.5200, lng: 13.4050, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Berlin", state: "Berlin", ispName: "Deutsche Telekom AG", ispAsn: "3320", ispOrg: "Deutsche Telekom AG" },
  nl: { name: "Netherlands", timezone: "Europe/Amsterdam", offset: -60, language: "nl-NL", lat: 52.3676, lng: 4.9041, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Amsterdam", state: "North Holland", ispName: "KPN Netherlands", ispAsn: "1136", ispOrg: "KPN Netherlands" },
  fr: { name: "France", timezone: "Europe/Paris", offset: -60, language: "fr-FR", lat: 48.8566, lng: 2.3522, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Paris", state: "Ile-de-France", ispName: "Orange S.A.", ispAsn: "3215", ispOrg: "Orange S.A." },
  ch: { name: "Switzerland", timezone: "Europe/Zurich", offset: -60, language: "de-DE", lat: 47.3769, lng: 8.5417, os: "windows", screenWidth: 2560, screenHeight: 1440, browserVersion: "136", city: "Zurich", state: "Zurich", ispName: "Swisscom AG", ispAsn: "3303", ispOrg: "Swisscom AG" },
  se: { name: "Sweden", timezone: "Europe/Stockholm", offset: -60, language: "sv-SE", lat: 59.3293, lng: 18.0686, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Stockholm", state: "Stockholm", ispName: "Telia Company AB", ispAsn: "1257", ispOrg: "Telia Company AB" },
  ca: { name: "Canada", timezone: "America/Toronto", offset: 300, language: "en-CA", lat: 43.6532, lng: -79.3832, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Toronto", state: "Ontario", ispName: "Rogers Communications Inc.", ispAsn: "812", ispOrg: "Rogers Communications" },
  au: { name: "Australia", timezone: "Australia/Sydney", offset: -600, language: "en-AU", lat: -33.8688, lng: 151.2093, os: "macos", screenWidth: 1440, screenHeight: 900, browserVersion: "136", city: "Sydney", state: "New South Wales", ispName: "Telstra Corporation Ltd", ispAsn: "1221", ispOrg: "Telstra Corporation" },
  jp: { name: "Japan", timezone: "Asia/Tokyo", offset: -540, language: "ja-JP", lat: 35.6762, lng: 139.6503, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Tokyo", state: "Tokyo", ispName: "NTT Communications Corporation", ispAsn: "2914", ispOrg: "NTT Communications" },
  sg: { name: "Singapore", timezone: "Asia/Singapore", offset: -480, language: "en-SG", lat: 1.3521, lng: 103.8198, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Singapore", state: "Singapore", ispName: "Singtel Fibre Broadband", ispAsn: "9506", ispOrg: "Singtel Fibre" },
  br: { name: "Brazil", timezone: "America/Sao_Paulo", offset: 180, language: "pt-BR", lat: -23.5505, lng: -46.6333, os: "windows", screenWidth: 1366, screenHeight: 768, browserVersion: "136", city: "Sao Paulo", state: "Sao Paulo", ispName: "Claro NXT Telecomunicacoes Ltda", ispAsn: "28573", ispOrg: "Claro NXT Telecomunicacoes" },
  in: { name: "India", timezone: "Asia/Kolkata", offset: -330, language: "hi-IN", lat: 19.0760, lng: 72.8777, os: "windows", screenWidth: 1366, screenHeight: 768, browserVersion: "136", city: "Mumbai", state: "Maharashtra", ispName: "Reliance Jio Infocomm Limited", ispAsn: "55836", ispOrg: "Reliance Jio Infocomm" },
  ae: { name: "UAE (Dubai)", timezone: "Asia/Dubai", offset: -240, language: "ar-AE", lat: 25.2048, lng: 55.2708, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Dubai", state: "Dubai", ispName: "Emirates Integrated Telecom (du)", ispAsn: "15802", ispOrg: "Emirates Integrated Telecom" },
  ru: { name: "Russia", timezone: "Europe/Moscow", offset: -180, language: "ru-RU", lat: 55.7558, lng: 37.6173, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Moscow", state: "Moscow Oblast", ispName: "Rostelecom", ispAsn: "12389", ispOrg: "Rostelecom" },
  tr: { name: "Turkey", timezone: "Europe/Istanbul", offset: -180, language: "tr-TR", lat: 41.0082, lng: 28.9784, os: "windows", screenWidth: 1920, screenHeight: 1080, browserVersion: "136", city: "Istanbul", state: "Istanbul", ispName: "Turk Telekomunikasyon A.S.", ispAsn: "9121", ispOrg: "Turk Telekomunikasyon" },
  ng: { name: "Nigeria (Lagos)", timezone: "Africa/Lagos", offset: -60, language: "en-US", lat: 6.5244, lng: 3.3792, os: "linux", screenWidth: 1366, screenHeight: 768, browserVersion: "148", city: "Lagos", state: "Lagos State", ispName: "Airtel Networks Limited", ispAsn: "36873", ispOrg: "Airtel Networks Limited" }
};

function applyGeneratedIdentityToForm(data) {
  const fp = data?.fingerprint || {};
  if (!fp) return;

  currentFingerprintMeta = {
    countryCode: fp.countryCode || "",
    country: fp.country || "",
    continent: fp.continent || "",
    organization: fp.organization || fp.ispOrg || "",
    ip: fp.ip || "",
    domain: fp.domain || "",
    hardwareId: fp.hardwareId || "",
    fontProfile: fp.fontProfile || data.os || "windows",
    installedFonts: Array.isArray(fp.installedFonts) ? fp.installedFonts : [],
    colorDepth: fp.colorDepth || 24,
    pixelDepth: fp.pixelDepth || 24,
    devicePixelRatio: fp.devicePixelRatio || 1,
    deviceClass: fp.deviceClass || (data.os === "android" ? "mobile" : "desktop"),
    mobileModel: fp.mobileModel || "",
    mobileManufacturer: fp.mobileManufacturer || "",
    platformVersion: fp.platformVersion || "",
    androidBuild: fp.androidBuild || "",
    architecture: fp.architecture || (data.os === "android" ? "arm" : "x86"),
    bitness: fp.bitness || "64",
    maxTouchPoints: fp.maxTouchPoints || (data.os === "android" ? 5 : 0),
    screenOrientation: fp.screenOrientation || (data.os === "android" ? "portrait-primary" : "landscape-primary"),
    touchEmulation: fp.touchEmulation ?? (data.os === "android"),
    sensorEmulation: fp.sensorEmulation ?? (data.os === "android"),
    viewportMobile: fp.viewportMobile ?? (data.os === "android"),
    pointerType: fp.pointerType || (data.os === "android" ? "coarse" : "fine"),
    hoverType: fp.hoverType || (data.os === "android" ? "none" : "hover"),
    deviceMotion: fp.deviceMotion || null,
    deviceOrientation: fp.deviceOrientation || null,
    connectionType: fp.connectionType || "wifi",
    downlink: fp.downlink || 10,
    rtt: fp.rtt || 50
  };

  if (creatingNew || !$("fp-name")?.value.trim() || /^New Profile\b/.test($("fp-name")?.value || "")) {
    setVal("fp-name", data.name || $("fp-name")?.value || "New Profile");
  }
  setVal("fp-os", data.os || "windows");
  setVal("fp-browserApp", data.browserApp || fp.browser || "chrome");
  setVal("fp-browser", fp.browser || data.browserApp || "chrome");
  updateBrowserVersionOptions();

  setVal("fp-userAgent", fp.userAgent || "auto");
  setVal("fp-userAgentValue", fp.userAgentValue || "");
  setVal("fp-timezone", "manual");
  setVal("fp-timezoneValue", fp.timezoneValue || "UTC");
  setVal("fp-timezoneOffset", fp.timezoneOffset ?? 0);
  setVal("fp-language", "manual");
  setVal("fp-languageValue", fp.languageValue || "en-US");
  setVal("fp-geolocation", "manual");
  setVal("fp-geoLat", fp.geoLat ?? 0);
  setVal("fp-geoLng", fp.geoLng ?? 0);
  setVal("fp-geoAccuracy", fp.geoAccuracy ?? 50);
  setVal("fp-screen", "manual");
  setVal("fp-screenWidth", fp.screenWidth || 1920);
  setVal("fp-screenHeight", fp.screenHeight || 1080);
  setVal("fp-cpuCores", "manual");
  setVal("fp-cpuCoresValue", fp.cpuCoresValue || 4);
  setVal("fp-ram", "manual");
  setVal("fp-ramValue", fp.ramValue || 8);
  setVal("fp-webgl", fp.webgl || "noise");
  setVal("fp-webglInfo", "manual");
  setVal("fp-webglVendor", fp.webglVendor || "");
  setVal("fp-webglRenderer", fp.webglRenderer || "");
  setVal("fp-webgpu", String(Boolean(fp.webgpu)));
  setVal("fp-audio", fp.audio || "noise");
  setVal("fp-clientRects", fp.clientRects || "real");
  setVal("fp-mediaDevices", fp.mediaDevices || "real");
  setVal("fp-cameras", fp.cameras ?? 1);
  setVal("fp-microphones", fp.microphones ?? 1);
  setVal("fp-speakers", fp.speakers ?? 1);
  setVal("fp-fonts", fp.fonts || "real");
  setVal("fp-deviceName", "manual");
  setVal("fp-deviceNameValue", fp.deviceNameValue || randDeviceName());
  setVal("fp-ports", fp.ports || "block");
  setVal("fp-blockedPorts", (fp.blockedPorts || [3389, 5938]).join(", "));
  setVal("fp-doNotTrack", String(Boolean(fp.doNotTrack)));
  setVal("fp-webrtc", fp.webrtc || "altered");
  setVal("fp-webrtcIP", fp.webrtcIP || "");
  setVal("fp-blockCookies", String(Boolean(fp.blockCookies)));
  setVal("fp-blockStorage", String(Boolean(fp.blockStorage)));
  setVal("fp-city", fp.city || "");
  setVal("fp-state", fp.state || "");
  setVal("fp-ispName", fp.ispName || "");
  setVal("fp-ispAsn", fp.ispAsn || "");
  setVal("fp-ispOrg", fp.ispOrg || fp.organization || "");
  setBrowserVersionValue(fp.browserVersion || "148");

  updateConditionalRows();
  updateUAPreview();
}

async function applyCountryPreset(countryCode) {
  const p = COUNTRY_PRESETS[countryCode];
  if (!p) return;

  // Highlight selected button
  document.querySelectorAll(".pm-country-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.country === countryCode);
  });

  // Show confirmation
  const applied = $("countryApplied");
  if (applied) {
    applied.hidden = false;
    applied.textContent = `Generating a fresh ${p.name} device, browser, location, and fingerprint...`;
  }

  const deviceClass = $("countryDeviceClass")?.value || "desktop";
  const r = await msg("PROFILE_COUNTRY_IDENTITY", { country: countryCode, index: profiles.length + 1, deviceClass });
  if (!r.ok || !r.data) {
    if (applied) applied.textContent = r.error || `Could not generate ${p.name} identity.`;
    toast("Identity generation failed");
    return;
  }

  applyGeneratedIdentityToForm(r.data);

  const fp = r.data.fingerprint || {};
  const city = fp.city ? `${fp.city}, ` : "";
  if (applied) applied.textContent = `Applied fresh ${city}${fp.country || p.name} identity. Looking for a matching VPS proxy.`;

  // Show proxy picker for this country
  selectedCountry = countryCode;
  renderCountryProxies(countryCode, p.name);
  toast(`New ${p.name} identity applied`);
  generatePrivateProxyForCountry(countryCode, { auto: true }).catch((err) => {
    setPrivateProxyStatus(String(err.message || err), "err");
  });
}

// =========================================================
// Proxy Library
// =========================================================

const COUNTRY_NAMES = {
  us:"United States",gb:"United Kingdom",de:"Germany",nl:"Netherlands",fr:"France",
  ch:"Switzerland",se:"Sweden",ca:"Canada",au:"Australia",jp:"Japan",sg:"Singapore",
  br:"Brazil",in:"India",ae:"UAE (Dubai)",ru:"Russia",tr:"Turkey",ng:"Nigeria","":" Any"
};

async function loadProxyProviderConfig() {
  const r = await msg("PROXY_PROVIDER_GET");
  if (r.ok && r.config) proxyProviderConfig = r.config;
}

function renderProxyProviderConfig() {
  setVal("proxyProviderEndpoint", proxyProviderConfig.endpoint || "");
  setVal("proxyProviderAuthMode", proxyProviderConfig.authMode || "bearer");
  const token = $("proxyProviderToken");
  if (token) {
    token.value = "";
    token.placeholder = proxyProviderConfig.hasToken ? "Token saved - leave blank to keep" : "API token";
  }
  setPrivateProxyStatus("Country buttons use installed VPS proxies only. Add and install one VPS per country you need.", "info");
}

function setPrivateProxyStatus(text, state = "info") {
  const el = $("privateProxyStatus");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "pm-private-proxy-status " + state;
}

function upsertProxyEntry(entry) {
  if (!entry || !entry.id) return;
  const idx = proxyLibrary.findIndex((e) => e.id === entry.id);
  if (idx === -1) proxyLibrary.push(entry);
  else proxyLibrary[idx] = { ...proxyLibrary[idx], ...entry };
}

function privateVpsProxies() {
  return proxyLibrary.filter((e) => e && e.host && e.port && e.private !== false && e.source === "vps");
}

function upsertVpsRecord(record) {
  if (!record || !record.id) return;
  const idx = vpsProxyRecords.findIndex((item) => item.id === record.id);
  if (idx === -1) vpsProxyRecords.push(record);
  else vpsProxyRecords[idx] = { ...vpsProxyRecords[idx], ...record };
}

async function loadVpsProxyRecords() {
  const r = await msg("VPS_PROXY_LIST");
  vpsProxyRecords = r.records || [];
}

function setVpsStatus(text, state = "info") {
  const el = $("vpsStatus");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = state === "ok" ? "var(--green)" : state === "err" ? "var(--red)" : "var(--muted)";
}

function collectVpsForm() {
  const host = $("vps-host")?.value.trim();
  const country = $("vps-country")?.value || "";
  const username = $("vps-ssh-user")?.value.trim() || "root";
  const password = $("vps-ssh-password")?.value || "";
  const privateKey = $("vps-ssh-key")?.value.trim() || "";
  if (!host) throw new Error("VPS host is required");
  if (!country) throw new Error("Country is required");
  if (!username) throw new Error("SSH user is required");
  if (!password && !privateKey) throw new Error("Enter an SSH password or private key");

  const installBtn = $("btnVpsInstall");
  return {
    id: installBtn?.dataset.editId || "",
    label: $("vps-label")?.value.trim() || `${COUNTRY_NAMES[country] || country.toUpperCase()} VPS`,
    country,
    host,
    sshPort: Number($("vps-ssh-port")?.value) || 22,
    username,
    password,
    privateKey,
    proxyPort: Number($("vps-proxy-port")?.value) || 1080,
    httpPort: Number($("vps-http-port")?.value) || 1081,
    infoPort: Number($("vps-info-port")?.value) || 8888
  };
}

function resetVpsForm() {
  ["vps-label", "vps-host", "vps-ssh-password", "vps-ssh-key"].forEach((id) => setVal(id, ""));
  setVal("vps-country", selectedCountry || "us");
  setVal("vps-ssh-port", "22");
  setVal("vps-ssh-user", "root");
  setVal("vps-proxy-port", "1080");
  setVal("vps-http-port", "1081");
  setVal("vps-info-port", "8888");
  const installBtn = $("btnVpsInstall");
  if (installBtn) delete installBtn.dataset.editId;
  setVpsStatus("");
}

function renderVpsProxyRecords() {
  const list = $("vpsProxyList");
  if (!list) return;
  if (!vpsProxyRecords.length) {
    list.innerHTML = '<div class="pm-list-empty">No VPS proxies installed yet.</div>';
    return;
  }

  list.innerHTML = vpsProxyRecords.map((record) => {
    const proxy = record.proxy || {};
    const ssh = record.ssh || {};
    const label = escapeHtml(record.label || proxy.label || record.host || "VPS Proxy");
    const country = escapeHtml(COUNTRY_NAMES[record.country] || record.country || "Any");
    const host = escapeHtml(record.host || ssh.host || proxy.host || "");
    const port = escapeHtml(proxy.port || record.proxyPort || "");
    const status = escapeHtml(record.installedAt ? `installed ${new Date(record.installedAt).toLocaleString()}` : "saved");
    return `
      <div class="pm-vps-item" data-vps-id="${escapeHtml(record.id)}">
        <div class="pm-proxy-lib-item-main">
          <span class="pm-proxy-lib-label">${label}</span>
          <span class="pm-proxy-lib-meta">${country} - ${host}:${port} - VPS private</span>
          <span class="pm-proxy-lib-status" id="vps-status-${escapeHtml(record.id)}">${status}</span>
        </div>
        <div class="pm-proxy-lib-actions">
          <button class="pm-btn-xs" data-vps-action="test" data-id="${escapeHtml(record.id)}">Test</button>
          <button class="pm-btn-xs" data-vps-action="edit" data-id="${escapeHtml(record.id)}">Edit</button>
          <button class="pm-btn-xs danger" data-vps-action="del" data-id="${escapeHtml(record.id)}">Del</button>
        </div>
      </div>
    `;
  }).join("");
}

async function testVpsSsh() {
  let data;
  try { data = collectVpsForm(); } catch (err) { setVpsStatus(err.message, "err"); return; }

  const btn = $("btnVpsTestSsh");
  if (btn) { btn.disabled = true; btn.textContent = "Testing..."; }
  setVpsStatus("Connecting to VPS SSH...", "info");
  const r = await msg("VPS_PROXY_TEST_SSH", data);
  if (r.ok) {
    setVpsStatus(`SSH ok: ${r.server || data.host}`, "ok");
    toast("SSH connection works");
  } else {
    setVpsStatus(r.error || "SSH failed", "err");
    toast("SSH connection failed");
  }
  if (btn) { btn.disabled = false; btn.textContent = "Test SSH"; }
}

async function installVpsProxy() {
  let data;
  try { data = collectVpsForm(); } catch (err) { setVpsStatus(err.message, "err"); return; }

  const btn = $("btnVpsInstall");
  if (btn) { btn.disabled = true; btn.textContent = "Installing..."; }
  setVpsStatus("Installing proxy service on the VPS...", "info");
  const r = await msg("VPS_PROXY_INSTALL", data);
  if (r.ok) {
    upsertVpsRecord(r.record);
    upsertProxyEntry(r.proxy);
    renderVpsProxyRecords();
    renderProxyLibrary();
    renderCountryProxies(selectedCountry, selectedCountry ? COUNTRY_PRESETS[selectedCountry]?.name : null);
    resetVpsForm();
    setVpsStatus(`Installed: ${r.proxy.host}:${r.proxy.port}`, "ok");
    toast("VPS proxy installed");
  } else {
    setVpsStatus(r.error || "Install failed", "err");
    toast("VPS install failed");
  }
  if (btn) { btn.disabled = false; btn.textContent = "Install / Update VPS Proxy"; }
}

async function testVpsProxy(id) {
  const statusEl = document.getElementById(`vps-status-${id}`);
  if (statusEl) { statusEl.textContent = "testing..."; statusEl.style.color = "var(--muted)"; }
  const r = await msg("VPS_PROXY_TEST", { id });
  if (r.ok) {
    const ip = r.proxy?.ip || r.info?.hostname || "online";
    if (statusEl) { statusEl.textContent = `online - ${ip}`; statusEl.style.color = "var(--green)"; }
    toast("VPS proxy is online");
  } else {
    if (statusEl) { statusEl.textContent = r.error || "unreachable"; statusEl.style.color = "var(--red)"; }
    toast("VPS proxy test failed");
  }
}

async function deleteVpsProxy(id) {
  if (!id || !confirm("Delete this VPS proxy from the app? The service on the VPS will keep running until you remove it from the server.")) return;
  const r = await msg("VPS_PROXY_DELETE", { id });
  if (!r.ok) {
    toast(r.error || "Delete failed");
    return;
  }
  vpsProxyRecords = vpsProxyRecords.filter((record) => record.id !== id);
  proxyLibrary = proxyLibrary.filter((entry) => entry.vpsId !== id);
  renderVpsProxyRecords();
  renderProxyLibrary();
  renderCountryProxies(selectedCountry, selectedCountry ? COUNTRY_PRESETS[selectedCountry]?.name : null);
  toast("VPS proxy deleted");
}

function editVpsProxy(id) {
  const record = vpsProxyRecords.find((item) => item.id === id);
  if (!record) return;
  const proxy = record.proxy || {};
  const ssh = record.ssh || {};
  setVal("vps-label", record.label || proxy.label || "");
  setVal("vps-country", record.country || proxy.country || "us");
  setVal("vps-host", record.host || ssh.host || proxy.host || "");
  setVal("vps-ssh-port", ssh.port || 22);
  setVal("vps-ssh-user", ssh.username || "root");
  setVal("vps-ssh-password", "");
  setVal("vps-ssh-key", "");
  setVal("vps-proxy-port", proxy.port || 1080);
  setVal("vps-http-port", proxy.httpPort || 1081);
  setVal("vps-info-port", proxy.infoPort || 8888);
  const installBtn = $("btnVpsInstall");
  if (installBtn) installBtn.dataset.editId = id;
  setVpsStatus("Loaded VPS settings. Re-enter password or key before installing.", "info");
  $("vpsProxyForm")?.scrollIntoView({ behavior: "smooth" });
}

function renderCountryProxies(countryCode, countryName) {
  const label  = $("countryProxyLabel");
  const sel    = $("countryProxySel");
  const empty  = $("countryProxyEmpty");
  if (!sel) return;

  // Filter: country auto-apply only uses VPS proxies installed by this app.
  const vpsMatches = privateVpsProxies();
  const matches = countryCode
    ? vpsMatches.filter((e) => e.country === countryCode || e.country === "")
    : vpsMatches;

  if (label) {
    label.textContent = countryCode
      ? `for ${countryName || COUNTRY_NAMES[countryCode] || countryCode.toUpperCase()}`
      : "";
  }

  sel.innerHTML = "";
  if (matches.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = countryCode
      ? `No VPS proxy for ${COUNTRY_NAMES[countryCode] || countryCode} - setup needed`
      : "No VPS proxies installed yet";
    sel.appendChild(o);
    if (empty) {
      empty.hidden = false;
      empty.textContent = countryCode
        ? `Setup needed: add and install a VPS proxy for ${COUNTRY_NAMES[countryCode] || countryCode}.`
        : "Add and install a VPS proxy below before using country proxy buttons.";
    }
  } else {
    if (empty) empty.hidden = true;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "- choose a VPS proxy -";
    sel.appendChild(placeholder);
    for (const e of matches) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = `${e.label || "Unnamed"} - ${e.scheme.toUpperCase()} ${e.host}:${e.port}${e.ispName ? " | " + e.ispName : ""}`;
      sel.appendChild(o);
    }
  }
}

async function fillProxyFromEntry(entry, opts = {}) {
  if (!entry) return;
  const px = {
    networkMode: "proxy",
    enabled: true,
    scheme: entry.scheme || "socks5",
    host: entry.host || "",
    port: entry.port || 1080,
    username: entry.username || "",
    password: entry.password || "",
    rotationUrl: entry.rotationUrl || "",
    bypassList: ["localhost", "127.0.0.1"]
  };

  setVal("px-networkMode", px.networkMode);
  setVal("px-enabled", "true");
  setVal("px-scheme", px.scheme);
  setVal("px-host", px.host);
  setVal("px-port", px.port);
  setVal("px-username", px.username);
  setVal("px-password", px.password);
  setVal("px-rotationUrl", px.rotationUrl);
  setVal("px-bypassList", px.bypassList.join(", "));

  if (entry.ispName) setVal("fp-ispName", entry.ispName);
  if (entry.ispAsn)  setVal("fp-ispAsn",  entry.ispAsn);
  if (entry.ispOrg)  setVal("fp-ispOrg",  entry.ispOrg);
  if (entry.city)    setVal("fp-city",     entry.city);
  currentFingerprintMeta = {
    ...currentFingerprintMeta,
    countryCode: entry.country || currentFingerprintMeta.countryCode || selectedCountry || "",
    country: COUNTRY_NAMES[entry.country] || currentFingerprintMeta.country || "",
    organization: entry.ispOrg || entry.ispName || currentFingerprintMeta.organization || "",
    ip: entry.host || currentFingerprintMeta.ip || ""
  };

  if (opts.persist !== false && selectedId && !creatingNew) {
    await msg("PROFILE_UPDATE", { id: selectedId, data: collectForm() });
    await loadProfiles();
    renderList();
  }

  if (opts.switchTab) document.querySelector('[data-tab="proxy"]')?.click();
}

async function applySelectedLibraryProxy() {
  const sel = $("countryProxySel");
  if (!sel || !sel.value) return;
  const entry = proxyLibrary.find((e) => e.id === sel.value);
  if (!entry) return;
  await fillProxyFromEntry(entry, { switchTab: true });
  toast(`Proxy applied: ${entry.label || entry.host}`);
}

async function generatePrivateProxyForCountry(countryCode, opts = {}) {
  if (!countryCode) return;
  const btn = $("btnGenerateCountryProxy");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking...";
  }
  setPrivateProxyStatus(`Looking for installed VPS proxy for ${COUNTRY_NAMES[countryCode] || countryCode.toUpperCase()}...`, "info");

  const r = await msg("PROXY_GENERATE_PRIVATE", { country: countryCode, profileId: selectedId });
  if (!r.ok) {
    setPrivateProxyStatus(r.error || "No private proxy available for this country.", "err");
    toast("No private proxy available");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Use VPS proxy";
    }
    return;
  }

  upsertProxyEntry(r.entry);
  renderProxyLibrary();
  renderCountryProxies(countryCode, COUNTRY_PRESETS[countryCode]?.name);
  if ($("countryProxySel")) $("countryProxySel").value = r.entry.id || "";
  await fillProxyFromEntry(r.entry, { switchTab: !opts.auto });

  const warning = r.warning ? ` (${r.warning})` : "";
  setPrivateProxyStatus(`VPS proxy ready: ${r.entry.host}:${r.entry.port}${warning}`, r.warning ? "warn" : "ok");
  toast(`VPS ${COUNTRY_NAMES[countryCode] || countryCode.toUpperCase()} proxy applied`);

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Use VPS proxy";
  }
}

async function saveProxyProviderSettings() {
  const btn = $("btnSaveProxyProvider");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  const r = await msg("PROXY_PROVIDER_SAVE", {
    config: {
      endpoint: $("proxyProviderEndpoint")?.value.trim() || "",
      token: $("proxyProviderToken")?.value.trim() || "",
      authMode: $("proxyProviderAuthMode")?.value || "bearer"
    }
  });

  if (r.ok) {
    proxyProviderConfig = r.config;
    renderProxyProviderConfig();
    toast("Private proxy provider saved");
  } else {
    setPrivateProxyStatus(r.error || "Could not save private provider", "err");
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Save provider";
  }
}

function renderProxyLibrary() {
  const list = $("proxyLibList");
  if (!list) return;
  if (!proxyLibrary.length) {
    list.innerHTML = '<div class="pm-list-empty">No proxies in library yet.</div>';
    return;
  }
  list.innerHTML = proxyLibrary.map((e) => `
    <div class="pm-proxy-lib-item" data-id="${e.id}">
      <div class="pm-proxy-lib-item-main">
        <span class="pm-proxy-lib-label">${e.label || "Unnamed"}</span>
        <span class="pm-proxy-lib-meta">${COUNTRY_NAMES[e.country] || e.country || "Any"} · ${e.scheme.toUpperCase()} · ${e.host}:${e.port}</span>
        ${e.ispName ? `<span class="pm-proxy-lib-isp">${e.ispName}${e.ispAsn ? " AS" + e.ispAsn : ""}</span>` : ""}
        <span class="pm-proxy-lib-status" id="plib-status-${e.id}"></span>
      </div>
      <div class="pm-proxy-lib-actions">
        <button class="pm-btn-xs" data-action="test" data-id="${e.id}">Test</button>
        <button class="pm-btn-xs" data-action="edit" data-id="${e.id}">Edit</button>
        <button class="pm-btn-xs danger" data-action="del" data-id="${e.id}">Del</button>
      </div>
    </div>
  `).join("");

  list.onclick = async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "test") {
      const e = proxyLibrary.find((x) => x.id === id);
      if (!e) return;
      await testProxyEntry(e);
    } else if (btn.dataset.action === "del") {
      const e = proxyLibrary.find((x) => x.id === id);
      if (e?.source === "vps" && e.vpsId) {
        await deleteVpsProxy(e.vpsId);
      } else {
        await msg("PROXY_LIB_DELETE", { id });
        proxyLibrary = proxyLibrary.filter((entry) => entry.id !== id);
        renderProxyLibrary();
        renderCountryProxies(selectedCountry, selectedCountry ? COUNTRY_PRESETS[selectedCountry]?.name : null);
        toast("Proxy deleted");
      }
    } else if (btn.dataset.action === "edit") {
      const e = proxyLibrary.find((x) => x.id === id);
      if (!e) return;
      if (e.source === "vps") {
        toast("Edit VPS proxies from the VPS installer");
        if (e.vpsId) editVpsProxy(e.vpsId);
        return;
      }
      setVal("plib-label",   e.label || "");
      setVal("plib-country", e.country || "");
      setVal("plib-scheme",  e.scheme || "socks5");
      setVal("plib-host",    e.host || "");
      setVal("plib-port",    e.port || 1080);
      setVal("plib-username",e.username || "");
      setVal("plib-password",e.password || "");
      setVal("plib-ispName", e.ispName || "");
      setVal("plib-asn",     e.ispAsn || "");
      setVal("plib-city",    e.city || "");
      const saveBtn = $("btnSaveProxyLib");
      if (saveBtn) saveBtn.dataset.editId = id;
      const cancelBtn = $("btnCancelProxyLib");
      if (cancelBtn) cancelBtn.hidden = false;
      $("proxyLibForm")?.scrollIntoView({ behavior: "smooth" });
    }
  };
}

async function saveProxyLibEntry() {
  const host = $("plib-host")?.value.trim();
  if (!host) { toast("Host is required"); return; }
  const entry = {
    label:    $("plib-label")?.value.trim() || host,
    country:  $("plib-country")?.value || "",
    scheme:   $("plib-scheme")?.value || "socks5",
    host,
    port:     Number($("plib-port")?.value) || 1080,
    username: $("plib-username")?.value.trim() || "",
    password: $("plib-password")?.value.trim() || "",
    ispName:  $("plib-ispName")?.value.trim() || "",
    ispAsn:   $("plib-asn")?.value.trim() || "",
    ispOrg:   $("plib-ispName")?.value.trim() || "",
    city:     $("plib-city")?.value.trim() || "",
    private:  true,
    source:   "private"
  };

  const saveBtn = $("btnSaveProxyLib");
  const editId = saveBtn?.dataset.editId;

  if (editId) {
    const r = await msg("PROXY_LIB_UPDATE", { id: editId, data: entry });
    if (r.ok) {
      const idx = proxyLibrary.findIndex((e) => e.id === editId);
      if (idx !== -1) proxyLibrary[idx] = r.entry;
      delete saveBtn.dataset.editId;
    }
  } else {
    const r = await msg("PROXY_LIB_ADD", { entry });
    if (r.ok) proxyLibrary.push(r.entry);
  }

  renderProxyLibrary();
  renderCountryProxies(selectedCountry, selectedCountry ? COUNTRY_PRESETS[selectedCountry]?.name : null);
  resetProxyLibForm();
  toast("Proxy saved to library");
}

function resetProxyLibForm() {
  ["plib-label","plib-host","plib-port","plib-username","plib-password","plib-ispName","plib-asn","plib-city"].forEach((id) => setVal(id, ""));
  setVal("plib-country", "us");
  setVal("plib-scheme", "socks5");
  const saveBtn = $("btnSaveProxyLib");
  if (saveBtn) delete saveBtn.dataset.editId;
  const cancelBtn = $("btnCancelProxyLib");
  if (cancelBtn) cancelBtn.hidden = true;
}

async function testProxyEntry(entry) {
  const statusEl = document.getElementById(`plib-status-${entry.id}`);
  if (statusEl) { statusEl.textContent = " testing..."; statusEl.style.color = "var(--muted)"; }
  const r = await msg("TEST_PROXY", {
    host: entry.host,
    port: entry.port,
    scheme: entry.scheme,
    username: entry.username || "",
    password: entry.password || ""
  });
  if (r.ok) {
    if (statusEl) { statusEl.textContent = ` online - ${r.ip}`; statusEl.style.color = "var(--green)"; }
    toast(`${entry.label || entry.host}: online`);
  } else {
    if (statusEl) { statusEl.textContent = " " + (r.error || "unreachable"); statusEl.style.color = "var(--red)"; }
    toast(`${entry.label || entry.host}: could not connect`);
  }
}

async function autoDetectProxy() {
  const ip       = ($("plib-detect-ip")?.value || "").trim();
  const infoPort = parseInt($("plib-detect-port")?.value || "8888", 10);
  const statusEl = $("detectStatus");

  if (!ip) { toast("Enter the server IP first"); return; }

  if (statusEl) statusEl.textContent = "Connecting…";
  const btn = $("btnDetectProxy");
  if (btn) btn.disabled = true;

  try {
    // Fetch the info endpoint from the server.
    // Chrome extensions can fetch http:// urls with host_permissions <all_urls>.
    const url = `http://${ip}:${infoPort}/`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json();

    if (info.status !== "ok") throw new Error("Server returned bad status");

    // Build preset from server response
    const country   = (info.country || "").toLowerCase();
    const preset    = COUNTRY_PRESETS[country] || {};
    const label     = `${COUNTRY_NAMES[country] || country.toUpperCase() || "My Server"} — ${ip}`;

    const entry = {
      label,
      country,
      scheme:   "socks5",
      host:     ip,
      port:     info.socks5_port || 1080,
      username: "",   // user fills credentials separately for security
      password: "",
      ispName:  preset.ispName || "",
      ispAsn:   preset.ispAsn  || "",
      ispOrg:   preset.ispOrg  || "",
      city:     preset.city    || ""
    };

    // Pre-fill the manual form so user can add credentials then save
    setVal("plib-label",    entry.label);
    setVal("plib-country",  entry.country || "us");
    setVal("plib-scheme",   entry.scheme);
    setVal("plib-host",     entry.host);
    setVal("plib-port",     entry.port);
    setVal("plib-ispName",  entry.ispName);
    setVal("plib-asn",      entry.ispAsn);
    setVal("plib-city",     entry.city);

    if (statusEl) statusEl.textContent = `Detected! Country: ${COUNTRY_NAMES[country] || country || "unknown"} — fill in your username/password then click Save.`;
    if (statusEl) statusEl.style.color = "var(--green)";

    toast(`Server detected: ${ip} (${COUNTRY_NAMES[country] || country || "?"})`);
    $("plib-username")?.focus();

  } catch (err) {
    if (statusEl) { statusEl.textContent = `Failed: ${err.message}`; statusEl.style.color = "var(--red)"; }
    toast(`Could not reach ${ip}:${infoPort} — is the server running?`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// =========================================================
// Android Cloud Phones
// =========================================================
async function loadCloudPhones() {
  const providerRes = await msg("CLOUD_PHONE_PROVIDER_GET");
  cloudPhoneProviderConfig = providerRes.config || { endpoint: "", authMode: "bearer", hasToken: false };
  const listRes = await msg("CLOUD_PHONE_LIST");
  cloudPhones = listRes.phones || [];
}

function renderCloudPhoneProviderConfig() {
  setVal("cloudProviderEndpoint", cloudPhoneProviderConfig.endpoint || "");
  setVal("cloudProviderAuthMode", cloudPhoneProviderConfig.authMode || "bearer");
  setVal("cloudProviderToken", "");
  const status = $("cloudProviderStatus");
  if (status) {
    status.textContent = cloudPhoneProviderConfig.hasToken
      ? "Provider saved. Token is stored securely by Electron safeStorage where available."
      : "Provider is optional. You can also register phones manually from an existing provider console.";
  }
}

async function saveCloudPhoneProviderSettings() {
  const btn = $("btnSaveCloudProvider");
  if (btn) { btn.disabled = true; btn.textContent = "Saving..."; }
  const r = await msg("CLOUD_PHONE_PROVIDER_SAVE", {
    config: {
      endpoint: $("cloudProviderEndpoint")?.value.trim() || "",
      authMode: $("cloudProviderAuthMode")?.value || "bearer",
      token: $("cloudProviderToken")?.value.trim() || ""
    }
  });
  if (r.ok) {
    cloudPhoneProviderConfig = r.config || cloudPhoneProviderConfig;
    renderCloudPhoneProviderConfig();
    toast("Cloud phone provider saved");
  } else {
    const status = $("cloudProviderStatus");
    if (status) status.textContent = r.error || "Could not save provider";
  }
  if (btn) { btn.disabled = false; btn.textContent = "Save provider"; }
}

function collectCloudPhoneForm() {
  return {
    label: $("cloudPhoneLabel")?.value.trim() || "Android Cloud Phone",
    provider: $("cloudPhoneProvider")?.value.trim() || "",
    country: $("cloudPhoneCountry")?.value || "",
    androidVersion: $("cloudPhoneAndroid")?.value || "14",
    manufacturer: $("cloudPhoneManufacturer")?.value.trim() || "Google",
    model: $("cloudPhoneModel")?.value.trim() || "Pixel 8",
    imei: $("cloudPhoneImei")?.value.trim() || "",
    hardwareFingerprint: $("cloudPhoneHardware")?.value.trim() || "",
    remoteUrl: $("cloudPhoneRemoteUrl")?.value.trim() || "",
    status: $("cloudPhoneStatusSel")?.value || "available",
    notes: $("cloudPhoneNotes")?.value || ""
  };
}

async function saveCloudPhoneRecord() {
  const btn = $("btnSaveCloudPhone");
  const editId = btn?.dataset.editId;
  const phone = collectCloudPhoneForm();
  if (editId) phone.id = editId;

  const r = await msg("CLOUD_PHONE_UPSERT", { phone });
  if (!r.ok) {
    const status = $("cloudPhoneFormStatus");
    if (status) status.textContent = r.error || "Could not save cloud phone";
    return;
  }
  const idx = cloudPhones.findIndex((item) => item.id === r.phone.id);
  if (idx === -1) cloudPhones.push(r.phone);
  else cloudPhones[idx] = r.phone;
  resetCloudPhoneForm();
  renderCloudPhones();
  toast("Cloud phone saved");
}

function resetCloudPhoneForm() {
  ["cloudPhoneLabel", "cloudPhoneProvider", "cloudPhoneImei", "cloudPhoneHardware", "cloudPhoneRemoteUrl", "cloudPhoneNotes"].forEach((id) => setVal(id, ""));
  setVal("cloudPhoneAndroid", "14");
  setVal("cloudPhoneCountry", "");
  setVal("cloudPhoneManufacturer", "Google");
  setVal("cloudPhoneModel", "Pixel 8");
  setVal("cloudPhoneStatusSel", "available");
  const btn = $("btnSaveCloudPhone");
  if (btn) {
    delete btn.dataset.editId;
    btn.textContent = "Save cloud phone";
  }
  const status = $("cloudPhoneFormStatus");
  if (status) status.textContent = "";
}

function renderCloudPhones() {
  const list = $("cloudPhoneList");
  if (!list) return;
  if (!cloudPhones.length) {
    list.innerHTML = '<div class="pm-list-empty">No Android cloud phones registered yet.</div>';
    return;
  }
  list.innerHTML = cloudPhones.map((phone) => {
    const country = phone.country ? (COUNTRY_NAMES[phone.country] || phone.country.toUpperCase()) : "Any country";
    const device = `${phone.manufacturer || "Android"} ${phone.model || ""}`.trim();
    const imei = phone.imei ? `IMEI ${phone.imei}` : "No IMEI stored";
    const remote = phone.remoteUrl ? "Console URL saved" : "Console URL missing";
    return `
      <div class="pm-cloud-phone-item" data-id="${escHtml(phone.id)}">
        <div class="pm-cloud-phone-main">
          <span class="pm-cloud-phone-title">${escHtml(phone.label || "Android Cloud Phone")}</span>
          <span class="pm-cloud-phone-meta">${escHtml(phone.provider || "Provider")} · Android ${escHtml(phone.androidVersion || "14")} · ${escHtml(device)} · ${escHtml(country)} · ${escHtml(phone.status || "available")}</span>
          <span class="pm-cloud-phone-id">${escHtml(imei)} · ${escHtml(phone.hardwareFingerprint || "No hardware fingerprint stored")} · ${escHtml(remote)}</span>
        </div>
        <div class="pm-cloud-phone-actions">
          <button class="pm-btn-xs primary" data-cloud-action="open" data-id="${escHtml(phone.id)}">Open</button>
          <button class="pm-btn-xs" data-cloud-action="edit" data-id="${escHtml(phone.id)}">Edit</button>
          <button class="pm-btn-xs danger" data-cloud-action="delete" data-id="${escHtml(phone.id)}">Del</button>
        </div>
      </div>
    `;
  }).join("");
}

async function handleCloudPhoneListClick(ev) {
  const btn = ev.target.closest("[data-cloud-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const phone = cloudPhones.find((item) => item.id === id);
  if (!phone) return;
  if (btn.dataset.cloudAction === "edit") {
    editCloudPhoneRecord(phone);
  } else if (btn.dataset.cloudAction === "delete") {
    if (!confirm("Delete this cloud phone record?")) return;
    const r = await msg("CLOUD_PHONE_DELETE", { id });
    if (!r.ok) { toast(r.error || "Delete failed"); return; }
    cloudPhones = cloudPhones.filter((item) => item.id !== id);
    renderCloudPhones();
    toast("Cloud phone deleted");
  } else if (btn.dataset.cloudAction === "open") {
    const r = await msg("CLOUD_PHONE_OPEN", { id });
    if (!r.ok) { toast(r.error || "Could not open cloud phone"); return; }
    await loadCloudPhones();
    renderCloudPhones();
    toast(r.existing ? "Cloud phone already open" : "Cloud phone console opened");
  }
}

function editCloudPhoneRecord(phone) {
  setVal("cloudPhoneLabel", phone.label || "");
  setVal("cloudPhoneProvider", phone.provider || "");
  setVal("cloudPhoneAndroid", phone.androidVersion || "14");
  setVal("cloudPhoneCountry", phone.country || "");
  setVal("cloudPhoneManufacturer", phone.manufacturer || "Google");
  setVal("cloudPhoneModel", phone.model || "Pixel 8");
  setVal("cloudPhoneImei", phone.imei || "");
  setVal("cloudPhoneHardware", phone.hardwareFingerprint || "");
  setVal("cloudPhoneRemoteUrl", phone.remoteUrl || "");
  setVal("cloudPhoneStatusSel", phone.status || "available");
  setVal("cloudPhoneNotes", phone.notes || "");
  const btn = $("btnSaveCloudPhone");
  if (btn) {
    btn.dataset.editId = phone.id;
    btn.textContent = "Update cloud phone";
  }
  $("cloudPhoneLabel")?.focus();
}

// =========================================================
// Start
// =========================================================
init();
