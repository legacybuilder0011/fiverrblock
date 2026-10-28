"use strict";

// The browser's screen.width is the X desktop, not a Chrome flag. Neko 3 applies
// this size with xrandr, so each profile keeps the size it was given. Even
// pixels only: the video encoder rejects an odd width or height.
function cloudDesktopScreen(width, height) {
  let w = Math.round(Number(width) || 1920);
  let h = Math.round(Number(height) || 1080);
  if (!Number.isFinite(w)) w = 1920;
  if (!Number.isFinite(h)) h = 1080;
  w = Math.max(800, Math.min(3840, w));
  h = Math.max(600, Math.min(2160, h));
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  return { width: w, height: h, screen: w + "x" + h };
}

module.exports = { cloudDesktopScreen };
