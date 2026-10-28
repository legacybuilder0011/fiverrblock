"use strict";
const assert = require("assert/strict");
const { frameKind, layoutFor } = require("../src/os-window-frame");

assert.equal(frameKind("macos"), "mac");
assert.equal(frameKind("iOS"), "mac");
assert.equal(frameKind("linux"), "linux");
assert.equal(frameKind("windows"), "");
assert.equal(frameKind("android"), "");

const work = { x: 0, y: 0, width: 1920, height: 1040 };
const above = layoutFor({ x: 80, y: 120, width: 1280, height: 800 }, work);
assert.ok(above.bar);
assert.equal(above.bar.y, 88);
assert.equal(above.bar.x, 80);
assert.equal(above.bar.width, 1280);
assert.equal(above.lights, null);
assert.equal(above.cover.x, 80 + 1280 - 168);
assert.equal(above.cover.y, 120);

const flush = layoutFor({ x: 0, y: 0, width: 1000, height: 700 }, work);
assert.equal(flush.bar, null);
assert.equal(flush.lights.x, 8);
assert.equal(flush.lights.y, 6);
assert.equal(flush.cover.x, 1000 - 168);

console.log("PASS OS window picture picks Mac or Linux and sits on the browser window");
