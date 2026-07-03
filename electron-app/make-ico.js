"use strict";
// Build a multi-resolution .ico by embedding existing PNGs as PNG-compressed
// ICO entries (Vista+ supports PNG payloads). Avoids electron-builder's WASM
// icon converter, which fails with "could not allocate memory" on low-RAM boxes.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "icons");
// size => filename. width/height byte is 0 for 256.
const sources = [
  { size: 16, file: "icon16.png" },
  { size: 48, file: "icon48.png" },
  { size: 128, file: "icon128.png" },
  { size: 256, file: "icon256.png" }
].filter((s) => fs.existsSync(path.join(dir, s.file)));

const images = sources.map((s) => ({ size: s.size, data: fs.readFileSync(path.join(dir, s.file)) }));

const count = images.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = icon
header.writeUInt16LE(count, 4);  // image count

const entrySize = 16;
let offset = 6 + entrySize * count;
const entries = [];
for (const img of images) {
  const e = Buffer.alloc(entrySize);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  e.writeUInt8(0, 2);                              // color palette
  e.writeUInt8(0, 3);                              // reserved
  e.writeUInt16LE(1, 4);                           // color planes
  e.writeUInt16LE(32, 6);                          // bits per pixel
  e.writeUInt32LE(img.data.length, 8);             // size of image data
  e.writeUInt32LE(offset, 12);                     // offset of image data
  entries.push(e);
  offset += img.data.length;
}

const out = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
const outPath = path.join(dir, "icon.ico");
fs.writeFileSync(outPath, out);
console.log("wrote", outPath, out.length, "bytes,", count, "sizes:", images.map((i) => i.size).join(","));
