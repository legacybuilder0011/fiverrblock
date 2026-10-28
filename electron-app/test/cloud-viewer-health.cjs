"use strict";

const assert = require("assert/strict");
const { freshCloudView, noteCloudViewShown, nextCloudView } = require("../src/cloud-viewer-health");

const t0 = 1_000_000;
let state = freshCloudView(t0);

// A page that is still loading is not a failure.
({ state } = nextCloudView(state, { hasVideo: false }, t0 + 2000));
assert.equal(nextCloudView(state, { hasVideo: false }, t0 + 2000).action, "wait");

// No video after the grace period and the stuck wait means the window is blank.
state = nextCloudView(state, { hasVideo: false }, t0 + 13000).state;
const blank = nextCloudView(state, { hasVideo: false }, t0 + 22000);
assert.equal(blank.action, "reconnect");
assert.equal(blank.reason, "blank");

// A moving picture is healthy, including after the first sample.
state = freshCloudView(t0);
state = nextCloudView(state, { hasVideo: true, currentTime: 0.2, frames: 4, width: 1280 }, t0 + 2000).state;
const healthy = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 4000);
assert.equal(healthy.action, "healthy");
assert.equal(healthy.state.sawPicture, true);

// A frozen clock after a real picture is a stalled stream, not a still page.
state = healthy.state;
state.navAt = t0;
state = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 30000).state;
const stalled = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 39000);
assert.equal(stalled.action, "reconnect");
assert.equal(stalled.reason, "stalled");

// Frames can start before the video has a size. That is still connecting.
state = freshCloudView(t0);
state = nextCloudView(state, { hasVideo: true, currentTime: 0.2, frames: 2, width: 0 }, t0 + 1000).state;
assert.equal(nextCloudView(state, { hasVideo: true, currentTime: 1.2, frames: 20, width: 0 }, t0 + 3000).action, "wait");

// Coming back from minimize freezes the clock. That wait is not a reconnect.
state = healthy.state;
state = noteCloudViewShown(state, t0 + 100000);
const held = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 101000);
assert.equal(held.action, "wait");
const back = nextCloudView(held.state, { hasVideo: true, currentTime: 3.2, frames: 70, width: 1280 }, t0 + 103000);
assert.equal(back.action, "healthy");

// A picture that never moves after the resume window is still a stall.
state = noteCloudViewShown(healthy.state, t0 + 200000);
state = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 202000).state;
state = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 206000).state;
const afterResume = nextCloudView(state, { hasVideo: true, currentTime: 2.2, frames: 40, width: 1280 }, t0 + 215000);
assert.equal(afterResume.action, "reconnect");
assert.equal(afterResume.reason, "stalled");

console.log("PASS cloud viewer treats a moving picture as healthy and a white window as reconnect");
