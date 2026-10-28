"use strict";
// A patched launch that stays up with no window must retry once on software GL.
// The spoofed graphics name stays on. The adjustment is remembered.
const assert = require("assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const startup = require("../src/browser-startup");

function child(pid) {
  const c = new EventEmitter();
  Object.assign(c, {
    pid,
    exitCode: null,
    killed: false,
    kill() { this.killed = true; this.exitCode = 0; this.emit("exit", 0); }
  });
  return c;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-retry-"));
const bin = path.join(tmp, "fingerprint-chromium", "ungoogled-chromium_148.0.7778.215-1.1_windows_x64", "chrome.exe");
fs.mkdirSync(path.dirname(bin), { recursive: true });
fs.writeFileSync(bin, "test stub");
const original = Module._load;
const spawned = [];
Module._load = function (req, parent, main) {
  if (req === "electron") return { app: { getPath: () => tmp } };
  if (req === "child_process") {
    return {
      spawn: (exe, args) => {
        const c = child(300 + spawned.length);
        spawned.push({ exe, args, c });
        return c;
      },
      execFile: (exe, args, opts, cb) => cb(null, "")
    };
  }
  if (req === "./browser-startup") {
    return {
      waitForWindow: (c) => startup.waitForWindow(c, async () => {
        const item = spawned.find((entry) => entry.c === c);
        const softwareGl = item.args.includes("--use-angle=swiftshader");
        if (!softwareGl) return { ok: false, reason: "window-missing" };
        return { ok: true };
      }),
      restoreWindow: async () => ({ ok: true })
    };
  }
  if (req === "./profile-store") {
    return {
      buildConfigFromProfile: () => ({
        enabled: false,
        _uaVersion: "148",
        _platformVersion: "10.0.0",
        hardwareConcurrency: 4,
        timezone: "America/New_York",
        language: "en-US"
      })
    };
  }
  if (req === "./local-proxy-bridge") return { getBridge: async () => null, stopBridge() {} };
  return original.call(this, req, parent, main);
};

const manager = require("../src/real-browser-manager");
const profile = { id: "retry-profile", engine: "patched-chromium", proxy: { enabled: false }, fingerprint: {} };

(async () => {
  const first = await manager.launchProfile(profile, "about:blank");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(spawned.length, 2, "a missing window retries once");
  assert.equal(spawned[0].args.includes("--disable-spoofing=gpu"), false);
  assert.equal(spawned[0].args.includes("--disable-spoofing=font"), true);
  assert.equal(spawned[0].args.includes("--fingerprint-brand=Chrome"), true);
  assert.equal(spawned[0].args.includes("--fingerprint-platform=windows"), true);
  assert.equal(spawned[0].args.includes("--fingerprint-brand-version=148.0.7778.215"), true);
  assert.equal(spawned[0].args.includes("--accept-lang=en-US,en"), true);
  assert.equal(spawned[0].args.some((arg) => arg.startsWith("--user-agent=")), false);
  assert.equal(spawned[1].args.includes("--disable-spoofing=gpu"), false);
  assert.equal(spawned[1].args.includes("--disable-spoofing=font"), true);
  assert.equal(spawned[1].args.includes("--use-angle=swiftshader"), true);
  assert.ok(spawned[1].args.some((arg) => arg.startsWith("--fingerprint=")));
  assert.equal(spawned[0].c.killed, true, "the windowless process is stopped");
  const marker = path.join(tmp, "real-browser-profiles", "retry-profile", "patched-launch.json");
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).disableGpuSpoof, true);

  await manager.closeProfile(profile.id);
  const second = await manager.launchProfile(profile, "about:blank");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(spawned.length, 3, "the remembered adjustment skips the failing start");
  assert.equal(spawned[2].args.includes("--disable-spoofing=gpu"), false);
  assert.equal(spawned[2].args.includes("--disable-spoofing=font"), true);
  assert.equal(spawned[2].args.includes("--use-angle=swiftshader"), true);
  assert.equal(spawned[2].args.includes("--fingerprint=" + first.seed) || spawned[2].args.some((arg) => arg.startsWith("--fingerprint=")), true);
  const spec = manager.cloudLaunchSpec(profile, { language: "en-US", timezone: "America/New_York", hardwareConcurrency: 4, _platformVersion: "10.0.0" });
  assert.equal(spec.args.includes("--disable-spoofing=font"), false);
  assert.ok(spec.args.some((arg) => arg.startsWith("--fingerprint=")));
  assert.ok(spec.args.includes("--lang=en-US"));
  assert.ok(spec.args.includes("--timezone=America/New_York"));
  assert.equal(spec.args.includes("--fingerprint-brand=Chrome"), true);
  assert.equal(spec.args.some((arg) => arg.startsWith("--disable-spoofing=")), false);
  assert.equal(spec.args.some((arg) => arg.startsWith("--user-agent=")), false);

  const edgeProfile = {
    id: "edge-profile",
    os: "macos",
    engine: "patched-chromium",
    browserApp: "brave",
    proxy: { enabled: false },
    fingerprint: { browser: "edge", spoofingLevel: "stealth", doNotTrack: true, blockCookies: true }
  };
  const beforeEdge = spawned.length;
  const edgeLaunch = await manager.launchProfile(edgeProfile, "about:blank");
  assert.equal(edgeLaunch.ok, true, JSON.stringify(edgeLaunch));
  const edgeArgs = spawned[beforeEdge].args;
  assert.equal(edgeArgs.includes("--fingerprint-brand=Edge"), true);
  assert.equal(edgeArgs.includes("--fingerprint-platform=macos"), true);
  assert.equal(edgeArgs.includes("--disable-spoofing=font,canvas,audio,clientrects"), true);
  assert.equal(edgeArgs.includes("--disable-spoofing=gpu"), false);
  assert.equal(edgeArgs.some((arg) => arg.startsWith("--user-agent=")), false);
  const edgeSpec = manager.cloudLaunchSpec(edgeProfile, {
    language: "en-US",
    timezone: "America/Los_Angeles",
    hardwareConcurrency: 8,
    _platformVersion: "15.2.0",
    _stealth: true
  });
  assert.equal(edgeSpec.args.includes("--fingerprint-brand=Edge"), true);
  assert.equal(edgeSpec.args.includes("--fingerprint-platform=macos"), true);
  assert.equal(edgeSpec.args.includes("--fingerprint-platform-version=15.2.0"), true);
  assert.equal(edgeSpec.args.some((arg) => arg.startsWith("--disable-spoofing=")), false);
  await manager.closeProfile(edgeProfile.id);

  const prefDir = path.join(tmp, "pref-check");
  manager.writePrivacyPreferences({ fingerprint: { doNotTrack: true, blockCookies: true } }, prefDir);
  const blocked = JSON.parse(fs.readFileSync(path.join(prefDir, "Default", "Preferences"), "utf8"));
  assert.equal(blocked.enable_do_not_track, true);
  assert.equal(blocked.profile.block_third_party_cookies, true);
  assert.equal(blocked.profile.default_content_setting_values.cookies, 2);
  assert.equal(blocked.profile.default_content_setting_values.geolocation, 2);
  manager.writePrivacyPreferences({ fingerprint: { doNotTrack: false, blockCookies: false } }, prefDir);
  const allowed = JSON.parse(fs.readFileSync(path.join(prefDir, "Default", "Preferences"), "utf8"));
  assert.equal(allowed.enable_do_not_track, false);
  assert.equal(allowed.profile.default_content_setting_values.cookies, 1);
  assert.equal(allowed.profile.block_third_party_cookies, false);
  console.log("PASS patched windowless launch retries on software GL and keeps the spoofed graphics name");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  Module._load = original;
  fs.rmSync(tmp, { recursive: true, force: true });
});
