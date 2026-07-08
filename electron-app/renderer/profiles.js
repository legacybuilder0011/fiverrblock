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
  const map = { windows: ["os-windows", "Win"], macos: ["os-macos", "Mac"], linux: ["os-linux", "Linux"], android: ["os-linux", "Android"], ios: ["os-macos", "iOS"] };
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

function normalizeEngineValue(engine) {
  const value = String(engine || "").toLowerCase();
  return ["chromium", "stealthfox", "real-chrome", "real-brave", "patched-chromium"].includes(value) ? value : "chromium";
}

function engineLabel(engine) {
  const map = {
    chromium: "Chromium",
    stealthfox: "Stealthfox",
    "real-chrome": "Real Chrome",
    "real-brave": "Real Brave",
    "patched-chromium": "Patched Chromium"
  };
  return map[normalizeEngineValue(engine)] || map.chromium;
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
// Proxy geo-detection data for the currently-edited profile (persisted to proxy object on save)
let currentProxyDetection = null;

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
      } else if (payload.type === "VPN_DROPPED") {
        // The kill-switch force-closed a profile because the VPN dropped/changed.
        await refreshOpenWindows();
        renderList();
        if (selectedId) updateSessionTab();
        const name = payload.profileName || "Profile";
        alert(`⚠️ ${name} was closed\n\n${payload.reason || "The VPN connection dropped."}`);
      } else if (payload.type === "PATCHED_ENGINE_PROGRESS") {
        // Live progress for the one-time Patched Chromium engine download → the
        // download modal's progress bar (see runPatchedEngineDownload).
        patchedProgressUpdate(payload.pct, payload.done);
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

// Mobile GPU presets — these are what real iPhones/Pixels/Samsungs actually
// report. We inject them as <option data-mobile-only> so the CSS rules can
// show only the matching set based on body.mobile-profile.
const MOBILE_WEBGL_PRESETS = [
  { vendor: "Apple Inc.", renderer: "Apple GPU", platform: "ios" },
  { vendor: "Qualcomm", renderer: "Adreno (TM) 740", platform: "android" },
  { vendor: "Qualcomm", renderer: "Adreno (TM) 750", platform: "android" },
  { vendor: "Qualcomm", renderer: "Adreno (TM) 619", platform: "android" },
  { vendor: "ARM", renderer: "Mali-G710", platform: "android" },
  { vendor: "ARM", renderer: "Mali-G68", platform: "android" },
  { vendor: "ARM", renderer: "Immortalis-G715", platform: "android" }
];

function buildWebglVendorSelect() {
  const sel = $("fp-webglVendor");
  if (!sel) return;
  sel.innerHTML = "";
  const seen = new Set();
  // Desktop vendors first (hidden when mobile via CSS), then mobile vendors
  // tagged data-mobile-only so they only show on mobile profiles.
  for (const preset of webglPresets) {
    if (seen.has(preset.vendor)) continue;
    seen.add(preset.vendor);
    const o = document.createElement("option");
    o.value = preset.vendor;
    o.textContent = preset.vendor;
    sel.appendChild(o);
  }
  for (const preset of MOBILE_WEBGL_PRESETS) {
    const key = "mobile:" + preset.vendor;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = document.createElement("option");
    o.value = preset.vendor;
    o.textContent = preset.vendor + " (mobile)";
    o.setAttribute("data-mobile-only", "");
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    const vendor = sel.value;
    const isMobile = document.body.classList.contains("mobile-profile");
    const pool = isMobile
      ? MOBILE_WEBGL_PRESETS.filter((p) => p.vendor === vendor)
      : webglPresets.filter((p) => p.vendor === vendor);
    if (pool.length) $("fp-webglRenderer").value = pool[0].renderer;
  });
}

// Apply or remove the mobile-profile UI lockdown. Toggles a body class so CSS
// can hide desktop-only options/sections, and snaps any out-of-range value
// (e.g. CPU=16 cores) back into the mobile-realistic range so when the user
// saves, the backend doesn't get a "iPhone with 16 cores" mismatch.
function applyMobileUIMode(os) {
  const isMobile = os === "android" || os === "ios";
  document.body.classList.toggle("mobile-profile", isMobile);
  document.body.classList.toggle("os-android", os === "android");
  document.body.classList.toggle("os-ios", os === "ios");
  if (!isMobile) return;

  // Snap dropdowns into mobile-valid ranges
  const cpu = $("fp-cpuCoresValue");
  if (cpu && Number(cpu.value) > 8) cpu.value = "8";
  const ram = $("fp-ramValue");
  if (ram && (Number(ram.value) > 12 || Number(ram.value) < 3)) ram.value = "8";
  const windowMode = $("fp-windowMode");
  if (windowMode && windowMode.value === "incognito") windowMode.value = "normal";
  const browserApp = $("fp-browserApp");
  if (browserApp && (browserApp.value === "brave" || browserApp.value === "privacy")) {
    browserApp.value = "chrome";
  }
  // If WebGL vendor is a desktop GPU, switch to a mobile one matching the OS
  const vendorSel = $("fp-webglVendor");
  if (vendorSel) {
    const mobilePool = MOBILE_WEBGL_PRESETS.filter((p) => p.platform === os);
    const currentIsDesktop = !MOBILE_WEBGL_PRESETS.some((p) => p.vendor === vendorSel.value);
    if (currentIsDesktop && mobilePool.length) {
      vendorSel.value = mobilePool[0].vendor;
      $("fp-webglRenderer").value = mobilePool[0].renderer;
    }
  }
  // If screen looks desktop-sized, snap to a sensible mobile preset
  const w = Number($("fp-screenWidth")?.value || 0);
  const h = Number($("fp-screenHeight")?.value || 0);
  if (w >= 1000 || h >= 1200) {
    const preset = os === "ios" ? { w: 390, h: 844 } : { w: 412, h: 915 };
    setVal("fp-screenWidth", preset.w);
    setVal("fp-screenHeight", preset.h);
  }
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
  setEditMode(true); // new profile starts unlocked so it can be configured
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
    populateForm(r.profile);
    const saveBtn = $("btnSave");
    if (saveBtn) saveBtn.textContent = "Save";
    setEditMode(false); // lock right after creating — saved and stable
    renderList();
    toast("Profile created");
    return;
  }

  if (!selectedId) { toast("Select a profile first"); return; }
  const r = await msg("PROFILE_UPDATE", { id: selectedId, data });
  if (!r.ok) { toast("Save failed: " + (r.error || "unknown error")); return; }
  await loadProfiles();
  const savedProfile = profiles.find((p) => p.id === selectedId);
  if (savedProfile) populateForm(savedProfile);
  setEditMode(false); // re-lock after saving — settings stay put until Edit
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
// Static antidetect-strength score (0-100) for a profile, computed from its
// config — no browser needed. Reflects the two real risks: DETECTABILITY (does
// it look spoofed/bot) and LINKABILITY (can two profiles be tied to one machine
// or IP). The deep, live check remains the red-team page.
function transportFingerprintInfo(fp = {}, px = {}, engine = "chromium") {
  const selectedEngine = normalizeEngineValue(engine);
  if (selectedEngine === "patched-chromium") {
    return {
      penalty: 0,
      message: "Patched Chromium: per-seed device identity at the engine level (canvas/audio/font/tz/GPU), covers workers"
    };
  }
  if (selectedEngine === "real-brave") {
    return {
      penalty: 2,
      message: "Real Brave: extension fingerprint layer + real transport, no CDP tell"
    };
  }
  if (selectedEngine === "real-chrome") {
    return {
      penalty: 8,
      message: "Real Chrome: real transport, but Chrome blocks the fingerprint extension (transport only)"
    };
  }
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  const scheme = String(px.scheme || "").toLowerCase();
  const hasProxy = mode === "proxy" && Boolean(px.enabled && px.host && px.port);
  const isHttpProxy = hasProxy && (scheme === "http" || scheme === "https");

  if (!fp.tlsSpoof) {
    return {
      penalty: 8,
      message: "TLS/HTTP2 stays native Chromium before JavaScript runs"
    };
  }
  if (!isHttpProxy) {
    return {
      penalty: 12,
      message: "TLS spoof is on but unsupported here; use an enabled HTTP/HTTPS proxy"
    };
  }
  return {
    penalty: 3,
    message: "TLS JA3 bridge is partial; HTTP2/WebSocket transport is not fully covered"
  };
}

