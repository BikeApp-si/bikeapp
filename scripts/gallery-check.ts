// Checks every app set in gallery/ (G1) as the kernel will before it's added. Usage: pnpm gallery:check
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkSet } from "@/server/kernel/gallery/check";
import { loadSet, SetFormatError } from "@/server/kernel/gallery/format";

const dir = path.join(process.cwd(), "gallery");
const sets = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
let failed = 0;
for (const name of sets) {
  try {
    const r = checkSet(loadSet(path.join(dir, name)));
    if (r.ok) console.log(`✓ ${name}`);
    else {
      failed++;
      console.log(`✗ ${name}\n${r.problems.map((p) => `  ${p}`).join("\n")}`);
    }
  } catch (e) {
    if (!(e instanceof SetFormatError)) throw e;
    failed++;
    console.log(`✗ ${name}\n  ${e.message}`);
  }
}
if (!sets.length) console.log("No sets in gallery/ yet.");
process.exit(failed ? 1 : 0);
