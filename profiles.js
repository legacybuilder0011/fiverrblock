// profiles.js — Profile Manager for Privacy Shield

"use strict";

// =========================================================
// Helpers
// =========================================================
const $ = (id) => document.getElementById(id);
const msg = (type, data) => new Promise((res) =>
  chrome.runtime.sendMessage({ type, ...data }, (r) => res(r || {}))
);

function toast(text, ms = 2200) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function osChip(os) {
  const map = { windows: ["os-windows", "Win"], macos: ["os-macos", "Mac"], linux: ["os-linux", "Linux"] };
  const [cls, label] = map[os] || ["os-windows", "Win"];
  return `<span class="chip ${cls}">${label}</span>`;
}

function statusChip(s) {
  return `<span class="chip status-${s || "new"}">${(s || "new").charAt(0).toUpperCase() + (s || "new").slice(1)}</span>`;
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

// Currently selected country code (for proxy picker)
let selectedCountry = null;

// =========================================================
// Boot
// =========================================================
async function init() {
  // Get active tab id
  try {
    const [tab] = await new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, res));
    if (tab) {
      activeTabId = tab.id;
      const r = await msg("PROFILE_GET_TAB", { tabId: activeTabId });
      tabAssignedProfileId = r.profileId || null;
    }
  } catch (_) {}

  // Load WebGL presets
  const wRes = await msg("PROFILE_WEBGL_PRESETS");
  webglPresets = wRes.presets || [];
  buildWebglVendorSelect();

  // Load open windows map
  await refreshOpenWindows();

  // Load proxy library
  const libRes = await msg("PROXY_LIB_GET");
  proxyLibrary = libRes.library || [];
  renderProxyLibrary();

  await loadProfiles();
  bindSidebarEvents();
  bindFormEvents();
  bindSessionEvents();
  renderList();

  // Poll open windows every 5 seconds to update running indicators
  setInterval(async () => {
    await refreshOpenWindows();
    renderList();
    if (selectedId) updateSessionTab();
  }, 5000);
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

async function createProfile() {
  const r = await msg("PROFILE_CREATE", { data: { name: "New Profile " + (profiles.length + 1) } });
  if (!r.ok) { toast("Failed to create profile"); return; }
  await loadProfiles();
  renderList();
  selectProfile(r.profile.id);
  toast("Profile created");
}

async function saveCurrentProfile() {
  if (!selectedId) return;
  const data = collectForm();
  const r = await msg("PROFILE_UPDATE", { id: selectedId, data });
  if (!r.ok) { toast("Save failed"); return; }
  await loadProfiles();
  renderList();
  toast("Saved");
}

