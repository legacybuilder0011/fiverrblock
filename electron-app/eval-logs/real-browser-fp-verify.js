"use strict";
// Verify the Real Chrome/Brave fingerprint extension actually spoofs.
// Run under Electron so real-browser-manager's `require("electron")` works:
//   node_modules/electron/dist/electron.exe eval-logs/real-browser-fp-verify.js -- [brave]
// Spins a localhost server, launches real Chrome via the manager pointed at a test
// page, and compares what the page reports to the profile config.

const { app } = require("electron");
const http = require("http");
const path = require("path");

const useBrave = process.argv.includes("brave");
const engine = useBrave ? "real-brave" : "real-chrome";

const store = require(path.join(__dirname, "..", "src", "profile-store"));
const realBrowser = require(path.join(__dirname, "..", "src", "real-browser-manager"));

// A profile with distinctive values so we can tell spoof-vs-real apart.
const PROFILE = {
  id: "verify-real-fp",
  name: "Verify Real FP",
  os: "windows",
  browserApp: "chrome",
  engine,
  proxy: { networkMode: "direct", enabled: false },
  fingerprint: {
    browser: "chrome",
    fingerprintSeed: "verify-seed-777",
    cpuCores: "manual", cpuCoresValue: 12,
    ram: "manual", ramValue: 8,
    webglInfo: "manual",
    webglVendor: "Google Inc. (AMD)",
    webglRenderer: "ANGLE (AMD, AMD Radeon RX 6800 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    timezone: "manual", timezoneValue: "Europe/Berlin", timezoneOffset: -60,
    language: "manual", languageValue: "de-DE",
    geolocation: "manual", geoLat: 52.52, geoLng: 13.405, geoAccuracy: 40,
    canvas: "noise", webgl: "noise", audio: "noise",
    screen: "manual", screenWidth: 1536, screenHeight: 864
  }
};

const cfg = store.buildConfigFromProfile(PROFILE);
console.log("Resolved config:");
console.log("  UA:        ", cfg.userAgent);
console.log("  platform:  ", cfg.platform);
console.log("  cores/mem: ", cfg.hardwareConcurrency, "/", cfg.deviceMemory);
console.log("  tz/lang:   ", cfg.timezone, "/", cfg.language);
console.log("  gpu:       ", cfg._gpuVendor, "|", cfg._gpuRenderer);
console.log("  screen:    ", cfg.screen.width + "x" + cfg.screen.height);
console.log("  geo:       ", cfg.geo.latitude + "," + cfg.geo.longitude);

let server, resolved = false;
const TEST_HTML = `<!doctype html><meta charset=utf-8><title>fp</title><script>
(async function(){
  function gpu(){ try{ var c=document.createElement("canvas"); var gl=c.getContext("webgl"); var e=gl.getExtension("WEBGL_debug_renderer_info"); return {vendor:gl.getParameter(e.UNMASKED_VENDOR_WEBGL), renderer:gl.getParameter(e.UNMASKED_RENDERER_WEBGL)}; }catch(_){ return {vendor:"ERR",renderer:"ERR"};} }
  function canvasHash(){ try{ var c=document.createElement("canvas"); c.width=200;c.height=50; var x=c.getContext("2d"); x.textBaseline="top"; x.font="16px Arial"; x.fillStyle="#069"; x.fillText("PrivacyShield❤",2,2); return c.toDataURL().slice(-32);}catch(_){return "ERR";} }
  var geo = await new Promise(function(res){ try{ navigator.geolocation.getCurrentPosition(function(p){res(p.coords.latitude+","+p.coords.longitude);}, function(){res("denied");}, {timeout:2000}); }catch(_){res("noapi");} });
  var g = gpu();
  var out = {
    ua: navigator.userAgent, platform: navigator.platform,
    cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    lang: navigator.language, langs: (navigator.languages||[]).join(","),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date(Date.UTC(2025,0,15)).getTimezoneOffset(),
    screen: screen.width+"x"+screen.height, avail: screen.availWidth+"x"+screen.availHeight,
    gpuVendor: g.vendor, gpuRenderer: g.renderer,
    canvas: canvasHash(), geo: geo, webdriver: navigator.webdriver
  };
  navigator.sendBeacon("/report", JSON.stringify(out));
  document.title = "reported";
})();
</script>Loading...`;

function check(label, got, want) {
  const pass = String(got) === String(want);
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${label}: got=${got}` + (pass ? "" : ` want=${want}`));
  return pass;
}

app.whenReady().then(() => {
  server = http.createServer((req, res) => {
    if (req.url === "/report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.end("ok");
        if (resolved) return; resolved = true;
        let r = {};
        try { r = JSON.parse(body); } catch (_) {}
        console.log("\nReal browser reported:");
        console.log(JSON.stringify(r, null, 2));
        console.log("\nChecks (spoof applied inside real " + engine + "):");
        let ok = 0, total = 0;
        const t = (l, g, w) => { total++; if (check(l, g, w)) ok++; };
        t("hardwareConcurrency", r.cores, cfg.hardwareConcurrency);
        t("deviceMemory", r.mem, cfg.deviceMemory);
        t("platform", r.platform, cfg.platform);
        t("navigator.language", r.lang, cfg.language);
        t("timezone (TZ env)", r.tz, cfg.timezone);
        t("tzOffset Jan (min)", r.tzOffset, cfg.localeOffsetMinutes);
        t("screen", r.screen, cfg.screen.width + "x" + cfg.screen.height);
        t("webgl vendor", r.gpuVendor, cfg._gpuVendor);
        t("webgl renderer", r.gpuRenderer, cfg._gpuRenderer);
        t("geolocation", r.geo, cfg.geo.latitude + "," + cfg.geo.longitude);
        t("userAgent (flag)", r.ua, cfg.userAgent);
        t("webdriver false", r.webdriver, false);
        console.log(`\nRESULT: ${ok}/${total} spoof checks passed. canvas tail=${r.canvas}`);
        setTimeout(async () => { try { await realBrowser.closeProfile(PROFILE.id); } catch (_) {} server.close(); app.quit(); }, 1500);
      });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(TEST_HTML);
  });
  server.listen(0, "127.0.0.1", async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    console.log("\nTest server:", url, "\nLaunching", engine, "...");
    const st = await realBrowser.status(PROFILE.id, engine);
    console.log("Engine status: ready=" + st.ready + " version=" + st.version + " path=" + st.path);
    const res = await realBrowser.launchProfile(PROFILE, url, {});
    console.log("launchProfile:", JSON.stringify(res));
    if (!res.ok) { console.log("LAUNCH FAILED — aborting"); server.close(); app.quit(); }
    setTimeout(() => { if (!resolved) { console.log("\nTIMEOUT: no report from browser in 25s (extension may not have loaded / page blocked)"); realBrowser.closeProfile(PROFILE.id).catch(()=>{}); server.close(); app.quit(); } }, 25000);
  });
});
