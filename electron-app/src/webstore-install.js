"use strict";

// Chrome Web Store installer for the native engines (patched-chromium / real-brave).
//
// WHY THIS EXISTS: patched-chromium is an ungoogled-chromium build, and ungoogled
// strips the Web Store install path entirely — chromewebstore.google.com shows
// "Switch to Chrome to install extensions and themes" with a dead "Add to Chrome"
// button. Real Brave blocks command-line-loaded profiles from the store too.
// So we fetch the CRX ourselves from Google's update endpoint, unpack it into the
// profile's own extension folder, and load it with --load-extension at launch
// (the same mechanism the per-profile fingerprint extension already uses).
//
// The unpacked copy keeps its ORIGINAL extension ID by re-injecting the CRX's
// public key into manifest.json as "key" — without that, Chromium derives the ID
// from the folder path, which breaks OAuth redirect URIs, extension-scoped
// storage, and anything that hardcodes the store ID.

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const extractZip = require("extract-zip");
const { execFile } = require("child_process");

// Google refuses/varies the CRX it serves by claimed browser version. The patched
// engine really is Chrome 148, so ask as that by default.
const DEFAULT_PRODVERSION = "148.0.0.0";
const CRX_ENDPOINT = "https://clients2.google.com/service/update2/crx";

// ── Store URL / ID parsing ────────────────────────────────────────────────────

// Accepts a bare 32-char ID or any store URL shape:
//   https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn?pli=1
//   https://chrome.google.com/webstore/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm
function parseExtensionRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "Paste a Chrome Web Store link or extension ID." };
  if (/^[a-p]{32}$/.test(raw)) return { ok: true, id: raw };
  const m = raw.match(/[a-p]{32}/);
  if (m) return { ok: true, id: m[0] };
  return { ok: false, error: "Could not find an extension ID in that link. Copy the full Web Store URL." };
}

// ── CRX parsing ───────────────────────────────────────────────────────────────

// Chromium's extension ID = first 16 bytes of SHA-256(DER public key), hex, with
// 0-9a-f remapped onto a-p ("mpdecimal").
function idFromPublicKey(der) {
  const hash = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  let out = "";
  for (const ch of hash) out += String.fromCharCode(97 + parseInt(ch, 16));
  return out;
}

