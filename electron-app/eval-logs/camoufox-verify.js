process.env.CAMOUFOX_INSTALL_DIR = "C:/Users/UPCOMING/AppData/Roaming/privacy-shield/camoufox-engine";
const { app, screen } = require("electron");
const cam = require("../src/camoufox-manager");
function extract() {
  const o = {};
  try { o.screen = screen.width + "x" + screen.height; o.avail = screen.availWidth + "x" + screen.availHeight; } catch (e) {}
  try { o.outer = window.outerWidth + "x" + window.outerHeight; o.inner = window.innerWidth + "x" + window.innerHeight; } catch (e) {}
  try { o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  return o;
}
app.whenReady().then(async () => {
  const disp = screen.getPrimaryDisplay();
  console.log("REAL size=" + JSON.stringify(disp.size) + " workArea=" + JSON.stringify(disp.workAreaSize));
  const prof = { id: "camverify_win", os: "windows", browserApp: "chrome",
    fingerprint: { language: "auto", timezone: "auto", geolocation: "auto" },
    proxy: { networkMode: "vpn", detectedCountryCode: "de", detectedTimezone: "Europe/Berlin", detectedLatitude: 52.52, detectedLongitude: 13.405, detectedIp: "91.10.20.30" } };
  const opts = cam.profileToOptions(prof);
  console.log("FP_SCREEN:" + JSON.stringify(opts.fingerprint && opts.fingerprint.screen));
  opts.headless = true;
  const { pathToFileURL } = require("url");
  const mod = await import(pathToFileURL(require.resolve("camoufox-js")).href);
  const browser = await mod.Camoufox(opts);
  const page = (browser.pages && browser.pages().length) ? browser.pages()[0] : await browser.newPage();
  await page.goto("https://example.com/").catch(()=>{});
  console.log("CFXV_JSON:" + JSON.stringify(await page.evaluate(extract)));
  await browser.close();
  app.exit(0);
}).catch(e => { console.log("ERR:" + (e && (e.stack||e))); app.exit(1); });
