// Starts the app's authenticated-proxy bridge inside the box and prints its
// local port (Chromium can't take proxy credentials on the command line).
const { getBridge } = require("./local-proxy-bridge");

const up = JSON.parse(process.env.PS_PROXY || "{}");
getBridge("box", up).then((b) => {
  if (!b) { console.error("bridge failed"); process.exit(1); }
  console.log(b.port);
});