function computeProfileStrength(p) {
  const fp = p.fingerprint || {};
  const px = p.proxy || {};
  const engine = normalizeEngineValue(p.engine);
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
  const os = p.os || "windows";
  const reasons = [];
  let score = 0;

  // ── Detectability (max 55) ──────────────────────────────────────────────
  if (engine === "patched-chromium") {
    score += 12; // engine-level per-seed device identity; covers workers/fonts; no CDP tell
  } else if (engine === "real-brave") {
    score += 9; // extension fingerprint layer runs canvas/WebGL/audio/tz spoof; no CDP tell
  } else if (engine === "real-chrome") {
    score += 4; // real transport only — Chrome blocks the fingerprint extension
    reasons.push("Real Chrome cannot load the fingerprint extension; use Real Brave for JS spoofing");
  } else {
    score += 10; // automation-marker + toString cloak are on in the Electron preload
  }

  const tzMode = fp.timezone || "auto";
  if (tzMode === "auto") score += 15;
  else if (fp.timezoneValue) score += 12;
  else { score += 4; reasons.push("Timezone is manual with no value set"); }

  const w = Number(fp.screenWidth) || 0, h = Number(fp.screenHeight) || 0;
  const mobileOS = os === "android" || os === "ios";
  const mobileScreen = w > 0 && Math.min(w, h) <= 600;
  if (w === 0) score += 10;
  else if (mobileOS === mobileScreen) score += 15;
  else { score += 3; reasons.push(mobileOS ? "Mobile OS but desktop-size screen" : "Desktop OS but phone-size screen"); }

  const glr = String(fp.webglRenderer || fp.gpuRenderer || "");
  const glBad = glr && (os === "macos" || os === "ios" || os === "linux") && /Direct3D|D3D11/i.test(glr);
  if (!glBad) score += 10; else reasons.push("WebGL renderer doesn't match the OS");

  if ((fp.webrtc || "altered") === "real") reasons.push("WebRTC = Real → can leak your true IP");
  else score += 5;

  // ── Linkability (max 45) ────────────────────────────────────────────────
  if (mode === "proxy" && px.host) score += 25;
  else if (mode === "vpn") { score += 6; reasons.push("Shared VPN IP — all VPN profiles exit the same IP"); }
  else reasons.push("No dedicated proxy — profiles share one IP");

  if (fp.fingerprintSeed) score += 10;
  else reasons.push("No per-profile fingerprint seed (canvas/audio not unique)");

  const stealth = fp.spoofingLevel === "stealth" || (Array.isArray(fp.spoofSkipHosts) && fp.spoofSkipHosts.length > 0);
  if (!stealth) score += 10;
  else { score += 3; reasons.push("Stealth/allowlist shares your real hardware across profiles"); }

  const transport = transportFingerprintInfo(fp, px, engine);
  if (transport.penalty) {
    score -= transport.penalty;
    reasons.push(transport.message);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let grade, cls;
  if (score >= 85) { grade = "Strong"; cls = "str-strong"; }
  else if (score >= 65) { grade = "Good"; cls = "str-good"; }
  else if (score >= 45) { grade = "Fair"; cls = "str-fair"; }
  else { grade = "Weak"; cls = "str-weak"; }
  return { score, grade, cls, reasons };
}

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

  // Count each detected exit IP across ALL profiles (not just the filtered view)
  // so a shared-IP badge fires even when the other profile is filtered out.
  const ipCounts = {};
  for (const pr of profiles) {
    const ip = String(pr.proxy?.detectedIp || "").trim();
    if (ip) ipCounts[ip] = (ipCounts[ip] || 0) + 1;
  }

  for (const p of filtered) {
    const isActive = p.id === selectedId;
    const isAssigned = p.id === tabAssignedProfileId;
    const card = document.createElement("div");
    card.className = "pm-card" + (isActive ? " active" : "");
    card.dataset.id = p.id;

    const isRunning = (p.id in openWindows) || stealthRunning.has(p.id);
    const isStealthLive = stealthRunning.has(p.id);
    const proxyBadge   = p.proxy?.enabled ? `<span class="chip proxy-on">Proxy</span>` : "";
    const assignedBadge = isAssigned ? `<span class="chip status-active">On Tab</span>` : "";
    const launchEngineLabel = engineLabel(p.engine);
    const runningBadge  = isRunning ? `<span class="chip status-active">${isStealthLive ? "🦊 Live" : "Live"}</span>` : "";
    const tags = (p.tags || []).slice(0, 3).map((t) => `<span class="chip status-new">${escHtml(t)}</span>`).join("");
    const browserIcons = { privacy: "PS", chrome: "&#9689;", brave: "&#129321;", edge: "&#127919;", firefox: "FF", safari: "SF" };
    const browserName = p.browserApp || "chrome";
    const browserBadge = `<span class="chip browser-chip" title="${browserLabel(browserName)}">${browserIcons[browserName] || "&#9689;"} ${browserLabel(browserName)}</span>`;
    const incogBadge   = p.windowMode === "incognito" ? `<span class="chip incog-chip">Incognito</span>` : "";
    const st = computeProfileStrength(p);
    const strengthTitle = `Antidetect strength ${st.score}/100 (${st.grade})` + (st.reasons.length ? " — fix: " + st.reasons.join("; ") : " — no issues found");
    const strengthBadge = `<span class="chip ${st.cls}" title="${escHtml(strengthTitle)}">&#128737; ${st.score}</span>`;

    // Exit-IP badge: the fastest way to eyeball whether two profiles share an IP
    // (which links them regardless of fingerprint). Red ⚠ = shared with another
    // profile; cyan 🌐 = unique to this profile; grey = proxy on but not tested yet.
    const pxMode = p.proxy?.networkMode || (p.proxy?.enabled ? "proxy" : "direct");
    const detIp = String(p.proxy?.detectedIp || "").trim();
    let ipBadge = "";
    if (detIp) {
      const dup = (ipCounts[detIp] || 0) > 1;
      const cc = p.proxy?.detectedCountryCode ? String(p.proxy.detectedCountryCode).toUpperCase() : "";
      const ipTitle = dup
        ? `Shared exit IP ${detIp} — ${ipCounts[detIp]} profiles use it. Accounts on one IP can be linked as the same person. Give each profile its own proxy.`
        : `Exit IP ${detIp}${cc ? " (" + cc + ")" : ""} — unique to this profile.`;
      ipBadge = `<span class="chip ${dup ? "ip-dup" : "ip-badge"}" title="${escHtml(ipTitle)}">${dup ? "&#9888;&#65039; " : "&#127760; "}${escHtml(detIp)}${cc ? " " + escHtml(cc) : ""}</span>`;
    } else if (pxMode === "proxy" && p.proxy?.enabled) {
      ipBadge = `<span class="chip ip-untested" title="Proxy set but exit IP not detected yet — open this profile and click Test &amp; Detect on the Proxy tab.">&#127760; IP not tested</span>`;
    }

    card.innerHTML = `
      <input type="checkbox" class="pm-card-check" data-id="${p.id}" />
      <div class="pm-card-body">
        <div class="pm-card-name">${escHtml(p.name)}</div>
        <div class="pm-card-meta">
          ${strengthBadge}
          ${browserBadge}
          ${osChip(p.os)}
          ${statusChip(p.status)}
          ${proxyBadge}
          ${ipBadge}
          ${incogBadge}
          ${runningBadge}
          ${assignedBadge}
          ${tags}
        </div>
      </div>
      <div class="pm-card-actions">
        ${isRunning
          ? `<button class="pm-btn-xs danger" data-action="stop" data-id="${p.id}" title="Stop and save the session">Stop</button>`
          : `<button class="pm-btn-xs success" data-action="start" data-id="${p.id}" title="Start with this profile's chosen engine (${escHtml(launchEngineLabel)})">Start${(p.engine === "stealthfox") ? " 🦊" : ""}</button>`}
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
  currentProxyDetection = null;
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
  setLaunchError(null);
  populateForm(p);
  setEditMode(false); // a saved profile opens LOCKED — click Edit to change it
  renderList();
  updateSessionTab();
}

// "Generate coherent identity" — asks the main process for a fully consistent
// device fingerprint (UA ↔ WebGL ↔ screen ↔ CPU/RAM ↔ timezone ↔ language ↔
// version all matched) for the current OS + country, then loads it into the form
// while KEEPING the profile name, tags, notes and proxy. User reviews and Saves.
async function generateCoherentIdentity() {
  const os = $("fp-os")?.value || "windows";
  const country = (currentFingerprintMeta && currentFingerprintMeta.countryCode)
    || (typeof selectedCountry !== "undefined" && selectedCountry) || "us";
  const deviceClass = (os === "android" || os === "ios") ? "mobile" : "desktop";
  const browserApp = $("fp-browserApp")?.value || "chrome";
  const btn = $("btnGenIdentity");
  if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
  try {
    const res = await msg("PROFILE_COUNTRY_IDENTITY", { country, os, deviceClass, browserApp });
    if (!res || !res.ok || !res.data) { toast("Could not generate identity"); return; }
    const d = res.data;
    // Location fields follow the ACTUAL VPN/proxy exit (set to Auto) so the
    // identity can never contradict the network — timezone, language and
    // geolocation are resolved from the live exit IP at launch. The device
    // fingerprint (UA, GPU, screen, CPU/RAM, version) stays fixed and coherent
    // and doesn't depend on location, so there's nothing to mismatch.
    if (d.fingerprint) {
      d.fingerprint.timezone = "auto";
      d.fingerprint.language = "auto";
      d.fingerprint.geolocation = "auto";
    }
    populateForm({
      name: $("fp-name")?.value || "",
      status: $("fp-status")?.value || "new",
      os: d.os || os,
      browserApp: d.browserApp || browserApp,
      engine: $("fp-engine")?.value || "chromium", // keep the chosen engine
      windowMode: $("fp-windowMode")?.value || "normal",
      tags: ($("fp-tags")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
      notes: $("fp-notes")?.value || "",
      fingerprint: d.fingerprint
    });
    toast("Fresh coherent identity generated — review and Save");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎲 Generate coherent identity"; }
  }
}

function populateForm(p) {
  $("fp-name").value = p.name || "";
  $("fp-status").value = p.status || "new";
  $("fp-os").value = p.os || "windows";
  applyMobileUIMode(p.os || "windows");
  setVal("fp-browserApp",  p.browserApp  || "chrome");
  setVal("fp-windowMode",  p.windowMode  || "normal");
  setVal("fp-engine",      normalizeEngineValue(p.engine));
  updateEngineHint();
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
    fingerprintSeed: fp.fingerprintSeed || "",
    hardwareId: fp.hardwareId || "",
    fontProfile: fp.fontProfile || p.os || "windows",
    installedFonts: Array.isArray(fp.installedFonts) ? fp.installedFonts : [],
    colorDepth: fp.colorDepth || 24,
    pixelDepth: fp.pixelDepth || 24,
    devicePixelRatio: fp.devicePixelRatio || 1,
    deviceClass: fp.deviceClass || ((p.os === "android" || p.os === "ios") ? "mobile" : "desktop"),
    mobileModel: fp.mobileModel || "",
    mobileManufacturer: fp.mobileManufacturer || "",
    platformVersion: fp.platformVersion || "",
    androidBuild: fp.androidBuild || "",
    architecture: fp.architecture || ((p.os === "android" || p.os === "ios") ? "arm" : "x86"),
    bitness: fp.bitness || "64",
    maxTouchPoints: fp.maxTouchPoints || ((p.os === "android" || p.os === "ios") ? 5 : 0),
    screenOrientation: fp.screenOrientation || ((p.os === "android" || p.os === "ios") ? "portrait-primary" : "landscape-primary"),
    touchEmulation: fp.touchEmulation ?? (p.os === "android" || p.os === "ios"),
    sensorEmulation: fp.sensorEmulation ?? (p.os === "android" || p.os === "ios"),
    viewportMobile: fp.viewportMobile ?? (p.os === "android" || p.os === "ios"),
    pointerType: fp.pointerType || ((p.os === "android" || p.os === "ios") ? "coarse" : "fine"),
    hoverType: fp.hoverType || ((p.os === "android" || p.os === "ios") ? "none" : "hover"),
    deviceMotion: fp.deviceMotion || null,
    deviceOrientation: fp.deviceOrientation || null,
    connectionType: fp.connectionType || "wifi",
    downlink: fp.downlink || 10,
    rtt: fp.rtt || 50
  };
  // Safari/Firefox were removed (Chromium can't run WebKit/Gecko — the UA-vs-engine
  // mismatch is detectable). Coerce any legacy profile saved with them to Chrome.
  let _loadBrowser = fp.browser || p.browserApp || "chrome";
  if (_loadBrowser === "safari" || _loadBrowser === "firefox") _loadBrowser = "chrome";
  setVal("fp-browser", _loadBrowser);
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
  setVal("fp-tlsSpoof", String(Boolean(fp.tlsSpoof)));
  setVal("fp-spoofingLevel", fp.spoofingLevel || "full");
  setVal("fp-spoofSkipHosts", (fp.spoofSkipHosts || []).join(", "));

  // Browser version. A full-version "custom" pin (contains a dot, e.g.
  // "150.0.7871.46") shows in the Custom field. A bare major (e.g. "150") is a
  // real user choice — select that option so it persists. "auto" keeps whatever
  // latest updateBrowserVersionOptions() already selected above.
  const bvRaw = String(fp.browserVersion || "auto");
  const isCustomVer = bvRaw !== "auto" && bvRaw.includes(".");
  if (isCustomVer) {
    setVal("fp-browserVersion", "custom");
    setVal("fp-browserVersionCustom", bvRaw);
  } else {
    if (bvRaw !== "auto") setBrowserVersionValue(bvRaw);
    setVal("fp-browserVersionCustom", "");
  }
  const bvcRow = $("browserVersionCustomRow");
  if (bvcRow) bvcRow.hidden = !isCustomVer;
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

  // Restore saved detection data and render the detect result panel
  currentProxyDetection = px.detectedCountryCode ? {
    detectedCountryCode: px.detectedCountryCode,
    detectedCountry: px.detectedCountry || "",
    detectedCity: px.detectedCity || "",
    detectedTimezone: px.detectedTimezone || "",
    proxyType: px.proxyType || "unknown",
    detectedAt: px.detectedAt || null
  } : null;
  renderProxyDetectResult(currentProxyDetection);

  updateConditionalRows();
  updateCookiePanel(p);
  updateUAPreview();
  startAutoIpDetect();
}

function setVal(id, val) {
  const el = $(id);
  if (!el) return;
  el.value = String(val ?? "");
}

// Show the "Stealthfox runs Firefox" note + grey the Chromium-only Browser rows
// when the Stealthfox engine is selected, so it's clear Start won't open Chrome.
function updateEngineHint() {
  const engine = normalizeEngineValue($("fp-engine")?.value);
  const isStealth = engine === "stealthfox";
  const isReal = engine === "real-chrome" || engine === "real-brave" || engine === "patched-chromium";
  const note = $("stealthEngineNote");
  if (note) {
    note.hidden = !isStealth && !isReal;
    if (isStealth) {
      note.innerHTML = "🦊 This profile's engine is <b>Stealthfox (Firefox)</b> - clicking Start opens patched Firefox, <b>not</b> Chrome/Brave/Edge. The Browser and Version options below apply only to the Chromium engine and are ignored by Stealthfox. Proxy, screen, timezone, language, and geolocation still apply.";
    } else if (engine === "patched-chromium") {
      note.innerHTML = "This profile's engine is <b>Patched Chromium</b> - a bundled, patched browser (not your installed Chrome/Brave). Each profile gets a distinct hardware identity randomized at the engine level from a per-profile seed: canvas, WebGL/GPU, audio, fonts, timezone, CPU cores and RAM all differ between profiles and stay stable per profile. Two profiles look like two different physical PCs. First use downloads the engine (~190MB).";
    } else if (engine === "real-brave") {
      note.innerHTML = "This profile's engine is <b>Real Brave</b> - clicking Start opens installed Brave with a separate data folder for this profile. A per-profile extension applies canvas/WebGL/audio/screen/timezone/geolocation spoofing inside the real browser (no CDP), and proxy + user-agent are set at launch. This is the strongest real-browser mode.";
    } else if (engine === "real-chrome") {
      note.innerHTML = "This profile's engine is <b>Real Chrome</b> - clicking Start opens installed Chrome with a separate data folder. Real transport, proxy, user-agent, timezone and WebRTC/DNS controls apply, but current Chrome blocks command-line extensions, so the canvas/WebGL/audio JS spoof does <b>not</b> run. For full fingerprint spoofing in a real browser, use <b>Real Brave</b>.";
    }
  }
  const browserRow = $("fp-browser")?.closest(".pm-row");
  const verRow = $("browserVersionRow");
  [browserRow, verRow].forEach((r) => { if (r) r.style.opacity = (isStealth || isReal) ? "0.45" : "1"; });
}

// Locked "view" vs "edit" mode. Once a profile is saved it stays LOCKED — every
// setting keeps the saved value and can't change (across close/reopen too) until
// the user clicks Edit. Creating a new profile or clicking Edit unlocks the form;
// Save re-locks it. Duplicate/Delete/tab-switching stay available while locked.
let editMode = true;
function setEditMode(on) {
  editMode = on;
  const wrap = $("formWrap");
  if (wrap) {
    wrap.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = !on; });
    wrap.querySelectorAll("button").forEach((b) => {
      if (b.classList.contains("pm-tab")) return;                                    // tab switching stays live
      if (["btnEdit", "btnSave", "btnDuplicate", "btnDelete", "btnAssignTab"].includes(b.id)) return;
      b.disabled = !on;
    });
    wrap.classList.toggle("view-locked", !on);
  }
  const save = $("btnSave"), edit = $("btnEdit");
  if (save) save.hidden = !on;
  if (edit) edit.hidden = on;
}

function collectForm() {
  return {
    name: $("fp-name").value.trim() || "Unnamed",
    status: $("fp-status").value,
    os: $("fp-os").value,
    browserApp: $("fp-browserApp")?.value || "chrome",
    windowMode: $("fp-windowMode")?.value || "normal",
    engine: normalizeEngineValue($("fp-engine")?.value),
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
      tlsSpoof: $("fp-tlsSpoof")?.value === "true",
      spoofingLevel: $("fp-spoofingLevel")?.value || "full",
      spoofSkipHosts: ($("fp-spoofSkipHosts")?.value || "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      browserVersion: (() => {
        const sel = $("fp-browserVersion")?.value || "auto";
        if (sel === "custom") return ($("fp-browserVersionCustom")?.value.trim() || "auto");
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
      fingerprintSeed: currentFingerprintMeta.fingerprintSeed || "",
      hardwareId: currentFingerprintMeta.hardwareId || "",
      fontProfile: currentFingerprintMeta.fontProfile || $("fp-os")?.value || "windows",
      installedFonts: Array.isArray(currentFingerprintMeta.installedFonts) ? currentFingerprintMeta.installedFonts : [],
      colorDepth: Number(currentFingerprintMeta.colorDepth) || 24,
      pixelDepth: Number(currentFingerprintMeta.pixelDepth) || 24,
      devicePixelRatio: Number(currentFingerprintMeta.devicePixelRatio) || 1,
      deviceClass: (["android", "ios"].includes($("fp-os")?.value)) ? "mobile" : (currentFingerprintMeta.deviceClass || "desktop"),
      mobileModel: currentFingerprintMeta.mobileModel || "",
      mobileManufacturer: currentFingerprintMeta.mobileManufacturer || "",
      platformVersion: currentFingerprintMeta.platformVersion || "",
      androidBuild: currentFingerprintMeta.androidBuild || "",
      architecture: (["android", "ios"].includes($("fp-os")?.value)) ? "arm" : (currentFingerprintMeta.architecture || "x86"),
      bitness: currentFingerprintMeta.bitness || "64",
      maxTouchPoints: Number(currentFingerprintMeta.maxTouchPoints) || ((["android", "ios"].includes($("fp-os")?.value)) ? 5 : 0),
      screenOrientation: (["android", "ios"].includes($("fp-os")?.value)) ? "portrait-primary" : (currentFingerprintMeta.screenOrientation || "landscape-primary"),
      touchEmulation: (["android", "ios"].includes($("fp-os")?.value)) || Boolean(currentFingerprintMeta.touchEmulation),
      sensorEmulation: (["android", "ios"].includes($("fp-os")?.value)) || Boolean(currentFingerprintMeta.sensorEmulation),
      viewportMobile: (["android", "ios"].includes($("fp-os")?.value)) || Boolean(currentFingerprintMeta.viewportMobile),
      pointerType: (["android", "ios"].includes($("fp-os")?.value)) ? "coarse" : (currentFingerprintMeta.pointerType || "fine"),
      hoverType: (["android", "ios"].includes($("fp-os")?.value)) ? "none" : (currentFingerprintMeta.hoverType || "hover"),
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
      bypassList: $("px-bypassList").value.split(",").map((s) => s.trim()).filter(Boolean),
      // Preserved from last PROXY_DETECT_LOCATION run — do not wipe on form collect
      ...(currentProxyDetection || {})
    }
  };
}

async function auditCurrentProfile() {
  const box = $("profileAuditResult");
  if (!box) return;
  let data;
  try {
    data = collectForm();
  } catch (err) {
    box.className = "pm-audit-result issue";
    box.textContent = "Form error: " + (err.message || err);
    return;
  }
  const storedProfile = selectedId ? profiles.find((p) => p.id === selectedId) : null;
  const candidate = {
    ...(storedProfile || {}),
    id: selectedId || "__new__",
    ...data,
    fingerprint: {
      ...(storedProfile?.fingerprint || {}),
      ...(data.fingerprint || {})
    }
  };
  box.className = "pm-audit-result";
  box.textContent = "Running audit...";
  const r = await msg("PROFILE_AUDIT", { profile: candidate });
  if (!r.ok) {
    box.className = "pm-audit-result issue";
    box.textContent = r.error || "Audit failed";
    return;
  }
  renderProfileAudit(r.audit);
}

function renderProfileAudit(audit) {
  const box = $("profileAuditResult");
  if (!box || !audit) return;
  const level = audit.issues?.length ? "issue" : audit.warnings?.length ? "warn" : "ok";
  box.className = "pm-audit-result " + level;
  const rows = [];
  rows.push(`<span class="pm-audit-line ${audit.ok ? "pass" : "warn"}">Score: ${Number(audit.score) || 0}/100. Runtime: ${escHtml(audit.profile?.actualRuntime || "Electron Chromium")}.</span>`);
  if (audit.summary) {
    rows.push(`<span class="pm-audit-line pass">Storage: ${escHtml(audit.summary.storage || audit.profile?.sessionPartition || "profile partition")}.</span>`);
    rows.push(`<span class="pm-audit-line pass">Screen: ${escHtml(audit.summary.screen || "missing")}.</span>`);
    rows.push(`<span class="pm-audit-line pass">Fonts: ${escHtml(audit.summary.fonts || "missing")}.</span>`);
    rows.push(`<span class="pm-audit-line pass">GPU: ${escHtml(audit.summary.gpu || "missing")}.</span>`);
    if (audit.summary.transport) rows.push(`<span class="pm-audit-line pass">Transport: ${escHtml(audit.summary.transport)}.</span>`);
  }
  for (const item of [...(audit.issues || []), ...(audit.warnings || []), ...(audit.passes || []).slice(0, 6)]) {
    rows.push(`<span class="pm-audit-line ${item.level}">${escHtml(item.message)}</span>`);
  }
  box.innerHTML = rows.join("");
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

// Current real-world versions — MUST mirror LATEST_CHROME_BY_OS / latestVersionFor
// in src/profile-store.js so this in-form preview matches the actual launched UA.
const PREVIEW_LATEST_CHROME = { windows: "150.0.7871.46", macos: "150.0.7871.46", linux: "150.0.7871.46", android: "150.0.7871.63", ios: "150.0.7871.51" };
const PREVIEW_LATEST_BRAVE = "150.0.7871.46";
const PREVIEW_LATEST_SAFARI = "26.5.2";
const PREVIEW_IOS_VER = "26.5";
function previewLatestVersion(browser, os) {
  const b = (browser || "chrome").toLowerCase();
  if (b === "brave") return PREVIEW_LATEST_BRAVE;
  if (b === "safari") return PREVIEW_LATEST_SAFARI;
  return PREVIEW_LATEST_CHROME[(os || "windows").toLowerCase()] || "150.0.7871.46";
}

function updateUAPreview() {
  const mode = $("fp-userAgent")?.value;
  const os   = $("fp-os")?.value || "windows";
  const br   = $("fp-browser")?.value || "chrome";
  const preview = $("uaPreview");
  if (!preview) return;
  if (mode === "manual") { preview.textContent = ""; return; }
  const bvSel = $("fp-browserVersion")?.value;
  const customVal = ($("fp-browserVersionCustom")?.value || "").trim();
  // "auto" / bare major → current latest for this browser+OS (mirrors main
  // process); only an explicit custom full-version string is pinned.
  const bv = (bvSel === "custom" && customVal) ? customVal : previewLatestVersion(br, os);
  const full = bv.includes(".") ? bv : bv + ".0.0.0";
  const fv   = full.split(".")[0];

  const osStr = { windows: "Windows NT 10.0; Win64; x64", macos: "Macintosh; Intel Mac OS X 10_15_7", linux: "X11; Linux x86_64", android: "Linux; Android 14; Pixel 8 Build/UP1A.231005.007" }[os] || "Windows NT 10.0; Win64; x64";
  let ua;
  if (os === "ios") {
    const iosUA = `(iPhone; CPU iPhone OS ${PREVIEW_IOS_VER.replace(/\./g, "_")} like Mac OS X)`;
    if (br === "safari")     ua = `Mozilla/5.0 ${iosUA} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${PREVIEW_IOS_VER} Mobile/15E148 Safari/604.1`;
    else if (br === "firefox") ua = `Mozilla/5.0 ${iosUA} AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${fv}.0 Mobile/15E148 Safari/604.1`;
    else if (br === "edge")  ua = `Mozilla/5.0 ${iosUA} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${PREVIEW_IOS_VER} EdgiOS/${full} Mobile/15E148 Safari/604.1`;
    else                     ua = `Mozilla/5.0 ${iosUA} AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${full} Mobile/15E148 Safari/604.1`;
  } else if (br === "firefox")     ua = `Mozilla/5.0 (${osStr}; rv:${fv}.0) Gecko/20100101 Firefox/${fv}.0`;
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

  // Preserve whatever the user already picked BEFORE we rebuild the <option>s.
  // Rewriting innerHTML resets the <select> to its first option (120), so
  // without this the guard `if (!verSel.value)` never fires and every field
  // change silently snapped the version back to 120. Capture, rebuild, restore.
  const prev = verSel.value;
  let latest = "150";

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
    latest = "137";
    if (hint) hint.textContent = "Sets the Firefox version in the auto-generated User-Agent string.";
  } else if (br === "safari") {
    verSel.innerHTML = `
      <option value="16.6">16.6</option>
      <option value="17.0">17.0</option>
      <option value="17.4">17.4</option>
      <option value="17.5">17.5 (latest)</option>
      <option value="custom">Custom…</option>`;
    latest = "17.5";
    if (hint) hint.textContent = "Sets the Safari version in the auto-generated User-Agent string.";
  } else if (br === "brave") {
    verSel.innerHTML = `
      <option value="120">Brave 1.62 / Chromium 120</option>
      <option value="122">Brave 1.64 / Chromium 122</option>
      <option value="124">Brave 1.66 / Chromium 124</option>
      <option value="128">Brave 1.70 / Chromium 128</option>
      <option value="131">Brave 1.73 / Chromium 131</option>
      <option value="136">Brave 1.78 / Chromium 136</option>
      <option value="148">Brave 1.90 / Chromium 148</option>
      <option value="150">Brave 1.92 / Chromium 150 (latest)</option>
      <option value="custom">Custom…</option>`;
    latest = "150";
    if (hint) hint.textContent = "Brave uses Chromium's UA (intentional, for anti-fingerprinting). Sites detect Brave via navigator.brave.isBrave(), which Privacy Shield enables automatically for Brave profiles.";
  } else if (br === "edge") {
    verSel.innerHTML = `
      <option value="120">120</option>
      <option value="122">122</option>
      <option value="124">124</option>
      <option value="131">131</option>
      <option value="136">136</option>
      <option value="148">148</option>
      <option value="150">150 (latest)</option>
      <option value="custom">Custom…</option>`;
    latest = "150";
    if (hint) hint.textContent = "Edge appends Edg/<version> to the UA so sites can detect it.";
  } else {
    verSel.innerHTML = `
      <option value="120">120</option>
      <option value="122">122</option>
      <option value="124">124</option>
      <option value="131">131</option>
      <option value="136">136</option>
      <option value="148">148</option>
      <option value="150">150 (latest)</option>
      <option value="custom">Custom…</option>`;
    latest = "150";
    const name = browserLabel(br);
    if (hint) hint.textContent = `Sets the ${name} version in the auto-generated User-Agent string.`;
  }

  // Restore the prior pick if it's still valid for this browser; otherwise
  // fall back to the latest version (NOT the first option, which is oldest).
  // "auto" from the static markup also maps to latest.
  const stillValid = prev && prev !== "auto" && Array.from(verSel.options).some((o) => o.value === prev);
  verSel.value = stillValid ? prev : latest;
  updateUAPreview();
}

function setBrowserVersionValue(version) {
  const value = String(version || "150");
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
  syncSelectAllCheckbox();
}

// Visible-profile ids = what's currently rendered in the sidebar (after filters)
function visibleProfileIds() {
  const list = $("profileList");
  if (!list) return [];
  return Array.from(list.querySelectorAll(".pm-card-check")).map((cb) => cb.dataset.id).filter(Boolean);
}

function syncSelectAllCheckbox() {
  const master = $("selectAllCheck");
  const label = $("selectAllText");
  if (!master) return;
  const visible = visibleProfileIds();
  if (!visible.length) {
    master.checked = false;
    master.indeterminate = false;
    if (label) label.textContent = "Select all";
    return;
  }
  const selectedVisible = visible.filter((id) => selected.has(id));
  if (selectedVisible.length === 0) {
    master.checked = false;
    master.indeterminate = false;
  } else if (selectedVisible.length === visible.length) {
    master.checked = true;
    master.indeterminate = false;
  } else {
    master.checked = false;
    master.indeterminate = true;
  }
  if (label) label.textContent = `Select all (${visible.length})`;
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
  const dcWarn = $("datacenterWarn");
  res.textContent = "Testing…";
  res.className = "pm-proxy-result";
  if (dcWarn) dcWarn.hidden = true;
  renderProxyDetectResult(null);

  const data = collectForm();
  if (selectedId) await msg("PROFILE_UPDATE", { id: selectedId, data });
  const px = data.proxy;
  const mode = px.networkMode || (px.enabled ? "proxy" : "direct");

  if (mode === "vpn") {
    const captured = await captureCurrentVpnLocation(res);
    if (captured?.ok) {
      res.textContent = `VPN mode OK — IP: ${captured.network.ip}${captured.network.country ? " · " + captured.network.country : ""}`;
      res.className = "pm-proxy-result ok";
    }
    return;
  }
  if (mode === "direct") {
    res.textContent = "Direct mode — no proxy applied.";
    res.className = "pm-proxy-result ok";
    return;
  }
  if (!px.host || !px.port) {
    res.textContent = "Proxy host and port are required when proxy mode is on.";
    res.className = "pm-proxy-result err";
    return;
  }

  // Step 1: connectivity check (fast)
  const r = await msg("TEST_PROXY", { host: px.host, port: px.port, scheme: px.scheme, username: px.username, password: px.password });
  if (!r.ok) {
    res.textContent = "Failed: " + (r.error || "unknown");
    res.className = "pm-proxy-result err";
    return;
  }
  res.textContent = `Connected — IP: ${r.ip}. Detecting location…`;
  res.className = "pm-proxy-result ok";

  // Step 2: geo detection through the proxy
  const geo = await msg("PROXY_DETECT_LOCATION", { host: px.host, port: px.port, scheme: px.scheme, username: px.username, password: px.password });
  if (!geo.ok || !geo.network) {
    res.textContent = `Connected — IP: ${r.ip} (location lookup failed)`;
    return;
  }
  const n = geo.network;
  const stableProxyType = n.proxyType && n.proxyType !== "unknown"
    ? n.proxyType
    : (px.proxyType && px.proxyType !== "unknown" ? px.proxyType : "unknown");
  n.proxyType = stableProxyType;
  res.textContent = `Connected — IP: ${r.ip} · ${n.city ? n.city + ", " : ""}${n.country || ""}`;

  // Show datacenter warning
  if (dcWarn) dcWarn.hidden = n.proxyType !== "datacenter";

  // Store detection data and render result panel
  currentProxyDetection = {
    detectedCountryCode: n.countryCode || "",
    detectedCountry: n.country || "",
    detectedCity: n.city || "",
    detectedTimezone: n.timezone || "",
    detectedLatitude: n.latitude || "",
    detectedLongitude: n.longitude || "",
    detectedIp: n.ip || "",
    proxyType: n.proxyType || "unknown",
    detectedAt: Date.now()
  };
  renderProxyDetectResult(currentProxyDetection, n, () => applyProxyGeoToFingerprint(n));

  // Auto-populate fingerprint fields silently
  applyProxyGeoToFingerprint(n);

  // Save updated profile (now includes detection data)
  if (selectedId) {
    await msg("PROFILE_UPDATE", { id: selectedId, data: collectForm() });
    await loadProfiles();
    renderList();
  }
}

function applyProxyGeoToFingerprint(n) {
  if (!n) return;
  if (n.timezone) {
    setVal("fp-timezone", "manual");
    setVal("fp-timezoneValue", n.timezone);
    // Rough UTC offset from IANA id isn't needed — profile-store computes it
  }
  if (n.countryCode) {
    setVal("fp-language", "manual");
    setVal("fp-languageValue", languageForCountry(n.countryCode));
  }
  setVal("fp-geolocation", "manual");
  if (n.latitude) setVal("fp-geoLat", n.latitude);
  if (n.longitude) setVal("fp-geoLng", n.longitude);
  setVal("fp-geoAccuracy", 50);
  if (n.city) setVal("fp-city", n.city);
  if (n.state) setVal("fp-state", n.state);
  if (n.ispName) setVal("fp-ispName", n.ispName);
  if (n.ispAsn) setVal("fp-ispAsn", n.ispAsn);
  if (n.ispOrg || n.organization) setVal("fp-ispOrg", n.ispOrg || n.organization);
  // Mobile proxy detected — do NOT override the user's device. A desktop browser
  // on a mobile carrier IP is a normal tethered/hotspot setup and stays coherent,
  // so we keep whatever OS/device the profile already has instead of forcing
  // Android (which would switch a PC profile to a phone-size mobile identity).
  if (n.proxyType === "mobile") {
    const os = $("fp-os")?.value;
    if (os && !["android", "ios"].includes(os)) {
      toast("Mobile proxy detected — keeping your desktop device (mobile IP works fine with a PC identity)");
    }
  }
  updateConditionalRows();
  updateUAPreview();
}

function renderProxyDetectResult(detection, network, onFillClick) {
  const el = $("proxyDetectResult");
  if (!el) return;
  if (!detection || !detection.detectedCountryCode) { el.hidden = true; return; }

  const typeLabel = { mobile: "Mobile proxy", residential: "Residential", datacenter: "Datacenter", unknown: "Unknown type" };
  const typeClass = { mobile: "mobile", residential: "residential", datacenter: "datacenter", unknown: "" };
  const t = detection.proxyType || "unknown";
  const when = detection.detectedAt ? ` · detected ${new Date(detection.detectedAt).toLocaleTimeString()}` : "";

  el.innerHTML = `
    <div class="pdt-row">
      <span class="pdt-chip ${typeClass[t] || ""}">${typeLabel[t] || t}</span>
      <span class="pdt-chip">${detection.detectedCity ? detection.detectedCity + ", " : ""}${detection.detectedCountry || detection.detectedCountryCode.toUpperCase()}</span>
      ${detection.detectedTimezone ? `<span class="pdt-chip">${detection.detectedTimezone}</span>` : ""}
      <span class="pdt-chip" style="color:var(--muted)">${when}</span>
    </div>
    <div style="margin-top:6px;font-size:11px;color:var(--muted)">Timezone, language, and geolocation have been auto-filled from this location.</div>
  `;
  el.hidden = false;
}

async function captureCurrentVpnLocation(targetResult) {
  const res = targetResult || $("vpnCaptureResult");
  const btn = $("btnCaptureVpn");
  if (res) { res.textContent = "Capturing current IP…"; res.className = "pm-proxy-result"; }
  if (btn) btn.disabled = true;

  const r = await msg("NETWORK_CAPTURE_CURRENT");
  if (!r.ok || !r.network) {
    if (res) { res.textContent = "Failed: " + (r.error || "could not capture current IP"); res.className = "pm-proxy-result err"; }
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

  // Persist VPN detection so the consistency validator and auto-mode can use it
  currentProxyDetection = {
    detectedCountryCode: n.countryCode || "",
    detectedCountry: n.country || "",
    detectedCity: n.city || "",
    detectedTimezone: n.timezone || "",
    detectedLatitude: n.latitude || "",
    detectedLongitude: n.longitude || "",
    detectedIp: n.ip || "",
    proxyType: "vpn",
    detectedAt: Date.now()
  };
  // Show detected location chip in the VPN capture result area
  renderProxyDetectResult(currentProxyDetection);

  updateConditionalRows();
  updateUAPreview();
  if (selectedId) {
    await msg("PROFILE_UPDATE", { id: selectedId, data: collectForm() });
    await loadProfiles();
    renderList();
  }
  if (res) {
    res.textContent = `VPN captured: ${n.ip} · ${n.city ? n.city + ", " : ""}${n.country || ""}`;
    res.className = "pm-proxy-result ok";
  }
  toast("VPN location applied — timezone, language, and geo updated");
  if (btn) btn.disabled = false;
  return { ok: true, network: n };
}

// ── Always-on current-IP detector ───────────────────────────────────────────
// Unlike the "Capture current VPN/IP" button (which overwrites the fingerprint
// fields and saves the profile), this is read-only: it just shows what the PC's
// connection looks like RIGHT NOW so the user can see at a glance whether their
// VPN is on and where it exits. Runs automatically whenever a VPN/direct profile
// is open and refreshes on a timer + on window focus — no click required.
let _autoIpTimer = null;

function stopAutoIpDetect() {
  if (_autoIpTimer) { clearInterval(_autoIpTimer); _autoIpTimer = null; }
}

async function autoDetectCurrentIp() {
  const res = $("vpnCaptureResult");
  if (!res) return;
  const mode = $("px-networkMode")?.value;
  if (mode !== "vpn" && mode !== "direct") { stopAutoIpDetect(); return; }
  if (document.hidden) return;

  // Remember which profile this probe belongs to — if the user switches profile
  // while the (slow) network lookup is in flight, we must NOT paint stale text.
  const probeForId = selectedId;
  const r = await msg("NETWORK_CAPTURE_CURRENT");
  if (selectedId !== probeForId) return;
  if (($("px-networkMode")?.value) !== mode) return;

  if (!r.ok || !r.network) {
    res.textContent = "⚠️ No connection detected — VPN may be off or no internet (" + (r.error || "lookup failed") + ")";
    res.className = "pm-proxy-result err";
    return;
  }
  const n = r.network;
  const loc = [n.city, n.country || (n.countryCode || "").toUpperCase()].filter(Boolean).join(", ") || n.ip;

  // Compare the live connection to THIS profile's captured/expected location so
  // the line is per-profile and the user sees a mismatch immediately.
  const anchorCC = String(currentProxyDetection?.detectedCountryCode || "").toLowerCase();
  const anchorCity = String(currentProxyDetection?.detectedCity || "").trim().toLowerCase();
  const curCC = String(n.countryCode || "").toLowerCase();
  const curCity = String(n.city || "").trim().toLowerCase();
  const haveAnchor = Boolean(anchorCC);
  const mismatch = haveAnchor && (anchorCC !== curCC || (anchorCity && curCity && anchorCity !== curCity));
  const anchorLabel = currentProxyDetection
    ? (currentProxyDetection.detectedCity ? currentProxyDetection.detectedCity + ", " : "") + (currentProxyDetection.detectedCountry || anchorCC.toUpperCase())
    : "";

  if (mismatch) {
    res.textContent = `🔴 MISMATCH — this profile is ${anchorLabel}, but your VPN is now ${loc}. Switch your VPN back, or Start will warn you.`;
    res.className = "pm-proxy-result err";
  } else if (!n.isVpn && (n.connectionType === "residential" || n.connectionType === "mobile")) {
    res.textContent = `🔴 No VPN — this looks like your real ISP (${n.ispName || n.connectionType})${loc ? " · " + loc : ""}`;
    res.className = "pm-proxy-result err";
  } else if (haveAnchor) {
    res.textContent = `🟢 Matches profile location · ${loc} · ${n.ip}`;
    res.className = "pm-proxy-result ok";
  } else if (n.isVpn) {
    res.textContent = `🟢 VPN detected · ${loc} · ${n.ip}`;
    res.className = "pm-proxy-result ok";
  } else {
    res.textContent = `🟡 ${loc} · ${n.ip}`;
    res.className = "pm-proxy-result";
  }
}

function startAutoIpDetect() {
  stopAutoIpDetect();
  const mode = $("px-networkMode")?.value;
  if (mode !== "vpn" && mode !== "direct") return;
  autoDetectCurrentIp();
  _autoIpTimer = setInterval(autoDetectCurrentIp, 30000);
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
    if (action === "stealth") { e.stopPropagation(); openInStealthEngine(id); return; }
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

  // Select All master checkbox — toggles all currently-visible profiles
  $("selectAllCheck")?.addEventListener("change", (e) => {
    const visible = visibleProfileIds();
    if (e.target.checked) {
      for (const id of visible) selected.add(id);
    } else {
      for (const id of visible) selected.delete(id);
    }
    renderList();
  });

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
    if (!confirm(`Permanently delete ${trashed.length} trashed profile(s)? This removes them from this PC AND the cloud database and cannot be undone.`)) return;
    const res = await msg("PROFILE_PURGE_TRASH", {});
    await refreshOpenWindows();
    renderList();
    toast(res && res.ok ? `Trash emptied — ${res.count} removed` : "Trash emptied");
  });
}

function bindFormEvents() {
  $("btnGenIdentity")?.addEventListener("click", generateCoherentIdentity);
  $("btnSave").addEventListener("click", saveCurrentProfile);
  $("btnEdit")?.addEventListener("click", () => setEditMode(true));
  $("fp-engine")?.addEventListener("change", updateEngineHint);
  $("btnDelete").addEventListener("click", () => selectedId && deleteProfile(selectedId));
  $("btnDuplicate").addEventListener("click", () => selectedId && duplicateProfile(selectedId));
  $("btnAssignTab").addEventListener("click", () => selectedId && assignToTab(selectedId));
  $("btnTestProxy").addEventListener("click", testProxy);
  $("btnRandDeviceName").addEventListener("click", () => { $("fp-deviceNameValue").value = randDeviceName(); });

  // Rotation URL implies a mobile proxy, but that does NOT require a mobile
  // device — a desktop browser on a mobile IP is a normal tethered setup. Respect
  // the user's chosen OS instead of forcing Android / a phone-size viewport.
  $("px-rotationUrl")?.addEventListener("change", () => {
    const url = ($("px-rotationUrl")?.value || "").trim();
    if (!url) return;
    const os = $("fp-os")?.value;
    if (os && !["android", "ios"].includes(os)) {
      toast("Mobile proxy (rotation URL) — keeping your desktop device");
    }
  });

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

  // When the OS changes, force a coherent screen resolution. iPhone/Android
  // profiles get real device pixel sizes; desktop OSes get a sensible default.
  // Without this you can end up with "iPhone 1920x1080" which is impossible
  // and every fingerprinting library flags it as a bot.
  $("fp-os")?.addEventListener("change", () => {
    const os = $("fp-os")?.value;
    const presets = {
      ios:     { w: 390,  h: 844,  label: "iPhone 15" },         // also: 414x896, 428x926, 393x852
      android: { w: 412,  h: 915,  label: "Pixel 8" },           // also: 360x800, 393x873, 412x892
      windows: { w: 1920, h: 1080, label: "Windows 1080p" },
      macos:   { w: 1440, h: 900,  label: "MacBook 13\"" },
      linux:   { w: 1920, h: 1080, label: "Linux desktop" }
    };
    const preset = presets[os];
    if (!preset) return;
    setVal("fp-screen", "manual");
    setVal("fp-screenWidth", preset.w);
    setVal("fp-screenHeight", preset.h);
    if (typeof toast === "function") toast(`Screen set to ${preset.w}×${preset.h} (${preset.label})`);
    applyMobileUIMode(os);
    updateConditionalRows();
  });
  $("px-networkMode")?.addEventListener("change", () => {
    const mode = $("px-networkMode")?.value || "proxy";
    if (mode === "proxy") setVal("px-enabled", "true");
    if (mode === "vpn" || mode === "direct") setVal("px-enabled", "false");
    updateConditionalRows();
    if (mode === "vpn") captureCurrentVpnLocation();
    startAutoIpDetect();
  });
  $("btnCaptureVpn")?.addEventListener("click", captureCurrentVpnLocation);
  // Re-check the live connection whenever the app regains focus (e.g. after the
  // user toggled their VPN in another window).
  window.addEventListener("focus", () => { autoDetectCurrentIp(); });
  $("btnAuditProfile")?.addEventListener("click", auditCurrentProfile);

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
  $("btnImportProxies")?.addEventListener("click", importProxies);
  $("btnAssignProxies")?.addEventListener("click", assignProxiesToEachProfile);
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
let stealthRunning = new Set(); // profileIds with a live Stealthfox (Camoufox) window

async function refreshOpenWindows() {
  const r = await msg("PROFILE_GET_WINDOWS");
  openWindows = r.windows || {};
  try {
    const s = await msg("CAMOUFOX_RUNNING");
    stealthRunning = new Set((s && s.ids) || []);
  } catch (_) { /* keep last known */ }
}

function isProfileRunning(profileId) {
  return profileId in openWindows;
}

function setLaunchError(msg) {
  const el = $("launchError");
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
}

// "Lagos, Nigeria (NG)" / "Nigeria (NG)" / "—" from a captured network record.
function locationText(loc) {
  if (!loc) return "an unknown location";
  const parts = [];
  if (loc.city) parts.push(loc.city);
  if (loc.state && loc.state !== loc.city) parts.push(loc.state);
  if (loc.country) parts.push(loc.country);
  const cc = loc.countryCode ? ` (${String(loc.countryCode).toUpperCase()})` : "";
  return (parts.join(", ") || "an unknown location") + cc;
}

// Blocking VPN-location warning. Resolves "continue" (launch with the new IP)
// or "change" (cancel so the user can switch their VPN back). Nothing has
// launched at this point — the browser only opens after a "continue".
function showVpnLocationConfirm(r) {
  return new Promise((resolve) => {
    const existing = $("vpnLocModal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "vpnLocModal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(4,6,10,.72);backdrop-filter:blur(2px);";

    const lastIp = r.last && r.last.ip ? r.last.ip : "—";
    const curIp = r.current && r.current.ip ? r.current.ip : "—";

    overlay.innerHTML =
      '<div style="width:480px;max-width:92vw;background:#11151c;border:1px solid #2a3340;' +
      'border-radius:14px;padding:22px 22px 18px;box-shadow:0 18px 60px rgba(0,0,0,.55);' +
      'font-family:inherit;color:#e7edf5;">' +
        '<div style="font-size:16px;font-weight:700;margin-bottom:6px;">⚠️ VPN location changed</div>' +
        '<div style="font-size:13px;line-height:1.5;color:#aab6c4;margin-bottom:16px;">' +
          'This profile <b>“' + escapeHtml(r.profileName || "Profile") + '”</b> last ran on a different ' +
          'VPN location. Using a new location can make the account look suspicious. ' +
          'Switch your VPN back to the last location, or continue with the new one.' +
        '</div>' +
        '<div style="display:flex;gap:10px;margin-bottom:18px;">' +
          '<div style="flex:1;background:#0d1117;border:1px solid #243042;border-radius:10px;padding:10px 12px;">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6f8196;margin-bottom:4px;">Last time (keep this)</div>' +
            '<div style="font-size:13px;font-weight:600;color:#7ee0a6;">' + escapeHtml(locationText(r.last)) + '</div>' +
            '<div style="font-size:11px;color:#6f8196;margin-top:3px;">' + escapeHtml(lastIp) + '</div>' +
          '</div>' +
          '<div style="flex:1;background:#0d1117;border:1px solid #243042;border-radius:10px;padding:10px 12px;">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6f8196;margin-bottom:4px;">Right now</div>' +
            '<div style="font-size:13px;font-weight:600;color:#f0c674;">' + escapeHtml(locationText(r.current)) + '</div>' +
            '<div style="font-size:11px;color:#6f8196;margin-top:3px;">' + escapeHtml(curIp) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button id="vpnLocChange" style="padding:9px 16px;border-radius:9px;border:1px solid #3a4656;' +
            'background:#1b2330;color:#e7edf5;font-size:13px;font-weight:600;cursor:pointer;">Change VPN now</button>' +
          '<button id="vpnLocContinue" style="padding:9px 16px;border-radius:9px;border:1px solid #5a3a3a;' +
            'background:#2a1c1c;color:#f3b1b1;font-size:13px;font-weight:600;cursor:pointer;">Continue with new IP</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector("#vpnLocChange").addEventListener("click", () => done("change"));
    overlay.querySelector("#vpnLocContinue").addEventListener("click", () => done("continue"));
    // Clicking the dark backdrop = same as "Change" (safe default: do not launch).
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done("change"); });
  });
}

// ── Patched Chromium engine download (first-run) ────────────────────────────
// A prominent modal: confirm → live progress bar → done. Replaces the old
// confirm()+button-text approach, which updated the wrong button (the card's
// Start button is not #btnOpenWindow) so the user saw no progress and re-clicked.
let patchedDownloadActive = false;
let patchedProgressEl = null;

// Called from the MAIN_EVENT dispatcher on PATCHED_ENGINE_PROGRESS.
function patchedProgressUpdate(pct, done) {
  if (!patchedProgressEl) return;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (done || p >= 100) {
    patchedProgressEl.bar.style.width = "100%";
    patchedProgressEl.label.textContent = "Installing engine… (extracting, ~1 min)";
  } else {
    patchedProgressEl.bar.style.width = p + "%";
    patchedProgressEl.label.textContent = "Downloading engine… " + p + "%";
  }
}

function runPatchedEngineDownload() {
  return new Promise((resolve) => {
    if (patchedDownloadActive) { toast("Engine is already downloading…"); return resolve({ ok: false, busy: true }); }
    const existing = $("patchedDlModal"); if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "patchedDlModal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(4,6,10,.72);backdrop-filter:blur(2px);";
    overlay.innerHTML =
      '<div style="width:460px;max-width:92vw;background:#11151c;border:1px solid #2a3340;' +
      'border-radius:14px;padding:22px 22px 18px;box-shadow:0 18px 60px rgba(0,0,0,.55);' +
      'font-family:inherit;color:#e7edf5;">' +
        '<div style="font-size:16px;font-weight:700;margin-bottom:6px;">⬇ Patched Chromium engine</div>' +
        '<div style="font-size:13px;line-height:1.5;color:#aab6c4;margin-bottom:16px;">' +
          'This profile uses the bundled <b>Patched Chromium</b> engine (each profile becomes a different ' +
          'physical PC). It needs a one-time download of about <b>190&nbsp;MB</b>. Keep this window open — ' +
          'you\'ll see the progress here.' +
        '</div>' +
        '<div id="patchedDlProgWrap" style="display:none;margin-bottom:16px;">' +
          '<div style="height:12px;background:#0d1117;border:1px solid #243042;border-radius:8px;overflow:hidden;">' +
            '<div id="patchedDlBar" style="height:100%;width:0%;background:linear-gradient(90deg,#2b8a6e,#39c08f);transition:width .25s ease;"></div>' +
          '</div>' +
          '<div id="patchedDlLabel" style="font-size:12px;color:#9fb0c2;margin-top:8px;">Starting…</div>' +
        '</div>' +
        '<div id="patchedDlBtns" style="display:flex;gap:10px;justify-content:flex-end;">' +
          '<button id="patchedDlCancel" style="padding:9px 16px;border-radius:9px;border:1px solid #3a4656;' +
            'background:#1b2330;color:#e7edf5;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
          '<button id="patchedDlGo" style="padding:9px 16px;border-radius:9px;border:1px solid #2b6a55;' +
            'background:#123026;color:#8fe3bf;font-size:13px;font-weight:600;cursor:pointer;">Download &amp; start</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    const btns = overlay.querySelector("#patchedDlBtns");
    const go = overlay.querySelector("#patchedDlGo");
    const cancel = overlay.querySelector("#patchedDlCancel");
    const close = (val) => { patchedProgressEl = null; overlay.remove(); resolve(val); };

    cancel.addEventListener("click", () => { if (!patchedDownloadActive) close({ ok: false, cancelled: true }); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && !patchedDownloadActive) close({ ok: false, cancelled: true }); });

    const start = async () => {
      patchedDownloadActive = true;
      btns.style.display = "none";
      overlay.querySelector("#patchedDlProgWrap").style.display = "block";
      patchedProgressEl = { bar: overlay.querySelector("#patchedDlBar"), label: overlay.querySelector("#patchedDlLabel") };
      patchedProgressEl.label.textContent = "Starting download…";
      const dl = await msg("PATCHED_ENGINE_FETCH", {});
      patchedDownloadActive = false;
      if (dl && dl.ok) {
        if (patchedProgressEl) { patchedProgressEl.bar.style.width = "100%"; patchedProgressEl.label.textContent = "Engine ready ✓"; }
        setTimeout(() => close({ ok: true }), 600);
      } else {
        if (patchedProgressEl) { patchedProgressEl.label.textContent = "❌ " + ((dl && dl.error) || "Download failed") + " — check your connection."; patchedProgressEl.label.style.color = "#f3b1b1"; }
        btns.style.display = "flex";
        go.textContent = "Retry";
        cancel.textContent = "Close";
      }
    };
    go.addEventListener("click", () => { if (!patchedDownloadActive) start(); });
  });
}

// Launch a profile in the Camoufox "Stealth Engine" (patched Firefox) — for sites
// that defeat the in-app Chromium (Fiverr/PerimeterX). Engine-level fingerprint,
// no JS footprint. Separate process; the profile's proxy/geo/screen/OS are mapped
// into Camoufox in the main process.
async function openInStealthEngine(profileId) {
  const p = profiles.find((p) => p.id === profileId);
  // Start URL is OPT-IN. Only navigate if the profile has an explicit, real
  // startUrl (scheme or a dot). Otherwise open Firefox on a blank page and let
  // the user type their own URL — do NOT force-load any site (Fiverr used to be
  // hardcoded here, which dropped every launch straight into PerimeterX).
  let url = String((p && p.fingerprint && p.fingerprint.startUrl) || "").trim();
  if (!/^https?:\/\//i.test(url)) url = /\./.test(url) ? "https://" + url : "";
  // url === "" → main process passes no start URL → no forced navigation.
  toast("🦊 Launching Stealth Engine…");
  const r = await msg("PROFILE_OPEN_CAMOUFOX", { profileId, url });
  if (r && r.ok) {
    stealthRunning.add(profileId);   // so the card shows Live + a Stop button
    renderList();
    toast(r.reused ? "Stealth Engine window focused" : "Stealth Engine launched");
  } else {
    const reason = r && (r.reason || r.detail) || "unknown error";
    if (r && (r.reason === "binary-missing" || r.reason === "engine-not-installed")) {
      toast("Stealth Engine not installed yet. Run: npx camoufox-js fetch", 8000);
    } else {
      toast("Stealth Engine failed: " + reason, 8000);
    }
  }
}

async function openProfileWindow(profileId) {
  const btn = $("btnOpenWindow");
  setLaunchError(null);

  // Engine choice is a saved profile setting: Start launches whichever engine
  // the profile picked. Stealthfox routes to the Camoufox (patched Firefox) path.
  const chosen = profiles.find((p) => p.id === profileId);
  if (chosen && chosen.engine === "stealthfox") { return openInStealthEngine(profileId); }

  // Client-side required-field check (mirrors main-process check)
  const p = profiles.find((p) => p.id === profileId);
  if (p) {
    const px = p.proxy || {};
    const mode = px.networkMode || (px.enabled ? "proxy" : "direct");
    if (mode === "proxy" && px.enabled && (!px.host || !px.port)) {
      setLaunchError("Proxy host and port are required. Go to the Proxy tab, fill in the credentials, click Test & Detect, then save.");
      return;
    }
  }

  if (btn) { btn.textContent = "Starting…"; btn.disabled = true; }
  let r = await msg("PROFILE_OPEN_WINDOW", { profileId });

  // VPN location lock: the profile's VPN is in a different place than last time.
  // Nothing has launched yet — make the user decide before the browser opens.
  if (r.needsLocationConfirm) {
    const decision = await showVpnLocationConfirm(r);
    if (decision === "continue") {
      if (btn) { btn.textContent = "Starting…"; btn.disabled = true; }
      r = await msg("PROFILE_OPEN_WINDOW", { profileId, acceptNewLocation: true });
    } else {
      // "Change VPN now" / dismissed → do not launch. User switches their VPN
      // back to the last location, then clicks Start again.
      setLaunchError("Launch cancelled. Switch your VPN to " + locationText(r.last) + ", then click Start.");
      toast("Launch cancelled — VPN location not changed");
      if (btn) { btn.textContent = "Start"; btn.disabled = false; }
      return;
    }
  }

  // Same-exit-IP collision: another profile is already on this exact IP. Sharing
  // one IP links the accounts no matter how distinct the fingerprints are, so
  // make the user decide before the browser opens.
  if (r.needsIpConfirm) {
    const openNote = r.otherProfileOpen ? " (currently open)" : "";
    const proceed = confirm(
      "⚠ Same IP as another profile\n\n" +
      "\"" + (r.profileName || "This profile") + "\" would launch on IP " + r.sharedIp + ",\n" +
      "which \"" + (r.otherProfileName || "another profile") + "\"" + openNote + " is also using.\n\n" +
      "Two profiles on one IP can be linked as the same person — give this profile its own proxy for real separation.\n\n" +
      "Launch anyway on the shared IP?"
    );
    if (proceed) {
      if (btn) { btn.textContent = "Starting…"; btn.disabled = true; }
      r = await msg("PROFILE_OPEN_WINDOW", { profileId, acceptSharedIp: true });
    } else {
      setLaunchError("Launch cancelled — this profile shares IP " + r.sharedIp + " with \"" + (r.otherProfileName || "another profile") + "\". Give it its own proxy in the Proxy tab, then click Start.");
      toast("Launch cancelled — shared IP");
      if (btn) { btn.textContent = "Start"; btn.disabled = false; }
      return;
    }
  }

  // Patched Chromium engine not downloaded yet — show a modal with a live progress
  // bar (confirm → download → done), then retry the launch. The modal is a barrier,
  // so the user can't re-trigger Start while it downloads.
  if (!r.ok && r.reason === "needs-engine-download") {
    if (btn) { btn.textContent = "Start"; btn.disabled = false; }
    const res = await runPatchedEngineDownload();
    if (!res || !res.ok) {
      if (res && res.cancelled) setLaunchError("Patched Chromium engine not downloaded. Click Start to download it, or pick another engine.");
      return;
    }
    toast("Engine ready — launching");
    if (btn) { btn.textContent = "Starting…"; btn.disabled = true; }
    r = await msg("PROFILE_OPEN_WINDOW", { profileId });
  }

  if (!r.ok) {
    const errText = r.error || r.detail || "unknown error";
    setLaunchError(errText);
    toast("Failed to start — see error above");
  } else if (r.external) {
    toast(r.existing ? "Real browser already running" : "Real browser launched");
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
  // A Stealthfox (Camoufox) profile runs as a separate Firefox process, not a
  // Chromium window — stop it via the Camoufox path.
  if (stealthRunning.has(profileId)) {
    const r = await msg("PROFILE_CLOSE_CAMOUFOX", { profileId });
    stealthRunning.delete(profileId);
    if (!r || !r.ok) toast("Stop failed: " + ((r && r.detail) || "unknown"));
    else toast("Stealth Engine stopped");
    await refreshOpenWindows();
    renderList();
    return;
  }
  const r = await msg("PROFILE_CLOSE_WINDOW", { profileId });
  if (!r.ok) { toast("Stop failed: " + (r.error || "no open window")); return; }
  toast(r.external ? "Real browser stopped" : "Stopped — session saved");
  await refreshOpenWindows();
  renderList();
  updateSessionTab();
}

async function saveSession(profileId) {
  const r = await msg("PROFILE_SAVE_SESSION", { profileId });
  if (!r.ok) { toast("Save failed: " + (r.error || "no open window")); return; }
  await loadProfiles();
  toast(r.external ? "Real browser keeps its own session folder" : `Session saved — ${r.count} tab(s)`);
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
  toast(r.external ? "Real browser closed" : "Window closed and session saved");
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
  ng: { name: "Nigeria (Lagos)", timezone: "Africa/Lagos", offset: -60, language: "en-US", lat: 6.5244, lng: 3.3792, os: "linux", screenWidth: 1366, screenHeight: 768, browserVersion: "150", city: "Lagos", state: "Lagos State", ispName: "Airtel Networks Limited", ispAsn: "36873", ispOrg: "Airtel Networks Limited" }
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
  setVal("fp-tlsSpoof", String(Boolean(fp.tlsSpoof)));
  setVal("fp-spoofingLevel", fp.spoofingLevel || "full");
  setVal("fp-spoofSkipHosts", (fp.spoofSkipHosts || []).join(", "));
  setVal("fp-city", fp.city || "");
  setVal("fp-state", fp.state || "");
  setVal("fp-ispName", fp.ispName || "");
  setVal("fp-ispAsn", fp.ispAsn || "");
  setVal("fp-ispOrg", fp.ispOrg || fp.organization || "");
  setBrowserVersionValue(fp.browserVersion || "150");

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

// Parse one line of a pasted proxy list. Accepts:
//   host:port:user:pass   host:port   user:pass@host:port   scheme://user:pass@host:port
function parseProxyLine(line, defaultScheme) {
  line = String(line || "").trim();
  if (!line) return null;
  let scheme = defaultScheme || "http";
  const sm = line.match(/^(socks5|socks4|https?):\/\//i);
  if (sm) { scheme = sm[1].toLowerCase(); line = line.slice(sm[0].length); }
  let host, port, username = "", password = "";
  if (line.includes("@")) {
    const at = line.lastIndexOf("@");
    const cred = line.slice(0, at), hp = line.slice(at + 1);
    const cp = cred.split(":"); username = cp[0] || ""; password = cp.slice(1).join(":");
    const hpp = hp.split(":"); host = hpp[0]; port = Number(hpp[1]);
  } else {
    const parts = line.split(":");
    host = parts[0]; port = Number(parts[1]);
    if (parts.length >= 4) { username = parts[2]; password = parts.slice(3).join(":"); }
  }
  if (!host || !port || Number.isNaN(port)) return null;
  return { label: `${host}:${port}`, country: "", scheme, host, port, username, password, ispName: "", ispAsn: "", ispOrg: "", city: "", private: true, source: "private" };
}

async function importProxies() {
  const text = $("proxyImportText")?.value || "";
  const scheme = $("proxyImportScheme")?.value || "http";
  const status = $("proxyImportStatus");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { if (status) { status.textContent = "Paste at least one proxy line first."; status.className = "pm-proxy-result err"; } return; }
  let added = 0, bad = 0, dup = 0;
  for (const line of lines) {
    const entry = parseProxyLine(line, scheme);
    if (!entry) { bad++; continue; }
    if (proxyLibrary.some((e) => e.host === entry.host && String(e.port) === String(entry.port) && (e.username || "") === (entry.username || ""))) { dup++; continue; }
    const r = await msg("PROXY_LIB_ADD", { entry });
    if (r.ok && r.entry) { proxyLibrary.push(r.entry); added++; } else { bad++; }
  }
  renderProxyLibrary();
  if (added) $("proxyImportText").value = "";
  if (status) {
    status.textContent = `Imported ${added}${dup ? `, skipped ${dup} duplicate(s)` : ""}${bad ? `, ${bad} unreadable line(s)` : ""}. Library: ${proxyLibrary.length} total.`;
    status.className = added ? "pm-proxy-result ok" : "pm-proxy-result err";
  }
}

// Give each target profile its OWN distinct proxy IP (fixes the shared-VPN-IP
// linkability problem). Targets = checkbox-selected profiles, or all if none.
async function assignProxiesToEachProfile() {
  const status = $("proxyImportStatus");
  const pool = proxyLibrary.filter((e) => e && e.host && e.port);
  if (!pool.length) { if (status) { status.textContent = "No proxies in the library — import some first."; status.className = "pm-proxy-result err"; } return; }

  const targetIds = selected.size ? [...selected] : profiles.filter((p) => !p.deletedAt).map((p) => p.id);
  const targets = targetIds.map((id) => profiles.find((p) => p.id === id)).filter(Boolean);
  if (!targets.length) { toast("No profiles to assign"); return; }
  if (targets.length > pool.length && !confirm(`You have ${pool.length} prox${pool.length === 1 ? "y" : "ies"} but ${targets.length} profile(s). Only the first ${pool.length} will get a unique IP. Continue?`)) return;

  // Prefer proxies not already in use by some other profile, so re-running tops up.
  const inUse = new Set();
  for (const p of profiles) { const px = p.proxy || {}; if (px.host) inUse.add(px.host + ":" + px.port); }
  const ordered = [...pool.filter((e) => !inUse.has(e.host + ":" + e.port)), ...pool.filter((e) => inUse.has(e.host + ":" + e.port))];

  let assigned = 0, i = 0;
  for (const p of targets) {
    const e = ordered[i]; if (!e) break; i++;
    const proxy = { networkMode: "proxy", enabled: true, scheme: e.scheme || "http", host: e.host, port: Number(e.port) || 1080, username: e.username || "", password: e.password || "" };
    const r = await msg("PROFILE_UPDATE", { id: p.id, data: { proxy } });
    if (r.ok) assigned++;
  }
  await loadProfiles();
  renderList();
  const short = targets.length - assigned;
  if (status) {
    status.textContent = `Assigned a unique IP to ${assigned} profile(s)${short > 0 ? `; ${short} still unassigned (import ${short} more).` : "."}`;
    status.className = short > 0 ? "pm-proxy-result" : "pm-proxy-result ok";
  }
  toast(`Assigned ${assigned} proxies — one IP per profile`);
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
