// VPN Guard: the static "block" ruleset stops every website, always. When the
// profile's VPN extension controls the browser proxy and the internet works
// through it, a SESSION "allow" rule lifts the block. Session rules are wiped
// whenever the browser starts, so every launch begins blocked no matter how the
// last one ended. Re-checked every 30 s and whenever the proxy settings change,
// so a VPN drop blocks again at once. config.json (written per launch by Privacy
// Shield) holds realIp and statusUrl; an exit equal to realIp is never allowed.
// It is read on every check: Chrome keeps this script cached between launches,
// so values baked into the script would go stale.
async function config() {
  try { return await (await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" })).json(); } catch (_) { return {}; }
}

const ALLOW_ID = 100;
const ALLOW = {
  id: ALLOW_ID, priority: 2, action: { type: "allow" },
  condition: {
    regexFilter: "^(https?|wss?)://",
    resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"]
  }
};

const block = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ALLOW_ID] });
const allow = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ALLOW_ID], addRules: [ALLOW] });

// The exit IP, asked through the VPN. Several services, because sites behind
// Cloudflare often challenge VPN IPs. Last resort: the IP the connection page saw
// (its requests go through the VPN like the user's browsing does).
async function exitIp(cfg) {
  const services = [
    ["https://api.ipify.org/?format=json", (t) => JSON.parse(t).ip],
    ["https://icanhazip.com", (t) => t.trim()],
    ["https://www.cloudflare.com/cdn-cgi/trace", (t) => (/^ip=(.+)$/m.exec(t) || [])[1]]
  ];
  const errors = [];
  for (const [url, parse] of services) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const ip = res.ok ? String(parse(await res.text()) || "").trim() : "";
      if (/^[\d.:a-f]+$/i.test(ip)) return { ip, via: new URL(url).host };
      errors.push(new URL(url).host + " " + res.status);
    } catch (e) { errors.push(new URL(url).host + " " + (e.message || e)); }
  }
  if (cfg.statusUrl) {
    try {
      const r = await (await fetch(cfg.statusUrl + "page-ip", { cache: "no-store" })).json();
      if (r && r.ip && Date.now() - r.at < 120000) return { ip: r.ip, via: "connection page" };
    } catch (_) {}
  }
  return { ip: "", error: errors.join("; ") };
}

let checking = null;
async function check() {
  if (checking) return checking;
  checking = (async () => {
    const cfg = await config();
    // Connected = another extension (the VPN) controls the proxy AND the internet
    // works through it. IPs alone are not enough: many home and mobile
    // connections show several public IPs.
    let vpnOn = false, control = "", mode = "";
    try {
      const st = await chrome.proxy.settings.get({});
      control = st.levelOfControl; mode = (st.value && st.value.mode) || "";
      // The guard never sets a proxy, so any active proxy setting is the VPN
      // extension's. Not levelOfControl: Chrome reports "controllable_by_this_
      // extension" whenever the guard was loaded after the VPN (it outranks it),
      // even while the VPN is in control, and that kept every site blocked.
      vpnOn = Boolean(st.value) && !["direct", "system"].includes(st.value.mode) && st.levelOfControl !== "controlled_by_this_extension";
    } catch (_) {}
    let ip = "", ipError = "", via = "";
    if (vpnOn) ({ ip, error: ipError, via } = await exitIp(cfg));
    let safe = vpnOn && Boolean(ip) && ip !== cfg.realIp;
    // Team IP check (Privacy Shield): another open profile of the team on this
    // exact IP. If the app cannot be reached, only the VPN check applies.
    let sharedWith = "";
    if (safe && cfg.statusUrl) {
      try {
        const r = await (await fetch(cfg.statusUrl + "allowed?ip=" + encodeURIComponent(ip), { cache: "no-store" })).json();
        if (r && r.ok === false) { sharedWith = r.inUseBy || "another profile"; safe = false; }
      } catch (_) {}
    }
    await (safe ? allow() : block());
    await chrome.action.setBadgeText({ text: safe ? "ON" : sharedWith ? "IP" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: safe ? "#16a34a" : sharedWith ? "#d97706" : "#dc2626" });
    await chrome.action.setTitle({ title: safe ? `VPN connected — ${ip}`
      : sharedWith ? `IP ${ip} is in use by "${sharedWith}". Pick a different city in your VPN extension. Websites are blocked.`
      : "VPN not connected — websites are blocked. Connect in your VPN extension." });
    await chrome.storage.session.set({ ip, safe, sharedWith, at: Date.now() });
    // Shown on the connection page and written to the app log, so a block can be explained.
    if (cfg.statusUrl) {
      fetch(cfg.statusUrl + "guard-state", { method: "POST", body: JSON.stringify({ vpnOn, control, mode, ip, via, ipError: ipError || "", realIp: ip && ip === cfg.realIp, sharedWith, safe }) }).catch(() => {});
    }
  })().finally(() => { checking = null; });
  return checking;
}

// Fast checks for the first two minutes (VPN connecting), then every 30 s.
function start() {
  chrome.alarms.create("vpn-check", { periodInMinutes: 0.5 });
  let n = 0;
  const fast = setInterval(() => { check(); if (++n >= 40) clearInterval(fast); }, 3000);
}

chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "vpn-check") check(); });
// Every time the worker starts, not only at browser start / install: a missing
// alarm meant no re-check once the worker had gone idle.
chrome.alarms.get("vpn-check").then((a) => { if (!a) chrome.alarms.create("vpn-check", { periodInMinutes: 0.5 }); });
// Block first, then re-check: a VPN switching off must never leave a gap.
chrome.proxy.settings.onChange.addListener(() => { block().then(() => setTimeout(check, 1500)); });
check();
