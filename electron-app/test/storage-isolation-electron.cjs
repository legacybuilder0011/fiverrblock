const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-isolation-'));
app.setPath('userData', root);
app.setPath('sessionData', root);
app.disableHardwareAcceleration();
const windows = [];
let blockedHits = 0;
const server = http.createServer((req,res) => {
  if (req.url === '/blocked') blockedHits++;
  res.setHeader('Content-Type',req.url === '/sw.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/sw.js' ? 'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(clients.claim()));' : '<!doctype html><title>Isolated storage test</title>');
});
const operation = async (value) => {
  const db = await new Promise((resolve,reject) => { const r=indexedDB.open('ps-test',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
  if (value) {
    document.cookie='marker='+value+'; Path=/; SameSite=Lax'; localStorage.setItem('marker',value);
    await new Promise((resolve,reject)=>{const tx=db.transaction('values','readwrite');tx.objectStore('values').put(value,'marker');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    await (await caches.open('ps-test')).put('/marker',new Response(value));
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  }
  const indexed = await new Promise((resolve,reject)=>{const r=db.transaction('values').objectStore('values').get('marker');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
  db.close(); const cached=await (await caches.open('ps-test')).match('/marker');
  return { cookie:document.cookie, local:localStorage.getItem('marker'), indexed, cache:cached?await cached.text():null, workers:(await navigator.serviceWorker.getRegistrations()).length };
};
app.whenReady().then(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const manager=require('../src/session-manager');
  const make=async(id)=>{
    const session=manager.getSessionForProfile(id);
    const w=new BrowserWindow({show:false,webPreferences:{session,nodeIntegration:false,contextIsolation:true,sandbox:true}});windows.push(w);
    manager.assertProfileSession(w.webContents.session,id);
    await w.loadURL(url); return w;
  };
  const a=await make('audit-A'), b=await make('audit-B');
  assert.notEqual(a.webContents.session.storagePath,b.webContents.session.storagePath);
  const run=(w,value)=>w.webContents.executeJavaScript('('+operation.toString()+')('+JSON.stringify(value)+')');
  await run(a,'A');
  assert.deepEqual(await run(b,null),{cookie:'',local:null,indexed:null,cache:null,workers:0});
  await run(b,'B');
  assert.deepEqual(await run(a,null),{cookie:'marker=A',local:'A',indexed:'A',cache:'A',workers:1});
  assert.deepEqual(await run(b,null),{cookie:'marker=B',local:'B',indexed:'B',cache:'B',workers:1});
  a.destroy();
  assert.equal((await run(await make('audit-A'),null)).local,'A');
  console.log('PASS: separate profile cookies, localStorage, IndexedDB, CacheStorage, service workers, and reopened session');
  const c=await make('audit-network');
  const blocker=http.createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const port=blocker.address().port;await new Promise(r=>blocker.close(r));
  await manager.configureSessionProxy(c.webContents.session,{networkMode:'proxy',enabled:true,scheme:'http',host:'127.0.0.1',port,bypassList:['<-loopback>']},'audit-network');
  await c.webContents.session.closeAllConnections();
  await assert.rejects(c.loadURL(url+'/blocked'),/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/);
  assert.equal(blockedHits,0,'failed proxy must not fall back to direct network');
  console.log('PASS: failed proxy blocks request without direct fallback');
  fs.writeFileSync(path.join(__dirname,'../../../scratchpad/ps-storage-result.json'),JSON.stringify({passed:true,capturedAt:new Date().toISOString(),temporaryData:root}));
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
setTimeout(()=>{console.error('Isolation check timed out');app.exit(1);},45000).unref();
