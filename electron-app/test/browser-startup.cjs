"use strict";
const assert = require("assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const startup = require("../src/browser-startup");
const tick = () => new Promise(r => setImmediate(r));
function child(pid=123) {
  const c = new EventEmitter();
  Object.assign(c, {pid, exitCode:null, killed:false, kill() { this.killed=true; this.exitCode=0; this.emit("exit",0); }});
  return c;
}
(async () => {
  let c = child(), pending = startup.waitForWindow(c, () => new Promise(()=>{}));
  c.emit("error", {code:"EACCES"});
  assert.match((await pending).detail, /EACCES/);
  c=child(); pending=startup.waitForWindow(c,()=>new Promise(()=>{}));
  c.exitCode=23; c.emit("exit",23);
  assert.match((await pending).detail,/23/);
  c=child(); assert.equal((await startup.waitForWindow(c,async()=>({ok:false,reason:"window-missing"}))).ok,false);
  assert.equal(c.listenerCount("exit"),0);
  c=child(); assert.equal((await startup.waitForWindow(c,async()=>{throw Error("blocked")})).reason,"window-check-failed");
  console.log("PASS async spawn error, early exit, absent window, helper failure");

  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ps-startup-test-"));
  const bin=path.join(tmp,"fingerprint-chromium","ungoogled-chromium_148.0.7778.215-1.1_windows_x64","chrome.exe");
  fs.mkdirSync(path.dirname(bin),{recursive:true}); fs.writeFileSync(bin,"test stub");
  const original=Module._load;
  let spawned=[], resolveWindow, restoreCalls=0, restored={ok:true}, stopped=[];
  const fakeStartup={
    waitForWindow: c => startup.waitForWindow(c, () => new Promise(r=>{resolveWindow=r})),
    restoreWindow: async()=>{restoreCalls++;return restored;}
  };
  Module._load=function(req,parent,main) {
    if(req==="electron")return {app:{getPath:()=>tmp}};
    if(req==="child_process")return {spawn:()=>{const c=child(100+spawned.length);spawned.push(c);return c;},execFile:(exe,args,opts,cb)=>cb(null,"")};
    if(req==="./browser-startup")return fakeStartup;
    if(req==="./profile-store")return {buildConfigFromProfile:()=>({enabled:false})};
    if(req==="./local-proxy-bridge")return {getBridge:async()=>({port:12345}),stopBridge:id=>stopped.push(id)};
    return original.call(this,req,parent,main);
  };
  const manager=require("../src/real-browser-manager");
  const profile={id:"window-test",engine:"patched-chromium",proxy:{enabled:true,host:"localhost",port:8080,username:"test",password:"test"}};
  try {
    const one=manager.launchProfile(profile), two=manager.launchProfile(profile);
    assert.equal(one,two,"concurrent Starts must share one startup");
    await tick(); await tick();
    assert.equal(spawned.length,1);
    assert.deepEqual(manager.runningMap(),{},"not Running until a window exists");
    resolveWindow({ok:true});
    assert.equal((await one).ok,true);
    assert.equal(manager.runningMap()[profile.id],"real:100");
    assert.equal((await manager.launchProfile(profile)).reused,true);
    assert.equal(restoreCalls,1,"Start must restore existing window");
    const old=spawned[0]; await manager.closeProfile(profile.id);
    assert.deepEqual(manager.runningMap(),{});

    let next=manager.launchProfile(profile); await tick(); await tick();
    const firstMissing = resolveWindow;
    resolveWindow({ok:false,reason:"window-missing"});
    for (let i = 0; i < 20 && resolveWindow === firstMissing; i++) await tick();
    assert.notEqual(resolveWindow, firstMissing, "a missing window must retry once");
    assert.equal(spawned[1].killed,true,"the first windowless process is stopped");
    resolveWindow({ok:false,reason:"window-missing"});
    assert.equal((await next).ok,false);
    assert.equal(spawned[2].killed,true,"the GPU-spoof retry must be stopped too");
    assert.deepEqual(manager.runningMap(),{});

    next=manager.launchProfile(profile); await tick(); await tick(); resolveWindow({ok:true}); await next;
    old.emit("error",new Error("late event"));
    assert.equal(manager.runningMap()[profile.id],"real:103","old callbacks must not remove the new session");
    restored={ok:false,reason:"window-missing"};
    assert.equal((await manager.launchProfile(profile)).ok,false);
    assert.equal(spawned[3].killed,true);

    next=manager.launchProfile(profile); await tick(); await tick();
    spawned[4].emit("error",{code:"ENOENT"});
    assert.match((await next).detail,/ENOENT/);
    assert.deepEqual(manager.runningMap(),{});
    assert.ok(stopped.length>=4,"proxy bridge released after each failed/stopped launch");
    console.log("PASS concurrent Start, readiness status, restore, stalled cleanup, stale callbacks, spawn errors, proxy cleanup");
  } finally {
    Module._load=original;
    // Only the exact mkdtemp directory made by this test is removed.
    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep+"ps-startup-test-"));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
