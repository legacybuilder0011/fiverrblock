const { app } = require("electron");
const store = require("../src/profile-store");
app.whenReady().then(() => {
  const out=[];
  for(const n of ["LEAKTEST 1","LEAKTEST 2","LEAKTEST 3"]){ const ex=store.getProfiles().find(p=>!p.deletedAt&&p.name===n); const p=ex||store.createProfile({name:n,os:"windows",browserApp:"chrome"}); out.push(p.id); }
  console.log("IDS:"+out.join(","));
  app.exit(0);
});
