// Drives the REAL buildConfigFromProfile with simulated VPN exits (what
// captureCurrentNetwork writes into profile.proxy.detected* at launch) and
// checks that auto timezone/language/geo align with the VPN country.
// Two capture qualities per country: FULL (tz+lat/lon present) and
// COUNTRY-ONLY (some IP providers return just the country) — the latter is the
// partial-capture case that must still align to prevent a location mismatch.
// Usage: electron vpn-align-test.js
const { app } = require("electron");
const store = require("../src/profile-store");

function mkProfile(detected) {
  // A profile whose location fields are all "auto" and whose device default tz
  // is America/New_York (so any fall-through to the default is visible as a mismatch).
  return {
    id: "vpn-test", name: "VPN Test",
    fingerprint: {
      timezone: "auto", timezoneValue: "America/New_York", timezoneOffset: 300,
      language: "auto", languageValue: "en-US",
      geolocation: "auto", geoLat: 40.7128, geoLng: -74.006, geoAccuracy: 50,
      fingerprintSeed: "seed-vpn", countryCode: "us",
    },
    proxy: { networkMode: "vpn", enabled: false, ...detected },
    os: "windows", browserApp: "chrome",
  };
}

// Simulated live VPN exits as captureCurrentNetwork would persist them.
const CASES = {
  "DE full":         { detectedCountryCode: "de", detectedTimezone: "Europe/Berlin", detectedLatitude: 52.52, detectedLongitude: 13.405 },
  "DE country-only": { detectedCountryCode: "de" },
  "JP full":         { detectedCountryCode: "jp", detectedTimezone: "Asia/Tokyo", detectedLatitude: 35.68, detectedLongitude: 139.76 },
  "JP country-only": { detectedCountryCode: "jp" },
  "GB country-only": { detectedCountryCode: "gb" },
};

// Which continent a timezone belongs to — used to flag a mismatch (e.g. a DE VPN
// but an America/* timezone).
function tzRegion(tz) { return String(tz || "").split("/")[0]; }
const COUNTRY_REGION = { de: "Europe", jp: "Asia", gb: "Europe" };

app.whenReady().then(() => {
  const out = [];
  for (const [name, detected] of Object.entries(CASES)) {
    const cfg = store.buildConfigFromProfile(mkProfile(detected));
    const cc = detected.detectedCountryCode;
    const tzOk = tzRegion(cfg.timezone) === COUNTRY_REGION[cc];
    const langOk = String(cfg.language || "").toLowerCase().startsWith(cc === "gb" ? "en-gb" : (cc === "de" ? "de" : (cc === "jp" ? "ja" : "")));
    // geo should be near the country, not New York (lat 40.71 / lon -74)
    const geoOk = !(Math.abs((cfg.geo || {}).latitude - 40.7128) < 0.5 && Math.abs((cfg.geo || {}).longitude + 74.006) < 0.5);
    out.push({ case: name, tz: cfg.timezone, lang: cfg.language, geo: cfg.geo ? [cfg.geo.latitude, cfg.geo.longitude] : null, tzOk, langOk, geoOk, ALIGNED: tzOk && langOk && geoOk });
  }
  console.log("VPN_JSON:" + JSON.stringify(out, null, 1));
  app.exit(0);
}).catch((e) => { console.log("VPN_ERR:" + (e && (e.stack || e.message || e))); app.exit(1); });
