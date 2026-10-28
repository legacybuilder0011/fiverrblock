// Starts the app's authenticated-proxy bridge inside the box and prints its
// local port (Chromium can't take proxy credentials on the command line).
const fs = require("fs");
const bridge = require("./local-proxy-bridge");

// Press & Hold detection: note when the browser connects to a human-check
// (HUMAN/PerimeterX captcha) server — only these hostnames, nothing else, and
// never any page content. The runner's watcher reads this file.
const CHECK_HOSTS = /(^|\.)(captcha\.px-(cdn|cloud)\.net|perimeterx\.net)$/i;
bridge.onConnect = (target) => {
  const host = String(target || "").split(":")[0];
  if (CHECK_HOSTS.test(host)) fs.writeFile("/tmp/ps-checks.log", `${Date.now()} ${host}\n`, () => {});
};

const up = JSON.parse(process.env.PS_PROXY || "{}");
bridge.getBridge("box", up).then((b) => {
  if (!b) { console.error("bridge failed"); process.exit(1); }
  console.log(b.port);
});
