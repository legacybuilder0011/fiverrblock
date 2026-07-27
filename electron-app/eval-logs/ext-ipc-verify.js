// Verifies the per-profile extension IPC handlers end-to-end inside a real
// Electron main process: install a Web Store extension into a scratch profile,
// confirm it lands in profile.extensions, that the list handler reports it, and
// that removing it cleans up. Run:
//   node_modules/electron/dist/electron.exe eval-logs/ext-ipc-verify.js
const { app, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const scratch = path.join(os.tmpdir(), "ps-ext-verify-" + process.pid);
fs.mkdirSync(scratch, { recursive: true });
app.setPath("userData", scratch);

const out = (...a) => process.stdout.write(a.join(" ") + "\n");

app.whenReady().then(async () => {
  const store = require("../src/profile-store");
  const { registerIpcHandlers } = require("../src/ipc-handlers");
  registerIpcHandlers();

  const handlers = ipcMain._invokeHandlers;
  const call = (name, args) => {
    const fn = handlers.get(name);
    if (!fn) throw new Error("handler not registered: " + name);
    return fn({ sender: { id: 0 } }, args);
  };
  for (const name of ["PROFILE_EXT_LIST", "PROFILE_EXT_INSTALL_WEBSTORE", "PROFILE_EXT_ADD_FOLDER", "PROFILE_EXT_REMOVE"]) {
    out("REGISTERED", name, handlers.has(name) ? "yes" : "NO");
  }

  const profile = store.createProfile({ name: "Ext Verify", engine: "patched-chromium" });
  out("profile", profile.id);

  out("empty list:", JSON.stringify(await call("PROFILE_EXT_LIST", { profileId: profile.id })));

  const install = await call("PROFILE_EXT_INSTALL_WEBSTORE", {
    profileId: profile.id,
    ref: "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn?pli=1"
  });
  out("install:", JSON.stringify(install));
  out("dir exists:", fs.existsSync(path.join(install.path || "", "manifest.json")));
  const manifest = JSON.parse(fs.readFileSync(path.join(install.path, "manifest.json"), "utf8"));
  out("manifest key preserved:", Boolean(manifest.key), "| update_url stripped:", !manifest.update_url, "| _metadata gone:", !fs.existsSync(path.join(install.path, "_metadata")));

  const saved = store.getProfiles().find((p) => p.id === profile.id);
  out("profile.extensions:", JSON.stringify(saved.extensions));
  out("list after install:", JSON.stringify(await call("PROFILE_EXT_LIST", { profileId: profile.id })));

  // Re-install the same extension: must replace, not duplicate.
  await call("PROFILE_EXT_INSTALL_WEBSTORE", { profileId: profile.id, ref: "fcoeoabgfenejglbffodgkkbkcdhcgfn" });
  const after = store.getProfiles().find((p) => p.id === profile.id);
  out("no duplicate on reinstall:", after.extensions.length === 1, "count=" + after.extensions.length);

  out("bad ref:", JSON.stringify(await call("PROFILE_EXT_INSTALL_WEBSTORE", { profileId: profile.id, ref: "nonsense" })));

  const rm = await call("PROFILE_EXT_REMOVE", { profileId: profile.id, path: install.path });
  const cleaned = store.getProfiles().find((p) => p.id === profile.id);
  out("remove:", JSON.stringify(rm), "| left:", cleaned.extensions.length, "| files deleted:", !fs.existsSync(install.path));

  app.exit(0);
}).catch((err) => { out("FATAL", err && err.stack || err); app.exit(1); });
