const { app } = require("electron");
const store = require("./src/profile-store");
const sessionMgr = require("./src/session-manager");
const A="mr6z8sowtedb87", B="mr6zvzzcjh8k5t";
app.whenReady().then(async()=>{
  try{
    const sa=sessionMgr.getSessionForProfile(A), sb=sessionMgr.getSessionForProfile(B);
    console.log("PARTITION_A:", sa.storagePath);
    console.log("PARTITION_B:", sb.storagePath);
    console.log("SAME_SESSION_OBJECT:", sa===sb);
    // set a cookie in A only
    await sa.cookies.set({ url:"https://example.com/", name:"psiso", value:"SECRET_A", expirationDate: Date.now()/1000+3600 });
    const aCookies=await sa.cookies.get({ name:"psiso" });
    const bCookies=await sb.cookies.get({ name:"psiso" });
    console.log("A_HAS_COOKIE:", aCookies.length, aCookies.map(c=>c.value).join(","));
    console.log("B_HAS_COOKIE:", bCookies.length, bCookies.map(c=>c.value).join(","));
    console.log("ISOLATION_OK:", aCookies.length===1 && bCookies.length===0);
    // cleanup
    await sa.cookies.remove("https://example.com/","psiso");
  }catch(e){ console.log("TEST_ERR:", e.message); }
  app.exit(0);
});
