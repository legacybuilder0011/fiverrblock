"use strict";
// Fixes fingerprint-chromium issue #96 in the Windows engine: with --fingerprint,
// canvas measureText() multiplies every width by the noise term alone
// ((h / 4294967295 - 0.5) * 1e-5), so text measures ~0 — an obvious tell that
// also breaks pages that lay out text on a canvas. The compiled code is
//   divsd xmm,[4294967295.0]; addsd xmm,[-0.5]; mulsd xmm,[1e-5]
// and the upstream-suggested fix rewrites the last two as
//   mulsd xmm,[1e-5]; addsd xmm,[1.0]
// giving 1 + h / 4294967295 * 1e-5: real width plus a tiny per-profile noise.
// The site is found by its constants, not a fixed offset, and the file is only
// written when exactly one site matches.

const fs = require("fs");

const DIVSD = 0x5e, ADDSD = 0x58, MULSD = 0x59;

function sections(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("not a PE file");
  const count = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const list = [];
  for (let i = 0, at = pe + 24 + optSize; i < count; i++, at += 40) {
    list.push({ va: buf.readUInt32LE(at + 12), rawSize: buf.readUInt32LE(at + 16), raw: buf.readUInt32LE(at + 20) });
  }
  return list;
}
function toRva(secs, off) {
  const s = secs.find((x) => off >= x.raw && off < x.raw + x.rawSize);
  return s ? off - s.raw + s.va : -1;
}
function toOff(secs, rva) {
  const s = secs.find((x) => rva >= x.va && rva < x.va + x.rawSize);
  return s ? rva - s.va + s.raw : -1;
}

// SSE2 scalar op with a RIP-relative operand: F2 0F <op> <modrm mod=00 rm=101> disp32.
function ripOp(buf, i, op) {
  return buf[i] === 0xf2 && buf[i + 1] === 0x0f && buf[i + 2] === op && (buf[i + 3] & 0xc7) === 0x05;
}
function constAt(buf, secs, i) {
  const target = toRva(secs, i) + 8 + buf.readInt32LE(i + 4);
  const off = toOff(secs, target);
  return off < 0 ? NaN : buf.readDoubleLE(off);
}

// Returns { broken: [offsets], fixed: [offsets] }.
function scan(buf) {
  const secs = sections(buf);
  const broken = [], fixed = [];
  for (let i = 0; i < buf.length - 24; i++) {
    if (buf[i] !== 0xf2 || !ripOp(buf, i, DIVSD)) continue;
    const reg = buf[i + 3] & 0x38;
    if ((buf[i + 11] & 0x38) !== reg || (buf[i + 19] & 0x38) !== reg) continue;
    if (constAt(buf, secs, i) !== 4294967295) continue;
    const a = constAt(buf, secs, i + 8), b = constAt(buf, secs, i + 16);
    if (ripOp(buf, i + 8, ADDSD) && ripOp(buf, i + 16, MULSD) && a === -0.5 && b === 1e-5) broken.push(i);
    else if (ripOp(buf, i + 8, MULSD) && ripOp(buf, i + 16, ADDSD) && a === 1e-5 && b === 1) fixed.push(i);
  }
  return { broken, fixed, secs };
}

// An aligned 1.0 in the same section as the -0.5 constant, reachable from the site.
function findOne(buf, secs, nearOff) {
  const s = secs.find((x) => nearOff >= x.raw && nearOff < x.raw + x.rawSize);
  for (let off = s.raw; off + 8 <= s.raw + s.rawSize; off += 8) {
    if (buf.readUInt32LE(off) === 0 && buf.readUInt32LE(off + 4) === 0x3ff00000) return off;
  }
  return -1;
}

function patchBuffer(buf) {
  const { broken, fixed, secs } = scan(buf);
  if (fixed.length && !broken.length) return { status: "already-fixed" };
  if (broken.length !== 1) return { status: "not-found", matches: broken.length };
  const i = broken[0];
  const mulDisp = buf.readInt32LE(i + 20); // operand of the original mulsd at i+16
  const mulTarget = toRva(secs, i + 16) + 8 + mulDisp;
  const negHalfOff = toOff(secs, toRva(secs, i + 8) + 8 + buf.readInt32LE(i + 12));
  const oneOff = findOne(buf, secs, negHalfOff);
  if (oneOff < 0) return { status: "no-one-constant" };
  const oneRva = toRva(secs, oneOff);
  const reg = buf[i + 3] & 0x38;
  // i+8: mulsd xmm,[1e-5]   i+16: addsd xmm,[1.0]
  buf[i + 10] = MULSD; buf[i + 11] = 0x05 | reg;
  buf.writeInt32LE(mulTarget - (toRva(secs, i + 8) + 8), i + 12);
  buf[i + 18] = ADDSD; buf[i + 19] = 0x05 | reg;
  buf.writeInt32LE(oneRva - (toRva(secs, i + 16) + 8), i + 20);
  const check = scan(buf);
  if (check.broken.length || check.fixed.length !== 1) throw new Error("patch did not verify");
  return { status: "patched", offset: i };
}

// Patches dllPath in place through a temp file + rename. Never throws.
function patchFile(dllPath) {
  try {
    const buf = fs.readFileSync(dllPath);
    const res = patchBuffer(buf);
    if (res.status === "patched") {
      const tmp = dllPath + ".patching";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dllPath);
    }
    return res;
  } catch (err) {
    return { status: "error", error: String(err.message || err) };
  }
}

