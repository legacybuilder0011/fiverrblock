const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../src/ipc-handlers.js'),'utf8');
const guard = source.slice(source.indexOf('function vpnIpHolder('), source.indexOf('async function runCloudGateTick('));
function setup() {
  const profiles=[{id:'a',name:'Local',proxy:{networkMode:'vpn'}},{id:'b',name:'Cloud',cloudRunning:'pc',proxy:{networkMode:'direct'}}];
  const state={real:[],camoufox:[]};
  const ctx={store:{getProfiles:()=>profiles},profileWindows:new Map(),realBrowser:{runningIds:()=>state.real},camoufox:{runningIds:()=>state.camoufox},cloudGateStatus:new Map(),networkModeOf:p=>p.proxy.networkMode};
  vm.runInNewContext(guard,ctx);
  return {...ctx,state,profiles};
}
test('external Chrome/Brave/Patched Chromium and Camoufox block concurrent cloud use of the PC network',()=>{
  for (const engine of ['real','camoufox']) {
    const h=setup();h.state[engine]=['a'];
    assert.equal(h.vpnIpHolder('b').where,'open on this PC');
    assert.equal(h.vpnIpHolder('a'),null);
    h.profiles[0].proxy.networkMode='proxy';
    assert.equal(h.vpnIpHolder('b'),null,'independent proxies do not occupy system network slot');
  }
});
test('live local engines take precedence over cloud slots; closed windows are ignored',()=>{
  const h=setup();h.cloudGateStatus.set('b',{active:true});
  assert.equal(h.vpnIpHolder(null).where,'running in the cloud');
  h.profileWindows.set('a',{isDestroyed:()=>true});
  assert.equal(h.vpnIpHolder(null).where,'running in the cloud');
  h.state.real=['a'];
  assert.equal(h.vpnIpHolder(null).where,'open on this PC');
});
