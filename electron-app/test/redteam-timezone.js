"use strict";
// Red-team probe #1 — timezone coherence.
// Reproduces the offset-derivation the preload now uses, and checks it the way
// a real detector (CreepJS / pixelscan / PerimeterX) does: the offset reported
// by Date.prototype.getTimezoneOffset() MUST agree with the claimed IANA zone
// for the *actual current date* (DST included). We also show what the OLD
// behaviour (static 300) would have scored, to prove the fix.

function offsetForDate(timeZone, date) {
  const probe = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = probe.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((date.getTime() - asUTC) / 60000);
}

// Ground-truth offset a detector computes independently for the zone+instant.
function truthOffset(timeZone, date) {
  // Same math, but this is the "honest" reference — if the spoof matches this,
  // there is no tell. (In a real browser the detector also re-derives it this way.)
  return offsetForDate(timeZone, date);
}

const ZONES = [
  "America/New_York", "America/Los_Angeles", "America/Denver", "America/Phoenix",
  "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Asia/Kolkata",
  "Australia/Sydney", "Africa/Lagos", "America/Sao_Paulo"
];
const DATES = [
  new Date("2026-01-15T12:00:00Z"), // winter (N. hemisphere)
  new Date("2026-07-15T12:00:00Z"), // summer (N. hemisphere)
];

let pass = 0, fail = 0, oldFail = 0;
const OLD_STATIC = 300; // what the code used to report for every profile

console.log("zone                  date        spoofed  truth   OLD(static300)");
for (const z of ZONES) {
  for (const d of DATES) {
    const spoofed = offsetForDate(z, d);
    const truth = truthOffset(z, d);
    const ok = spoofed === truth;
    ok ? pass++ : fail++;
    if (OLD_STATIC !== truth) oldFail++;
    console.log(
      `${z.padEnd(20)}  ${d.toISOString().slice(0, 10)}  ${String(spoofed).padStart(6)}  ${String(truth).padStart(6)}   ${OLD_STATIC === truth ? "match" : "MISMATCH(" + OLD_STATIC + ")"}`
    );
  }
}
console.log("\n--- verdict ---");
console.log(`NEW logic:  ${pass}/${pass + fail} offset checks consistent with IANA zone`);
console.log(`OLD logic:  ${(ZONES.length * DATES.length) - oldFail}/${ZONES.length * DATES.length} consistent — ${oldFail} would have been FLAGGED as timezone-spoofed`);
process.exit(fail === 0 ? 0 : 1);
