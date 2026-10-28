"use strict";

// The cloud window only shows a video of the browser running on the server.
// A still page is healthy while that video clock keeps moving. A white window
// is a video that never gets a size, or no video at all. Reloading the current
// page does not fix it: the viewer has to be opened again.

const LOAD_GRACE_MS = 12000;
const STUCK_MS = 8000;
// Minimizing the window freezes the video clock. That is not a dead screen.
const RESUME_GRACE_MS = 5000;

function freshCloudView(now) {
  return { navAt: now, lastTime: -1, lastFrames: -1, stuckSince: 0, sawPicture: false, resumeUntil: 0 };
}

function noteCloudViewShown(state, now) {
  return { ...state, lastTime: -1, lastFrames: -1, stuckSince: 0, resumeUntil: now + RESUME_GRACE_MS };
}

function nextCloudView(state, snap, now) {
  const shot = snap && snap.hasVideo ? snap : { hasVideo: false, currentTime: 0, frames: -1, width: 0 };
  const hasClock = shot.hasVideo && typeof shot.currentTime === "number";
  const timeMoved = hasClock && state.lastTime >= 0 && shot.currentTime > state.lastTime + 0.05;
  const framesMoved = shot.hasVideo && shot.frames >= 0 && state.lastFrames >= 0 && shot.frames > state.lastFrames;
  const next = {
    ...state,
    lastTime: hasClock ? shot.currentTime : state.lastTime,
    lastFrames: shot.hasVideo && shot.frames >= 0 ? shot.frames : state.lastFrames
  };
  if ((timeMoved || framesMoved) && shot.width > 0) {
    return { action: "healthy", state: { ...next, stuckSince: 0, sawPicture: true, resumeUntil: 0 } };
  }
  if (state.resumeUntil && now < state.resumeUntil) {
    return { action: "wait", state: { ...next, stuckSince: 0 } };
  }
  if ((timeMoved || framesMoved) && now - state.navAt < LOAD_GRACE_MS) {
    return { action: "wait", state: { ...next, stuckSince: 0 } };
  }
  if (now - state.navAt < LOAD_GRACE_MS) return { action: "wait", state: next };
  const stuckSince = state.stuckSince || now;
  if (now - stuckSince < STUCK_MS) return { action: "wait", state: { ...next, stuckSince } };
  return {
    action: "reconnect",
    reason: shot.hasVideo && shot.width > 0 ? "stalled" : "blank",
    state: { ...next, stuckSince: 0 }
  };
}

module.exports = { freshCloudView, noteCloudViewShown, nextCloudView, LOAD_GRACE_MS, STUCK_MS, RESUME_GRACE_MS };