async function deleteProfile(id) {
  if (!confirm("Delete this profile?")) return;
  await msg("PROFILE_DELETE", { id });
  await loadProfiles();
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
  await loadProfiles();
  renderList();
  selectProfile(r.profile.id);
  toast("Duplicated");
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
  const empty = $("listEmpty");
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
    empty.hidden = false;
    list.appendChild(empty);
    return;
  }
  empty.hidden = true;

  for (const p of filtered) {
    const isActive = p.id === selectedId;
    const isAssigned = p.id === tabAssignedProfileId;
    const card = document.createElement("div");
    card.className = "pm-card" + (isActive ? " active" : "");
    card.dataset.id = p.id;

    const proxyBadge = p.proxy?.enabled ? `<span class="chip proxy-on">Proxy</span>` : "";
    const assignedBadge = isAssigned ? `<span class="chip status-active">On Tab</span>` : "";
    const tags = (p.tags || []).slice(0, 3).map((t) => `<span class="chip status-new">${escHtml(t)}</span>`).join("");

    card.innerHTML = `
      <input type="checkbox" class="pm-card-check" data-id="${p.id}" />
      <div class="pm-card-body">
        <div class="pm-card-name">${escHtml(p.name)}</div>
        <div class="pm-card-meta">
          ${osChip(p.os)}
          ${statusChip(p.status)}
          ${proxyBadge}
          ${assignedBadge}
          ${tags}
        </div>
      </div>
      <div class="pm-card-actions">
        <button class="pm-btn-xs" data-action="apply" data-id="${p.id}" title="${isAssigned ? "Remove from tab" : "Apply to tab"}">${isAssigned ? "Unapply" : "Apply"}</button>
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
function selectProfile(id) {
  selectedId = id;
  const p = profiles.find((p) => p.id === id);
  if (!p) return;
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
  $("fp-tags").value = (p.tags || []).join(", ");
  $("fp-notes").value = p.notes || "";
  updateAssignedTabInfo();

  const fp = p.fingerprint || {};
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
    tags: $("fp-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    notes: $("fp-notes").value,
    fingerprint: {
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
        const sel = $("fp-browserVersion").value;
        if (sel === "custom") return ($("fp-browserVersionCustom").value.trim() || "148");
        return sel || "148";
      })(),
      city: ($("fp-city")?.value || "").trim(),
      state: ($("fp-state")?.value || "").trim(),
      ispName: ($("fp-ispName")?.value || "").trim(),
      ispAsn: ($("fp-ispAsn")?.value || "").trim(),
      ispOrg: ($("fp-ispOrg")?.value || "").trim()
    },
    proxy: {
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
}

function updateUAPreview() {
  const mode = $("fp-userAgent")?.value;
  const os = $("fp-os")?.value || "windows";
  const preview = $("uaPreview");
  if (!preview) return;
  if (mode === "manual") { preview.textContent = ""; return; }
  const bvSel = $("fp-browserVersion")?.value;
  const bv = bvSel === "custom"
    ? ($("fp-browserVersionCustom")?.value.trim() || "148")
    : (bvSel || "148");
  const full = bv.includes(".") ? bv : bv + ".0.0.0";
  const osTemplates = {
    windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    macos: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`
  };
  preview.textContent = "Auto: " + (osTemplates[os] || osTemplates.windows);
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
  const count = $("bulkCount");
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
  if (!activeTabId) { toast("No active tab"); return; }
  const r = await msg("PROFILE_CAPTURE_COOKIES", { profileId, tabId: activeTabId });
  await loadProfiles();
  const p = profiles.find((p) => p.id === profileId);
  if (p) updateCookiePanel(p);
  toast(`Captured ${r.count} cookies from active tab`);
}

async function injectCookies(profileId) {
  if (!activeTabId) { toast("No active tab"); return; }
  const r = await msg("PROFILE_INJECT_COOKIES", { profileId, tabId: activeTabId });
  toast(`Injected ${r.count} cookies into active tab`);
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
  if (!px.host || !px.port) {
    res.textContent = "Enter host and port first.";
    res.className = "pm-proxy-result err";
    return;
  }
  const r = await msg("TEST_PROXY");
  if (r.result?.ok) {
    res.textContent = "OK — IP: " + r.result.ip;
    res.className = "pm-proxy-result ok";
  } else {
    res.textContent = "Failed: " + (r.result?.error || "unknown");
    res.className = "pm-proxy-result err";
  }
}

