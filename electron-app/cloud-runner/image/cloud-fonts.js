"use strict";

// Fonts a normal Windows PC always has. These stay installed in every box.
// The optional list is fonts that really do vary between Windows installs.
// Each profile rejects a stable subset so a page's font-width list differs,
// while Segoe UI, Arial, Comic Sans, Georgia and the other core faces stay.
const OPTIONAL = [
  "Gabriola",
  "Ink Free",
  "Segoe Print",
  "Segoe Script",
  "MV Boli",
  "Javanese Text",
  "Myanmar Text",
  "Microsoft Himalaya",
  "Mongolian Baiti",
  "Sitka",
  "Segoe UI Historic",
  "Gadugi"
];

function mix(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function rejectedFonts(seed) {
  // A running multiply's low bit only has two patterns, so every profile
  // rejected the same faces. Mix each face on its own.
  const base = Number(seed) >>> 0 || 1;
  const drop = OPTIONAL.map((_, i) => {
    const n = (Math.imul(base, i + 0x9e3779b1) ^ ((i + 1) * 0x85ebca6b)) >>> 0;
    return (mix(n) & 1) === 1;
  });
  let n = drop.filter(Boolean).length;
  for (let i = 0; n < 3 && i < drop.length; i++) {
    if (!drop[i]) { drop[i] = true; n++; }
  }
  for (let i = drop.length - 1; n > drop.length - 3 && i >= 0; i--) {
    if (drop[i]) { drop[i] = false; n--; }
  }
  return OPTIONAL.filter((_, i) => drop[i]);
}

function fontConfig(seed) {
  const rejected = rejectedFonts(seed);
  const blocks = rejected.map((name) =>
    `    <rejectfont><pattern><patelt name="family"><string>${name}</string></patelt></pattern></rejectfont>`
  ).join("\n");
  return `<?xml version="1.0"?>
<fontconfig>
  <dir>/usr/share/fonts/windows</dir>
  <cachedir>/tmp/fontconfig-cache</cachedir>
  <alias><family>sans-serif</family><prefer><family>Arial</family></prefer></alias>
  <alias><family>serif</family><prefer><family>Times New Roman</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Consolas</family></prefer></alias>
  <alias><family>cursive</family><prefer><family>Comic Sans MS</family></prefer></alias>
  <alias><family>fantasy</family><prefer><family>Impact</family></prefer></alias>
  <selectfont>
${blocks}
  </selectfont>
  <match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit><edit name="hinting" mode="assign"><bool>true</bool></edit><edit name="rgba" mode="assign"><const>rgb</const></edit></match>
</fontconfig>
`;
}

module.exports = { OPTIONAL, rejectedFonts, fontConfig };

if (require.main === module) {
  process.stdout.write(fontConfig(process.argv[2] || "1"));
}
