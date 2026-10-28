"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const net = require("node:net");
const { once } = require("node:events");
const source = fs.readFileSync(require("node:path").join(__dirname, "../cloud-runner/runner/server.js"), "utf8");
function harness() {
  const files = new Map([["/opt/ps-cloud/runner/token", "test-only-secret"]]);
  const state = { owners: {}, rows: "", title: "It needs a human touch - Chromium", accepts: true, posts: [] };
  const fakeFs = {
    readFileSync(p) { if (!files.has(p)) throw Error("ENOENT"); return files.get(p); },
    writeFileSync(p, v) { files.set(p, v); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    existsSync(p) { return files.has(p); }
  };
  const ctx = {
    require(name) {
      if (name === "path") return require("node:path").posix;
      if (name === "fs") return fakeFs;
      if (name === "http") return { createServer(handler) { state.handler = handler; return { on() {}, listen() {} }; } };
      if (name === "child_process") return { execFile(cmd, args, opts, cb) {
        let out = "", err = null;
        if (args[0] === "inspect") {
          const id = args.at(-1).slice(3);
          if (state.inspectError) err = Error(state.inspectError);
          else if (!(id in state.owners)) err = Error("No such object"); else out = state.owners[id];
        } else if (args[0] === "ps") out = state.rows;
        else if (args[0] === "exec" && args.includes("xdotool")) out = state.title;
        cb(err, out, "");
      } };
      return require(name);
    },
    process: { env: {} }, Buffer, URL, AbortSignal,
    console: { log() {}, error() {} }, setInterval() {}, setTimeout, clearTimeout,
    fetch: async (url, opts) => { state.posts.push(JSON.parse(opts.body)); return { ok: state.accepts, status: state.accepts ? 200 : 503 }; }
  };
  vm.runInNewContext(source + "\nthis.api={canAccess,claimBox,list,challengeWatch,notifyPhone,readPass,relays,openRelay,closeRelay,acceptTunnel,CHECK_HOSTS,lastAlert};", ctx);
  return { ...ctx.api, files, state, json(name, value) { files.set('/opt/ps-cloud/runner/' + name, JSON.stringify(value)); } };
}

test("legacy claims enforce account boundaries and survive container removal", async () => {
  const h = harness(); h.state.owners.legacy = "";
  h.json("claims.json", { legacy: "alice" });
  assert.equal(await h.canAccess("alice", "legacy"), true);
  assert.equal(await h.canAccess("bob", "legacy"), false);
  delete h.state.owners.legacy;
  assert.equal(await h.canAccess("bob", "legacy", true), false);
  assert.equal(await h.canAccess("alice", "legacy", true), true);
  h.state.owners.unclaimed = "";
  assert.equal(await h.canAccess("bob", "unclaimed", true), false);
  assert.equal(await h.canAccess("bob", "new", true), true);
  assert.equal(await h.canAccess("bob", "new"), false);
  h.files.set("/opt/ps-cloud/profiles/orphan", "directory");
  assert.equal(await h.canAccess("bob", "orphan", true), false);
  assert.equal(await h.canAccess("admin", "../bad", true), false);
  assert.equal(h.claimBox("new", "alice"), true);
  assert.equal(h.claimBox("new", "bob"), false);
  h.state.inspectError = 'Cannot connect to Docker';
  await assert.rejects(h.canAccess('bob', 'unknown', true), /Could not verify/);
});

test("labelled ownership is persisted before stop and claimed profiles appear only to owner", async () => {
  const h = harness(); h.state.owners.profile = "alice";
  assert.equal(await h.canAccess("alice", "profile"), true);
  delete h.state.owners.profile;
  assert.equal(await h.canAccess("bob", "profile", true), false);
  h.state.rows = "profile\tUp 1 hour\tpc\t";
  assert.equal((await h.list("alice")).body.boxes.length, 1);
  assert.equal((await h.list("bob")).body.boxes.length, 0);
});

test("failed notification retries and legacy phone link authenticates the actual owner", async () => {
  const h = harness();
  h.json("claims.json", { legacy: "alice" });
  h.json("alerts.json", { alice: { topic: "test-topic-only-123456789" } });
  h.state.rows = "legacy\t\trtc\tExample\tUp 1 hour";
  h.state.accepts = false;
  await h.challengeWatch();
  assert.equal(h.lastAlert.has("legacy"), false);
  h.state.accepts = true;
  await h.challengeWatch();
  assert.equal(h.state.posts.length, 2);
  const pass = new URL(h.state.posts[1].click).searchParams.get("p");
  assert.equal(h.readPass(pass), "alice");
  assert.equal(h.lastAlert.has("legacy"), true);
  await h.challengeWatch();
  assert.equal(h.state.posts.length, 2, "accepted notifications are throttled");
});

test("challenge host matching does not accept suffix lookalikes", () => {
  const h = harness();
  for (const host of ["captcha.px-cdn.net", "captcha.px-cloud.net", "x.perimeterx.net"]) assert.ok(h.CHECK_HOSTS.test(host));
  for (const host of ["notperimeterx.net", "perimeterx.net.evil.test", "captcha.px-cdn.net.evil.test", "client.px-cloud.net"]) assert.ok(!h.CHECK_HOSTS.test(host));
});

test("queued CONNECT bytes survive a delayed tunnel, including fragmented first line", { timeout: 5000 }, async () => {
  const h = harness(); const relay = await h.openRelay("test", "127.0.0.1", 0);
  const box = net.connect(relay.port, "127.0.0.1");
  let pc, accepted; const endpoint = net.createServer(s => { accepted = s; });
  await new Promise(r => endpoint.listen(0, "127.0.0.1", r));
  try {
    await once(box, "connect");
    box.write("CON");
    await new Promise(r => setTimeout(r, 60));
    pc = net.connect(endpoint.address().port, "127.0.0.1");
    const chunks = []; pc.on("data", d => chunks.push(d));
    await once(pc, "connect");
    while (!accepted) await new Promise(r => setTimeout(r, 1));
    h.acceptTunnel("test", accepted);
    await new Promise(r => setTimeout(r, 40));
    box.write("NECT captcha.px-cdn.net:443 HTTP/1.1\r\nHost: captcha.px-cdn.net\r\n\r\n");
    const until = Date.now() + 1500;
    while ((!relay.lastCheckAt || !Buffer.concat(chunks).includes("Host:")) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.ok(Buffer.concat(chunks).toString().includes("CONNECT captcha.px-cdn.net:443 HTTP/1.1\r\nHost:"));
    assert.ok(relay.lastCheckAt > 0);
  } finally {
    box.destroy(); if (pc) pc.destroy(); if (accepted) accepted.destroy(); h.closeRelay("test"); endpoint.close();
  }
});
