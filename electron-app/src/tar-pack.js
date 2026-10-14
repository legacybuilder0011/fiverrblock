"use strict";
// Minimal ustar writer: pack a folder into a tar Buffer in pure Node, so sending a
// folder to the cloud never depends on an external tar.exe (Windows' bsdtar
// refused some folders). Regular files + directories only; symlinks skipped.
const fs = require("fs");
const path = require("path");

function header(name, size, type, mtime) {
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // ustar: split long paths at a "/" into prefix (≤155) + name (≤100).
    const i = name.lastIndexOf("/", name.length - 2);
    if (i < 0 || Buffer.byteLength(name.slice(i + 1)) > 100 || Buffer.byteLength(name.slice(0, i)) > 155) {
      throw new Error(`path too long to pack: ${name}`);
    }
    prefix = name.slice(0, i); name = name.slice(i + 1);
  }
  const h = Buffer.alloc(512, 0);
  const put = (str, off, len) => h.write(str, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(type === "5" ? 0o755 : 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);          // uid, gid
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  h.fill(0x20, 148, 156);                                    // checksum placeholder = spaces
  put(type, 156, 1);
  put("ustar\0", 257, 6); put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

// Pack `dir` so the archive's top entry is its folder name. Stops past maxBytes.
function packFolder(dir, maxBytes) {
  const parts = []; let total = 0;
  const add = (buf) => { total += buf.length; if (total > maxBytes) throw new Error("folder is larger than 200 MB"); parts.push(buf); };
  const walk = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      add(header(rel + "/", 0, "5", st.mtimeMs));
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), `${rel}/${name}`);
    } else if (st.isFile()) {
      const data = fs.readFileSync(abs);
      add(header(rel, data.length, "0", st.mtimeMs));
      add(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) add(Buffer.alloc(pad, 0));
    }
  };
  walk(dir, path.basename(dir));
  add(Buffer.alloc(1024, 0)); // end-of-archive marker
  return Buffer.concat(parts);
}

module.exports = { packFolder };
