// Mirror the client's chaos simulation into the server (src/chaos/).
// The client repo (BEAR-PONG) owns it: run this after changing its
// src/sim/PongSim.ts or src/sim/curve.ts, then `npm test` here.
//   node scripts/sync-sim.mjs [path/to/BEAR-PONG]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const client = resolve(process.argv[2] ?? "../BEAR-PONG");
const banner = (f) => `// MIRRORED from BEAR-PONG/src/sim/${f} by scripts/sync-sim.mjs - do not edit here.\n`;
for (const f of ["PongSim.ts", "curve.ts"]) {
  let src = readFileSync(resolve(client, "src/sim", f), "utf8");
  // Node ESM wants explicit .js specifiers; the client's config is just the field
  src = src.replace(/from "\.\.\/config"/g, 'from "./field.js"').replace(/from "\.\/curve"/g, 'from "./curve.js"');
  writeFileSync(resolve("src/chaos", f), banner(f) + src);
  console.log("mirrored", f);
}
