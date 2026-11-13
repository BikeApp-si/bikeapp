// Every production dependency's licence must sit well with Bike's Apache-2.0 (README › Licence). A new licence
// fails here until someone checks it and adds it, with why, below. Usage: pnpm licences:check
import { execFileSync } from "node:child_process";

export const ALLOWED: Record<string, string> = {
  MIT: "permissive",
  "MIT-0": "permissive",
  ISC: "permissive",
  "Apache-2.0": "Bike's own",
  "BSD-2-Clause": "permissive",
  "BSD-3-Clause": "permissive",
  "0BSD": "permissive",
  Unlicense: "public domain",
  "CC0-1.0": "public domain",
  "(MIT OR CC0-1.0)": "permissive",
  "CC-BY-4.0": "data (caniuse-lite's browser tables), credited in THIRD_PARTY_NOTICES.md",
  "SIL OPEN FONT LICENSE": "the Geist font, used as is, credited in THIRD_PARTY_NOTICES.md",
  "OFL-1.1": "fonts, used as is",
  "LGPL-3.0-or-later": "sharp's libvips, a separate library used unmodified, credited in THIRD_PARTY_NOTICES.md",
};

export type Listed = Record<string, { name: string; versions: string[] }[]>;

export function notAllowed(listed: Listed): string[] {
  return Object.entries(listed)
    .filter(([licence]) => !(licence in ALLOWED))
    .flatMap(([licence, pkgs]) => pkgs.map((p) => `${p.name} (${licence})`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const listed = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as Listed;
  const bad = notAllowed(listed);
  const count = Object.values(listed).reduce((n, p) => n + p.length, 0);
  if (bad.length) {
    console.error(`Licences not yet checked against Apache-2.0:\n  ${bad.join("\n  ")}\nCheck each, then add it to scripts/licences.ts with why.`);
    process.exit(1);
  }
  console.log(`${count} production dependencies, every licence checked.`);
}
