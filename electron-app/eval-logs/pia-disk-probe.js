"use strict";
// Read PIA's newest saved proxy token from the profile's extension storage on
// disk (no debug port needed) and ask PIA servers whether they accept it.
// Never prints the token. node pia-disk-probe.js <brave user-data-dir> <host...>
const fs = require("fs"), path = require("path"), tls = require("tls");
const [udd, ...hosts] = process.argv.slice(2);
const dir = path.join(udd, "Default", "Local Extension Settings", "jplnlifepflhkbkgonidnobkakhmpnmh");
let best = null;
for (const f of fs.readdirSync(dir).filter((n) => /\.(log|ldb)$/.test(n))) {
  const p = path.join(dir, f);
  let buf;
  try { const fd = fs.openSync(p, "r"); const st = fs.fstatSync(fd); buf = Buffer.alloc(st.size); fs.readSync(fd, buf, 0, st.size, 0); fs.closeSync(fd); } catch (e) { continue; }
  const txt = buf.toString("latin1");
  const re = /PIA_proxy_auth_token[\s\S]{0,40}?"value":"([A-Za-z0-9+/=_-]{60,400})"/g;
  let m;
  while ((m = re.exec(txt))) best = { tok: m[1], file: f, at: fs.statSync(p).mtimeMs, pos: m.index };
}
if (!best) { console.log("no token found on disk"); process.exit(0); }
console.log("token length", best.tok.length, "from", best.file, new Date(best.at).toISOString());
const probe = (host, user, pass) => new Promise((res) => {
  const s = tls.connect({ host, port: 443, servername: host }, () => {
    s.write(`CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: Basic ${Buffer.from(user + ":" + pass).toString("base64")}\r\n\r\n`);
  });
  s.setTimeout(15000, () => { res("timeout"); s.destroy(); });
  s.once("data", (d) => { res(String(d).split("\r\n")[0]); s.destroy(); });
  s.on("error", (e) => res("error " + e.message));
});
(async () => {
  const h = best.tok.length / 2;
  for (const host of hosts) console.log(host, "->", await probe(host, best.tok.slice(0, h), best.tok.slice(h)));
})();
