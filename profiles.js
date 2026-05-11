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

  await loadProfiles();
  bindSidebarEvents();
  bindFormEvents();
  renderList();
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
      blockStorage: $("fp-blockStorage").value === "true"
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
}

function updateUAPreview() {
  const mode = $("fp-userAgent")?.value;
  const os = $("fp-os")?.value || "windows";
  const preview = $("uaPreview");
  if (!preview) return;
  if (mode === "manual") {
    preview.textContent = "";
    return;
  }
  const samples = {
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };
  preview.textContent = "Auto: " + (samples[os] || samples.windows);
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
  const condTriggers = ["fp-userAgent", "fp-webglInfo", "fp-timezone", "fp-language", "fp-geolocation", "fp-deviceName", "fp-ports", "fp-webrtc", "fp-mediaDevices", "fp-screen", "fp-os"];
  for (const id of condTriggers) {
    const el = $(id);
    if (el) el.addEventListener("change", () => { updateConditionalRows(); updateUAPreview(); });
  }

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
// Start
// =========================================================
init();
