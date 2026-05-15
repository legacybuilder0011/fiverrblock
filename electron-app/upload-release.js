const fs = require("fs");
const https = require("https");
const path = require("path");

// Set your GitHub personal access token here (repo scope required).
// Never commit the real token — keep it local or use an env var:
//   TOKEN = process.env.GITHUB_TOKEN || "ghp_your_token_here"
const TOKEN = process.env.GITHUB_TOKEN || "ghp_your_token_here";
const RELEASE_ID = "323536815";
const REPO = "legacybuilder0011/fiverrblock";

const FILES = [
  { src: "dist/Privacy Shield Browser Setup 1.9.5.exe", name: "PrivacyShield-Setup-1.9.5.exe" },
  { src: "dist/Privacy Shield Browser 1.9.5.exe",       name: "PrivacyShield-Portable-1.9.5.exe" }
];

// Bypass TLS inspection on response — we only need to verify upload succeeded via poll
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function apiGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.github.com",
      path, method: "GET",
      agent,
      headers: { "Authorization": `Bearer ${TOKEN}`, "User-Agent": "node-upload" }
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function apiDelete(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.github.com",
      path, method: "DELETE",
      agent,
      headers: { "Authorization": `Bearer ${TOKEN}`, "User-Agent": "node-upload" }
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.end();
  });
}

function upload(filePath, assetName) {
  return new Promise((resolve) => {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    console.log(`\nUploading ${assetName} (${(size / 1024 / 1024).toFixed(1)} MB)...`);

    const req = https.request({
      hostname: "uploads.github.com",
      path: `/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(assetName)}`,
      method: "POST",
      agent,
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": size,
        "User-Agent": "node-upload"
      }
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve({ ok: json.state === "uploaded", state: json.state, id: json.id });
        } catch (_) {
          resolve({ ok: false, state: "parse-error" });
        }
      });
    });

    req.on("error", (err) => {
      console.log(`\n  Connection error on response: ${err.code || err.message} (checking if upload landed...)`);
      resolve({ ok: false, state: "conn-error" });
    });

    let uploaded = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => {
      uploaded += chunk.length;
      process.stdout.write(`\r  ${((uploaded / size) * 100).toFixed(1)}%`);
    });
    stream.on("end", () => process.stdout.write("\r  100.0% — waiting for GitHub...\n"));
    stream.pipe(req);
  });
}

async function pollUntilUploaded(name, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 3000));
    const assets = await apiGet(`/repos/${REPO}/releases/${RELEASE_ID}/assets`);
    if (!Array.isArray(assets)) continue;
    const asset = assets.find(a => a.name === name);
    if (asset) {
      if (asset.state === "uploaded") return asset;
      if (asset.state === "starter") {
        process.stdout.write(`\r  Waiting... (state: ${asset.state})`);
      }
    }
  }
  return null;
}

async function deleteExisting(name) {
  const assets = await apiGet(`/repos/${REPO}/releases/${RELEASE_ID}/assets`);
  if (!Array.isArray(assets)) return;
  for (const a of assets.filter(a => a.name === name)) {
    await apiDelete(`/repos/${REPO}/releases/assets/${a.id}`);
    console.log(`  Removed stale asset: ${a.name} (${a.state})`);
  }
}

(async () => {
  for (const f of FILES) {
    const full = path.join(__dirname, f.src);
    if (!fs.existsSync(full)) { console.log(`SKIP (not found): ${f.src}`); continue; }

    await deleteExisting(f.name);
    const result = await upload(full, f.name);

    if (result.ok) {
      console.log(`  SUCCESS: ${f.name}`);
    } else {
      console.log(`  Polling for result...`);
      const asset = await pollUntilUploaded(f.name);
      if (asset) {
        console.log(`  SUCCESS (confirmed via poll): ${asset.browser_download_url}`);
      } else {
        console.log(`  FAILED: asset not uploaded. Try again or upload manually.`);
      }
    }
  }
})();
