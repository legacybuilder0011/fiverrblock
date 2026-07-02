"use strict";

const { app } = require("electron");
const extractZip = require("extract-zip");
const fs = require("fs");
const path = require("path");

const MAX_SEARCH_DEPTH = 4;
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "__MACOSX"]);

function safeSegment(value, fallback = "extension") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function readManifest(directory) {
  const manifestPath = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Extension manifest is not valid JSON: ${err.message || err}`);
  }
  if (!manifest || ![2, 3].includes(Number(manifest.manifest_version))) {
    throw new Error("Extension manifest_version must be 2 or 3");
  }
  if (!manifest.name || !manifest.version) {
    throw new Error("Extension manifest must contain name and version");
  }
  return { manifest, manifestPath, directory };
}

function collectManifestDirectories(root, depth = 0, found = []) {
  if (depth > MAX_SEARCH_DEPTH || found.length > 20) return found;
  const exact = readManifest(root);
  if (exact) {
    found.push(exact);
    return found;
  }

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
    collectManifestDirectories(path.join(root, entry.name), depth + 1, found);
  }
  return found;
}

function resolveExtensionDirectory(selectedPath) {
  const absolute = path.resolve(String(selectedPath || ""));
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (_) {
    throw new Error("The selected extension path does not exist");
  }
  if (!stat.isDirectory()) throw new Error("Select an unpacked extension folder");

  const matches = collectManifestDirectories(absolute);
  if (!matches.length) {
    throw new Error("No manifest.json was found. Select the extension folder itself, or a parent containing one extension.");
  }
  if (matches.length > 1) {
    throw new Error("More than one extension was found. Select the exact folder containing the required manifest.json.");
  }
  return matches[0];
}

function getProfileExtensionRoot(profileId) {
  const root = path.join(
    app.getPath("userData"),
    "profile-extensions",
    safeSegment(profileId, "profile")
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function removeWithinRoot(target, root) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root) + path.sep;
  if (!resolvedTarget.startsWith(resolvedRoot)) return;
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

async function installZip(zipPath, profileId) {
  const absoluteZip = path.resolve(String(zipPath || ""));
  if (path.extname(absoluteZip).toLowerCase() !== ".zip") {
    throw new Error("Only unpacked folders and ZIP extension packages are supported. CRX/Web Store installation is not supported by Electron.");
  }
  if (!fs.existsSync(absoluteZip)) throw new Error("The selected ZIP file does not exist");

  const root = getProfileExtensionRoot(profileId);
  const archiveName = safeSegment(path.basename(absoluteZip, path.extname(absoluteZip)));
  const extractionRoot = path.join(root, `${archiveName}-${Date.now().toString(36)}`);
  fs.mkdirSync(extractionRoot, { recursive: true });

  try {
    await extractZip(absoluteZip, { dir: extractionRoot });
    const resolved = resolveExtensionDirectory(extractionRoot);
    return { ...resolved, managedRoot: extractionRoot, sourceArchive: absoluteZip };
  } catch (err) {
    removeWithinRoot(extractionRoot, root);
    throw err;
  }
}

module.exports = {
  installZip,
  readManifest,
  resolveExtensionDirectory
};
