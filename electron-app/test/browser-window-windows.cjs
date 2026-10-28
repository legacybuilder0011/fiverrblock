"use strict";
const assert=require("assert/strict"), fs=require("fs"), os=require("os"), path=require("path");
const {spawn,execFile}=require("child_process");
const {restoreWindow,waitForWindow}=require("../src/browser-startup");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"ps-window-smoke-"));
const exe=path.join(process.env.APPDATA,"privacy-shield","fingerprint-chromium","ungoogled-chromium_148.0.7778.215-1.1_windows_x64","chrome.exe");
function ps(script) {
 const prefix=fs.readFileSync(path.join(__dirname,"../src/browser-window.ps1"),"utf8").split("$timer =")[0];
 return new Promise((resolve,reject)=>execFile("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(prefix+"\n"+script,"utf16le").toString("base64")],{windowsHide:true,timeout:20000},(err,out)=>err?reject(err):resolve(out.trim())));
}
let browser;
(async()=>{
 browser=spawn(exe,["--user-data-dir="+tmp,"--no-first-run","--no-default-browser-check","--disable-background-networking","--proxy-server=http://127.0.0.1:9","--new-window","about:blank"],{windowsHide:false,stdio:"ignore"});
 browser.on("error",()=>{});
 assert.equal((await waitForWindow(browser)).ok,true,"real browser window must be found");
 const handle="$h=(Get-Process -Id "+browser.pid+").MainWindowHandle; ";
 await ps(handle+"[PSBrowserWindow]::SetWindowPos($h,[IntPtr]::Zero,-24000,-24000,900,700,0x0044) | Out-Null");
 assert.equal((await restoreWindow(browser.pid)).ok,true);
 let state=await ps(handle+"$r=New-Object PSBrowserWindow+Rect; [PSBrowserWindow]::GetWindowRect($h,[ref]$r) | Out-Null; [bool]([PSBrowserWindow]::MonitorFromRect([ref]$r,0) -ne [IntPtr]::Zero)");
 assert.equal(state,"True","offscreen window must return to a monitor");
 await ps(handle+"[PSBrowserWindow]::ShowWindowAsync($h,6) | Out-Null; Start-Sleep -Milliseconds 300");
 assert.equal((await restoreWindow(browser.pid)).ok,true);
 state=await ps(handle+"[PSBrowserWindow]::IsIconic($h)");
 assert.equal(state,"False","minimized window must be restored");
 assert.equal((await restoreWindow(2147483647,0)).ok,false,"missing process must not report success");
 console.log("PASS real Patched Chromium startup, offscreen recovery, minimized recovery, missing PID");
})().catch(err=>{console.error(err);process.exitCode=1}).finally(async()=>{
 if(browser&&browser.pid) await new Promise(r=>execFile("taskkill",["/PID",String(browser.pid),"/T","/F"],{windowsHide:true},()=>r()));
 assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep+"ps-window-smoke-"));
 const literal=tmp.replace(/'/g,"''");
 const cleanup="$target = (Resolve-Path -LiteralPath '"+literal+"').Path; if ($target -ne '"+literal+"') { throw 'Unexpected test path' }; Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop";
 await new Promise((resolve,reject)=>execFile("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(cleanup,"utf16le").toString("base64")],{windowsHide:true,timeout:30000},err=>err?reject(err):resolve()));
});
