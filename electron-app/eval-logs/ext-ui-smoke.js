// Renderer smoke test for the Extensions tab: loads the REAL profiles.html +
// profiles.js against a stubbed electronAPI, selects a fake profile, clicks the
// Extensions tab and exercises install/remove rendering. Catches wiring typos
// (missing ids, bad handlers) without needing a logged-in app.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ps-ui-smoke-")));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const preload = path.join(os.tmpdir(), "ps-smoke-preload-" + process.pid + ".js");
fs.writeFileSync(preload, `
const { contextBridge } = require("electron");
const PROFILE = { id: "p1", name: "Smoke", status: "active", engine: "patched-chromium", tags: [], notes: "",
  fingerprint: {}, proxy: {}, extensions: [] };
let installed = [];
contextBridge.exposeInMainWorld("electronAPI", {
  invoke: async (type, data) => {
    if (type === "PROFILE_LIST" || type === "PROFILES_LIST") return { ok: true, profiles: [PROFILE] };
    if (type === "PROFILE_EXT_LIST") return { ok: true, extensions: installed, engine: "patched-chromium" };
    if (type === "PROFILE_EXT_INSTALL_WEBSTORE") {
      installed = [{ id: "fcoeoabgfenejglbffodgkkbkcdhcgfn", name: "Claude", version: "1.0.81", path: "C:/x/fcoeo", source: "webstore", manifestVersion: 3, missing: false }];
      return { ok: true, id: "fcoeoabgfenejglbffodgkkbkcdhcgfn", name: "Claude", version: "1.0.81", manifestVersion: 3, path: "C:/x/fcoeo", restartNeeded: true };
    }
    if (type === "PROFILE_EXT_REMOVE") { installed = []; return { ok: true, restartNeeded: true }; }
    return { ok: true, profiles: [PROFILE], data: {}, extensions: [], ids: [], windows: {} };
  },
  onMainEvent: () => {}
});
`, "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true } });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 2) errors.push(message); });
  await win.loadFile(path.join(__dirname, "..", "renderer", "profiles.html"));
  await new Promise((r) => setTimeout(r, 1200));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const log = [];
    const step = async (name, fn) => { try { log.push(name + ": " + await fn()); } catch (e) { log.push(name + " THREW: " + e.message); } };
    await step("selectProfile", async () => { await selectProfile("p1"); return "selectedId=" + selectedId; });
    await step("tab click", async () => {
      document.querySelector('[data-tab="extensions"]').click();
      await new Promise(r => setTimeout(r, 200));
      return "panel active=" + document.getElementById("tab-extensions").classList.contains("active");
    });
    await step("empty list", async () => document.getElementById("extList").innerText.trim().slice(0, 60));
    await step("install", async () => {
      document.getElementById("extStoreInput").value = "https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn";
      document.getElementById("btnExtInstall").click();
      await new Promise(r => setTimeout(r, 500));
      return document.getElementById("extInstallStatus").innerText.trim();
    });
    await step("row", async () => document.getElementById("extList").innerText.split(String.fromCharCode(10)).join(" | ").trim().slice(0, 120));
    await step("remove", async () => {
      const rm = document.querySelector("[data-ext-remove]");
      if (!rm) return "NO REMOVE BUTTON";
      rm.click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById("extList").innerText.trim().slice(0, 60);
    });
    return log;
  })()`);
  result.forEach((l) => out("  " + l));
  out("console errors:", errors.length ? errors.slice(0, 5).join(" | ") : "none");
  app.exit(0);
}).catch((e) => { out("FATAL", (e && e.stack) || e); app.exit(1); });
