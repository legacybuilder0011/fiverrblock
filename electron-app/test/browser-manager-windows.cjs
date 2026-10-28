"use strict";
// Exercise the actual manager launch with isolated storage and the installed engine.
const assert=require("assert/strict"), fs=require("fs"), os=require("os"), path=require("path"), Module=require("module");
const cp=require("child_process");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ps manager smoke "));
const realExe=path.join(process.env.APPDATA,"privacy-shield","fingerprint-chromium","ungoogled-chromium_148.0.7778.215-1.1_windows_x64","chrome.exe");
const testExe=path.join(tmp,"fingerprint-chromium","ungoogled-chromium_148.0.7778.215-1.1_windows_x64","chrome.exe");
fs.mkdirSync(path.dirname(testExe),{recursive:true});fs.writeFileSync(testExe,"test-only path marker");
const originalLoad=Module._load;
Module._load=function(req,parent,main) {
 if(req==="electron")return {app:{getPath:()=>tmp}};
 if(req==="child_process")return {...cp,spawn:(exe,args,opts)=>cp.spawn(exe===testExe?realExe:exe,args,opts)};
 return originalLoad.call(this,req,parent,main);
};
const manager=require("../src/real-browser-manager");
const profile={id:"isolated-manager-test",engine:"patched-chromium",proxy:{networkMode:"proxy",enabled:true,scheme:"http",host:"127.0.0.1",port:9},fingerprint:{}};
(async()=>{
 const start=Date.now();
 const result=await manager.launchProfile(profile,"about:blank");
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.ok(manager.runningMap()[profile.id]);
 assert.equal((await manager.launchProfile(profile)).reused,true);
 console.log("PASS complete manager launch, bundled helper extension, temporary path with spaces, proxy arguments, existing window restore ("+((Date.now()-start)/1000).toFixed(1)+"s)");
})().catch(err=>{console.error(err);process.exitCode=1}).finally(async()=>{
 await manager.closeProfile(profile.id);
 Module._load=originalLoad;
 assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep+"ps manager smoke "));
 const literal=tmp.replace(/'/g,"''");
 const cleanup="$target=(Resolve-Path -LiteralPath '"+literal+"').Path; if($target -ne '"+literal+"'){throw 'Unexpected test directory'}; for($i=0;$i -lt 5;$i++){try{Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop;break}catch{if($i -eq 4){throw};Start-Sleep -Seconds 1}}";
 await new Promise((resolve,reject)=>cp.execFile("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(cleanup,"utf16le").toString("base64")],{windowsHide:true,timeout:30000},err=>err?reject(err):resolve()));
});