// Minimal protobuf walker — we only need length-delimited fields, so anything
// else is skipped by wire type. Returns { fieldNumber: [Buffer, ...] }.
function protoFields(buf) {
  const out = {};
  let off = 0;
  const varint = () => {
    let result = 0, shift = 0;
    while (off < buf.length) {
      const b = buf[off++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  while (off < buf.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 2) {
      const len = varint();
      if (off + len > buf.length) break;
      (out[field] = out[field] || []).push(buf.slice(off, off + len));
      off += len;
    } else if (wire === 0) varint();
    else if (wire === 5) off += 4;
    else if (wire === 1) off += 8;
    else break;
  }
  return out;
}

// CRX3: "Cr24" | version(4) | headerLen(4) | CrxFileHeader | zip
// CRX2: "Cr24" | version(4) | pubKeyLen(4) | sigLen(4) | pubKey | sig | zip
// Returns { zip, publicKey } — publicKey is the DER SubjectPublicKeyInfo.
function parseCrx(buf) {
  if (buf.length < 16 || buf.slice(0, 4).toString("latin1") !== "Cr24") {
    throw new Error("Not a CRX file (bad magic) — the store may have returned an error page.");
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const pubStart = 16;
    return {
      publicKey: buf.slice(pubStart, pubStart + pubLen),
      zip: buf.slice(pubStart + pubLen + sigLen)
    };
  }
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}`);
  const headerLen = buf.readUInt32LE(8);
  const header = buf.slice(12, 12 + headerLen);
  const zip = buf.slice(12 + headerLen);

  const fields = protoFields(header);
  // field 10000 = signed_header_data, which holds crx_id (field 1, 16 bytes).
  let crxId = "";
  const signed = (fields[10000] || [])[0];
  if (signed) {
    const inner = protoFields(signed)[1];
    if (inner && inner[0] && inner[0].length === 16) {
      let out = "";
      for (const ch of inner[0].toString("hex")) out += String.fromCharCode(97 + parseInt(ch, 16));
      crxId = out;
    }
  }
  // field 2 = sha256_with_rsa proofs; sub-field 1 = public_key. Pick the proof
  // whose key actually hashes to the declared crx_id (a CRX can carry several).
  const proofs = [...(fields[2] || []), ...(fields[3] || [])];
  let publicKey = null;
  for (const proof of proofs) {
    const key = (protoFields(proof)[1] || [])[0];
    if (!key) continue;
    if (!publicKey) publicKey = key;
    if (crxId && idFromPublicKey(key) === crxId) { publicKey = key; break; }
  }
  if (!publicKey) throw new Error("CRX header carried no public key");
  return { publicKey, zip, crxId };
}

// ── Download ──────────────────────────────────────────────────────────────────

function httpsGetBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    const req = https.get(url, {
      headers: {
        // The endpoint is picky: a Chrome-shaped UA gets the real CRX.
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DEFAULT_PRODVERSION} Safari/537.36`,
        "Accept": "*/*"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpsGetBuffer(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Store returned HTTP ${res.statusCode} — the extension may be unlisted or removed.`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error("Download timed out")));
    req.on("error", reject);
  });
}

function crxUrl(id, prodversion) {
  const params = new URLSearchParams({
    response: "redirect",
    acceptformat: "crx2,crx3",
    prodversion: prodversion || DEFAULT_PRODVERSION,
    prod: "chromiumcrx",
    prodchannel: "unknown",
    os: "win",
    arch: "x64",
    os_arch: "x86_64",
    nacl_arch: "x86-64",
    x: `id=${id}&installsource=ondemand&uc`
  });
  return `${CRX_ENDPOINT}?${params.toString()}`;
}

// ── Unpack ────────────────────────────────────────────────────────────────────

// PowerShell Expand-Archive on Windows — the same mechanism the patched-chromium
// download already uses. NOT extract-zip: it resolves fine under plain Node but
// never settles inside Electron's main process (verified — the download and CRX
// parse complete, then the extract promise hangs forever), which would leave the
// install spinner stuck. extract-zip stays as the fallback for other platforms.
async function expandZip(zipPath, destDir) {
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      execFile("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ], { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || err).trim().split("\n")[0]));
        resolve();
      });
    }).catch((err) => { throw new Error("Could not unpack the extension: " + err.message); });
    return;
  }
  try {
    await extractZip(zipPath, { dir: destDir });
  } catch (err) {
    throw new Error("Could not unpack the extension: " + String((err && err.message) || err));
  }
}

// __MSG_name__ placeholders resolve out of _locales/<default_locale>/messages.json.
function resolveLocalizedName(dir, manifest) {
  const name = String(manifest.name || "");
  const m = name.match(/^__MSG_(.+)__$/);
  if (!m) return name;
  const locales = [manifest.default_locale, "en", "en_US"].filter(Boolean);
  for (const locale of locales) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, "_locales", locale, "messages.json"), "utf8"));
      const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key && msgs[key] && msgs[key].message) return String(msgs[key].message);
    } catch (_) {}
  }
  return m[1];
}

// Chromium refuses to load an unpacked extension containing files/folders whose
// name starts with "_" (reserved), and every store CRX ships a `_metadata` dir
// with the verified-contents hashes. It must go or the load fails outright.
function stripReservedEntries(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("_") && entry !== "_locales") {
      try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function patchManifest(dir, publicKey) {
  const manifestPath = path.join(dir, "manifest.json");
  let text = fs.readFileSync(manifestPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const manifest = JSON.parse(text);
  // Preserve the store extension ID.
  manifest.key = publicKey.toString("base64");
  // Unpacked extensions must not claim an update URL (Chromium warns and can try
  // to "update" our copy back into a store-managed one) or a differential
  // fingerprint (meaningless once unpacked).
  delete manifest.update_url;
  delete manifest.differential_fingerprint;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Install a Web Store extension into `destRoot/<id>`.
// Returns { ok, id, name, version, path, manifestVersion } or { ok:false, error }.
async function installFromWebstore(ref, destRoot, options = {}) {
  const parsed = parseExtensionRef(ref);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const id = parsed.id;

  let crx;
  try {
    crx = await httpsGetBuffer(crxUrl(id, options.prodversion));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }

  let parsedCrx;
  try { parsedCrx = parseCrx(crx); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }

  // Sanity: the key we're about to stamp in must reproduce the requested ID.
  const derivedId = idFromPublicKey(parsedCrx.publicKey);
  if (derivedId !== id) {
    return { ok: false, error: `Downloaded extension ID (${derivedId}) does not match the requested one (${id}).` };
  }

  const target = path.join(destRoot, id);
  const staging = path.join(os.tmpdir(), `ps-crx-${id}-${process.pid}`);
  const zipPath = path.join(os.tmpdir(), `ps-crx-${id}-${process.pid}.zip`);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(zipPath, parsedCrx.zip);

  try {
    await expandZip(zipPath, staging);
    if (!fs.existsSync(path.join(staging, "manifest.json"))) {
      throw new Error("Unpacked extension has no manifest.json");
    }
    stripReservedEntries(staging);
    const manifest = patchManifest(staging, parsedCrx.publicKey);
    const name = resolveLocalizedName(staging, manifest) || id;

    fs.mkdirSync(destRoot, { recursive: true });
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    try {
      fs.renameSync(staging, target);
    } catch (_) {
      // Cross-volume rename (tmp on another drive) — fall back to a copy.
      fs.cpSync(staging, target, { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }

    return {
      ok: true,
      id,
      name,
      version: String(manifest.version || ""),
      manifestVersion: Number(manifest.manifest_version || 0),
      path: target,
      source: "webstore"
    };
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
  }
}

module.exports = {
  installFromWebstore,
  parseExtensionRef,
  parseCrx,
  idFromPublicKey,
  crxUrl,
  DEFAULT_PRODVERSION
};
