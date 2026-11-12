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

let checking = null;
async function check() {
  if (checking) return checking;
  checking = (async () => {
    const cfg = await config();
    // Connected = another extension (the VPN) controls the proxy AND the internet
    // works through it. IPs alone are not enough: many home and mobile
    // connections show several public IPs.
    let vpnOn = false;
    try {
      const st = await chrome.proxy.settings.get({});
      vpnOn = st.levelOfControl === "controlled_by_other_extensions" && st.value && !["direct", "system"].includes(st.value.mode);
    } catch (_) {}
    let ip = "";
    if (vpnOn) {
      try { ip = (await (await fetch("https://api.ipify.org/?format=json", { cache: "no-store" })).json()).ip || ""; } catch (_) {}
    }
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
// Block first, then re-check: a VPN switching off must never leave a gap.
chrome.proxy.settings.onChange.addListener(() => { block().then(() => setTimeout(check, 1500)); });
check();