// =========================================================
// Event binding
// =========================================================
function bindSidebarEvents() {
  $("btnNewProfile").addEventListener("click", createProfile);
  $("btnNewProfileEmpty").addEventListener("click", createProfile);

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
  const condTriggers = ["fp-userAgent", "fp-webglInfo", "fp-timezone", "fp-language", "fp-geolocation", "fp-deviceName", "fp-ports", "fp-webrtc", "fp-mediaDevices", "fp-screen", "fp-os", "fp-browserVersion"];
  for (const id of condTriggers) {
    const el = $(id);
    if (el) el.addEventListener("change", () => { updateConditionalRows(); updateUAPreview(); });
  }

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
function bindSessionEvents() {
  $("btnOpenWindow")?.addEventListener("click", () => selectedId && openProfileWindow(selectedId));
  $("btnSaveSession")?.addEventListener("click", () => selectedId && saveSession(selectedId));
  $("btnCloseWindow")?.addEventListener("click", () => selectedId && closeProfileWindow(selectedId));
  $("btnClearSession")?.addEventListener("click", () => selectedId && clearSession(selectedId));
  document.querySelectorAll(".pm-country-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyCountryPreset(btn.dataset.country));
  });

  // Proxy picker
  $("btnApplyCountryProxy")?.addEventListener("click", applySelectedLibraryProxy);
  $("btnAddCountryProxy")?.addEventListener("click", () => {
    if (selectedCountry) setVal("plib-country", selectedCountry);
    $("proxyLibForm")?.scrollIntoView({ behavior: "smooth" });
    $("plib-host")?.focus();
  });

  // Proxy library form
  $("btnSaveProxyLib")?.addEventListener("click", saveProxyLibEntry);
  $("btnCancelProxyLib")?.addEventListener("click", resetProxyLibForm);
  $("btnToggleProxyLib")?.addEventListener("click", () => {
    const panel = $("proxyLibPanel");
    if (panel) panel.hidden = !panel.hidden;
  });
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
  if (btn) { btn.textContent = "Opening…"; btn.disabled = true; }
  const r = await msg("PROFILE_OPEN_WINDOW", { profileId });
  if (!r.ok) {
    toast("Failed to open window: " + (r.error || "unknown"));
  } else if (r.existing) {
    toast("Window already open — brought to front");
  } else {
    toast(`Window opened with ${r.restored || 1} tab(s)`);
  }
  await refreshOpenWindows();
  renderList();
  updateSessionTab();
  if (btn) { btn.textContent = "Open in new window"; btn.disabled = false; }
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
      : "Click <b>Open in new window</b> to launch a dedicated Chrome window with this profile's proxy and fingerprint.";
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

function applyCountryPreset(countryCode) {
  const p = COUNTRY_PRESETS[countryCode];
  if (!p) return;

  // Fingerprint tab
  setVal("fp-timezone", "manual");
  setVal("fp-timezoneValue", p.timezone);
  setVal("fp-timezoneOffset", p.offset);
  setVal("fp-language", "manual");
  setVal("fp-languageValue", p.language);
  setVal("fp-geolocation", "manual");
  setVal("fp-geoLat", p.lat);
  setVal("fp-geoLng", p.lng);
  setVal("fp-geoAccuracy", 50);
  setVal("fp-os", p.os);
  setVal("fp-screen", "manual");
  setVal("fp-screenWidth", p.screenWidth);
  setVal("fp-screenHeight", p.screenHeight);
  setVal("fp-userAgent", "auto");

  // Browser version (preset-specific or default)
  if (p.browserVersion) {
    setVal("fp-browserVersion", p.browserVersion);
    const bvcRow = $("browserVersionCustomRow");
    if (bvcRow) bvcRow.hidden = true;
  }

  // ISP / Location identity
  if (p.city !== undefined) setVal("fp-city", p.city);
  if (p.state !== undefined) setVal("fp-state", p.state);
  if (p.ispName !== undefined) setVal("fp-ispName", p.ispName);
  if (p.ispAsn !== undefined) setVal("fp-ispAsn", p.ispAsn);
  if (p.ispOrg !== undefined) setVal("fp-ispOrg", p.ispOrg);

  // Update OS-related UI
  updateConditionalRows();
  updateUAPreview();

  // Highlight selected button
  document.querySelectorAll(".pm-country-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.country === countryCode);
  });

  // Show confirmation
  const applied = $("countryApplied");
  if (applied) {
    applied.hidden = false;
    applied.textContent = `Applied ${p.name} — timezone, language, geolocation, and screen set. Remember to add your proxy in the Proxy tab, then click Save.`;
  }

  toast(`${p.name} preset applied — click Save to keep it`);

  // Show proxy picker for this country
  selectedCountry = countryCode;
  renderCountryProxies(countryCode, p.name);
}