// ── macOS (arm64 "Chromium Framework") ──────────────────────────────────────
// Same bug, compiled as
//   fdiv d0,d0,dX; fmov dA,#-0.5; fadd dD,dD,dA; movz/movk xR = 1e-5 (4 words);
//   fmov dA,xR; fmul dD,dD,dA
// and rewritten in the same 8 slots, same registers, to
//   movz/movk xR = 1e-5; fmov dA,xR; fmul dD,dD,dA; fmov dA,#1.0; fadd dD,dD,dA
// i.e. width * (1 + h / 4294967295 * 1e-5), as on Windows.
const A64_1E5 = [0x68f1, 0x88e3, 0xf8b5, 0x3ee4];
const FMOV_NEG_HALF = 0x1e7c1000, FMOV_ONE = 0x1e6e1000;
function a64Fp(op, d, n, m) { return op | (m << 16) | (n << 5) | d; }

// Index (in 32-bit words) of the 8-word block, for the broken or the fixed form.
function a64Match(w, i) {
  const isFdiv = (x) => (x & 0xffe0fc00) === 0x1e601800;
  const movOk = (j, R) => {
    for (let k = 0; k < 4; k++) {
      const x = w[j + k] >>> 0, base = k === 0 ? 0xd2800000 : 0xf2800000;
      if (x !== ((base | (k << 21) | (A64_1E5[k] << 5) | R) >>> 0)) return false;
    }
    return true;
  };
  const fmovFromX = (x, A, R) => x === ((0x9e670000 | (R << 5) | A) >>> 0);
  // broken: [fmov dA,#-0.5][fadd dD,dD,dA][mov x4][fmov dA,xR][fmul dD,dD,dA]
  let x = w[i] >>> 0;
  if ((x & 0xffffffe0) === FMOV_NEG_HALF) {
    const A = x & 31, add = w[i + 1] >>> 0, D = add & 31, R = w[i + 2] & 31;
    if (add === (a64Fp(0x1e602800, D, D, A) >>> 0) && movOk(i + 2, R) && fmovFromX(w[i + 6] >>> 0, A, R) &&
        (w[i + 7] >>> 0) === (a64Fp(0x1e600800, D, D, A) >>> 0) && [1, 2, 3].some((b) => isFdiv(w[i - b] >>> 0))) {
      return { form: "broken", A, D, R };
    }
  }
  // fixed: [mov x4][fmov dA,xR][fmul dD,dD,dA][fmov dA,#1.0][fadd dD,dD,dA]
  const R = w[i] & 31;
  if (movOk(i, R)) {
    const f = w[i + 4] >>> 0, A = f & 31, mul = w[i + 5] >>> 0, D = mul & 31;
    if (fmovFromX(f, A, R) && mul === (a64Fp(0x1e600800, D, D, A) >>> 0) &&
        (w[i + 6] >>> 0) === ((FMOV_ONE | A) >>> 0) && (w[i + 7] >>> 0) === (a64Fp(0x1e602800, D, D, A) >>> 0) &&
        [1, 2, 3].some((b) => isFdiv(w[i - b] >>> 0))) {
      return { form: "fixed", A, D, R };
    }
  }
  return null;
}

function scanMac(buf) {
  const w = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const broken = [], fixed = [];
  for (let i = 3; i < w.length - 8; i++) {
    const x = w[i];
    // Cheap pre-filter: the block starts with fmov #-0.5 (broken) or movz #0x68f1 (fixed).
    const head = (x & 0xffffffe0) >>> 0;
    if (head !== FMOV_NEG_HALF && head !== ((0xd2800000 | (0x68f1 << 5)) >>> 0)) continue;
    const m = a64Match(w, i);
    if (m) (m.form === "broken" ? broken : fixed).push({ i, ...m });
  }
  return { broken, fixed, w };
}

function patchMacBuffer(buf) {
  const { broken, fixed, w } = scanMac(buf);
  if (fixed.length && !broken.length) return { status: "already-fixed" };
  if (broken.length !== 1) return { status: "not-found", matches: broken.length };
  const { i, A, D } = broken[0];
  const block = Array.from(w.subarray(i + 2, i + 8));            // mov x4, fmov dA,xR, fmul
  block.push((FMOV_ONE | A) >>> 0, a64Fp(0x1e602800, D, D, A) >>> 0);
  for (let k = 0; k < 8; k++) w[i + k] = block[k];
  const check = scanMac(buf);
  if (check.broken.length || check.fixed.length !== 1) throw new Error("patch did not verify");
  return { status: "patched", offset: i * 4 };
}

// Patches the framework binary, then re-signs the framework ad-hoc (it ships
// ad-hoc signed, no hardened runtime, no entitlements) because macOS will not run
// modified code with the old signature. Puts the original back if signing fails.
function patchMacFramework(binPath, frameworkDir) {
  const { execFileSync } = require("child_process");
  const backup = binPath + ".orig";
  try {
    const buf = fs.readFileSync(binPath);
    const res = patchMacBuffer(buf);
    if (res.status !== "patched") return res;
    fs.copyFileSync(binPath, backup);
    const tmp = binPath + ".patching";
    fs.writeFileSync(tmp, buf);
    fs.chmodSync(tmp, fs.statSync(binPath).mode);
    fs.renameSync(tmp, binPath);
    try {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", frameworkDir], { timeout: 120000, stdio: "ignore" });
      execFileSync("/usr/bin/codesign", ["--verify", frameworkDir], { timeout: 120000, stdio: "ignore" });
    } catch (err) {
      fs.renameSync(backup, binPath);
      return { status: "error", error: "codesign failed, original restored: " + (err.message || err) };
    }
    fs.rmSync(backup, { force: true });
    return res;
  } catch (err) {
    try { if (fs.existsSync(backup)) fs.renameSync(backup, binPath); } catch (_) {}
    return { status: "error", error: String(err.message || err) };
  }
}

module.exports = { scan, patchBuffer, patchFile, scanMac, patchMacBuffer, patchMacFramework };
