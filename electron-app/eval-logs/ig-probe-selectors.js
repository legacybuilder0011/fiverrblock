"use strict";
const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"] });
  const page = await browser.newContext({ viewport: { width: 1512, height: 900 } }).then(c => c.newPage());
  await page.goto("https://www.instagram.com/accounts/emailsignup/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const inp = Array.from(document.querySelectorAll("input")).map(i => ({ name: i.name, type: i.type, aria: i.getAttribute("aria-label"), ph: i.placeholder, id: i.id }));
    const sel = Array.from(document.querySelectorAll("select")).map(s => ({ name: s.name, aria: s.getAttribute("aria-label"), title: s.title, opts: s.options.length }));
    const btn = Array.from(document.querySelectorAll("button")).map(b => ({ type: b.type, text: (b.innerText || "").trim().slice(0, 30) }));
    return { inp, sel, btn };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