// =========================================================
// Proxy Library
// =========================================================

const COUNTRY_NAMES = {
  us:"United States",gb:"United Kingdom",de:"Germany",nl:"Netherlands",fr:"France",
  ch:"Switzerland",se:"Sweden",ca:"Canada",au:"Australia",jp:"Japan",sg:"Singapore",
  br:"Brazil",in:"India",ae:"UAE (Dubai)",ru:"Russia",tr:"Turkey",ng:"Nigeria","":" Any"
};

function renderCountryProxies(countryCode, countryName) {
  const row = $("countryProxyRow");
  const label = $("countryProxyLabel");
  const sel = $("countryProxySel");
  const empty = $("countryProxyEmpty");
  if (!row || !sel) return;

  const matches = proxyLibrary.filter((e) => e.country === countryCode);

  row.hidden = false;
  if (label) label.textContent = countryName || COUNTRY_NAMES[countryCode] || countryCode.toUpperCase();

  sel.innerHTML = "";
  if (matches.length === 0) {
    sel.hidden = true;
    if (empty) empty.hidden = false;
    const applyBtn = $("btnApplyCountryProxy");
    if (applyBtn) applyBtn.hidden = true;
  } else {
    sel.hidden = false;
    if (empty) empty.hidden = true;
    const applyBtn = $("btnApplyCountryProxy");
    if (applyBtn) applyBtn.hidden = false;
    for (const e of matches) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = `${e.label || "Unnamed"} — ${e.scheme.toUpperCase()} ${e.host}:${e.port}${e.ispName ? " (" + e.ispName + ")" : ""}`;
      sel.appendChild(o);
    }
  }
}

function applySelectedLibraryProxy() {
  const sel = $("countryProxySel");
  if (!sel || !sel.value) return;
  const entry = proxyLibrary.find((e) => e.id === sel.value);
  if (!entry) return;

  // Fill Proxy tab fields
  setVal("px-enabled", "true");
  setVal("px-scheme", entry.scheme || "socks5");
  setVal("px-host", entry.host || "");
  setVal("px-port", entry.port || 1080);
  setVal("px-username", entry.username || "");
  setVal("px-password", entry.password || "");

  // Fill ISP / identity fields from this proxy's metadata
  if (entry.ispName) setVal("fp-ispName", entry.ispName);
  if (entry.ispAsn)  setVal("fp-ispAsn",  entry.ispAsn);
  if (entry.ispOrg)  setVal("fp-ispOrg",  entry.ispOrg);
  if (entry.city)    setVal("fp-city",     entry.city);

  // Switch to Proxy tab so user sees it
  document.querySelector('[data-tab="proxy"]')?.click();
  toast(`Proxy applied: ${entry.label || entry.host}`);
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
      </div>
      <div class="pm-proxy-lib-actions">
        <button class="pm-btn-xs" data-action="edit" data-id="${e.id}">Edit</button>
        <button class="pm-btn-xs danger" data-action="del" data-id="${e.id}">Del</button>
      </div>
    </div>
  `).join("");

  list.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "del") {
      await msg("PROXY_LIB_DELETE", { id });
      proxyLibrary = proxyLibrary.filter((e) => e.id !== id);
      renderProxyLibrary();
      if (selectedCountry) {
        const p = COUNTRY_PRESETS[selectedCountry];
        renderCountryProxies(selectedCountry, p?.name);
      }
      toast("Proxy deleted");
    } else if (btn.dataset.action === "edit") {
      const e = proxyLibrary.find((x) => x.id === id);
      if (!e) return;
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
  }, { capture: false });
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
    city:     $("plib-city")?.value.trim() || ""
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
  if (selectedCountry) {
    const p = COUNTRY_PRESETS[selectedCountry];
    renderCountryProxies(selectedCountry, p?.name);
  }
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

// =========================================================
// Start
// =========================================================
init();
