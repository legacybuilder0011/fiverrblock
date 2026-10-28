"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { wants, overlayBounds } = require("../src/mac-browser-chrome");

assert.strictEqual(wants("macos"), true);
assert.strictEqual(wants("iOS"), true);
assert.strictEqual(wants("linux"), false);
assert.strictEqual(wants("windows"), false);
assert.strictEqual(wants("android"), false);

const fitted = overlayBounds({ x: 12.4, y: 40.2, width: 1100.2, height: 700 }, 91);
assert.strictEqual(fitted.toolbar, 91);
assert.strictEqual(fitted.x, 12 - 22);
assert.strictEqual(fitted.y, 40 - 22);
assert.strictEqual(fitted.width, 1100 + 44);
assert.strictEqual(fitted.height, 700 + 44);
const fallback = overlayBounds({ x: 0, y: 0, width: 800, height: 600 }, 20);
assert.strictEqual(fallback.toolbar, 88);
assert.ok(fallback.height > fallback.toolbar);

const root = path.join(__dirname, "..");
const manager = fs.readFileSync(path.join(root, "src", "real-browser-manager.js"), "utf8");
assert.ok(manager.includes('require("./mac-browser-chrome")'));
assert.ok(!manager.includes("os-window-frame"));
const html = fs.readFileSync(path.join(root, "renderer", "mac-chrome.html"), "utf8");
assert.ok(html.includes("Enter search or web adress"));
assert.ok(html.includes('data-action="close"'));
assert.ok(html.includes('class="light close"'));
assert.ok(html.includes('id="well"'));
assert.ok(html.includes('id="top"'));
assert.ok(!html.includes("Bookmarks"));
assert.ok(!html.includes("Apple"));
const hint = fs.readFileSync(path.join(root, "renderer", "profiles.js"), "utf8");
assert.ok(hint.includes("Mac browser window"));
assert.ok(!hint.includes("Apple menu bar"));

console.log("PASS Mac browser chrome is the full tab and address bar, not the menu bar");
