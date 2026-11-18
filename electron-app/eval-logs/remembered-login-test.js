"use strict";
const { app, safeStorage } = require("electron");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "rl-")));
app.whenReady().then(() => {
  const rl = require(path.join(__dirname, "..", "src", "remembered-login"));
  const file = path.join(app.getPath("userData"), "privacy-shield", "remembered-login.json");
  // Old single-password file keeps working.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ email: "a@x.com", passwordEnc: safeStorage.encryptString("pwA").toString("base64") }));
  assert.deepStrictEqual(rl.get(), { email: "a@x.com", password: "pwA" });
  // A second account keeps its own password; the first one's survives.
  rl.remember("B@x.com ", "pwB");
  assert.deepStrictEqual(rl.get(), { email: "b@x.com", password: "pwB" });
  assert.deepStrictEqual(rl.get("a@x.com"), { email: "a@x.com", password: "pwA" });
  assert.deepStrictEqual(rl.get("b@x.com"), { email: "b@x.com", password: "pwB" });
  // Unticking Remember me forgets only that account.
  rl.remember("a@x.com", null);
  assert.strictEqual(rl.get("a@x.com").password, "");
  assert.strictEqual(rl.get("b@x.com").password, "pwB");
  rl.forgetPassword("b@x.com");
  assert.strictEqual(rl.get("b@x.com").password, "");
  assert.ok(!fs.readFileSync(file, "utf8").includes("pwB"), "never stored in clear text");
  console.log("PASS remembered-login: per-account passwords, old format, forget");
  app.quit();
});
