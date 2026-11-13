import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// An app set (G1): ready-made apps for one kind of company, kept in the repo as data, never code. A folder
// gallery/<set>/ holds set.json (its name, version, role slots and apps in order), apps/<key>.json (one ordinary
// app file each) and, when it has any, company-rules.json (the ordinary company rules list).
//
// What can't be known before a company adds the set is written as a reference: another app of the set as
// "@app:<key>" (a link's or a rule's capability, a company rule's capabilityId), a person as "@slot:<key>". A
// slot in a list of people (a role's members, who is told) stands for everyone it's filled with; anywhere else
// (who is asked, who confirms an AI step) for its one person.

const key = z.string().regex(/^[a-z0-9_]{1,40}$/, "Keys are lowercase letters, digits and _");

export const slotSchema = z.strictObject({
  key,
  name: z.string().trim().min(1).max(60), // "Principal", "Class teachers"
  titles: z.array(z.string().trim().min(1)).default([]), // job titles that suggest who fills it
  does: z.string().trim().min(1).max(160).optional(), // G2: what the slot does, under its name ("Approves or declines requests.")
  one: z.literal(true).optional(), // G3: always one person ("Accountant"), so it reads "Accountant sees" and takes one
});

export const manifestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80), // "K-12 school (CBSE)"
  version: z.number().int().min(1),
  description: z.string().trim().min(1).max(400),
  slots: z.array(slotSchema),
  apps: z.array(key).min(1), // in the order they're added: an app comes after the apps it reads
  // G2: its public page. Shown in the gallery only when listed, after someone from the industry has reviewed it.
  listed: z.boolean().default(false),
  tagline: z.string().trim().min(1).max(120).optional(), // the page's heading line: "School ERP for CBSE schools"
  expects: z.string().trim().min(1).max(200).optional(), // "For companies in India: ₹ and a year from April."
  leavesOut: z.array(z.string().trim().min(1).max(200)).max(8).default([]), // said plainly on the page
  beta: z.literal(true).optional(), // G3: new, and marked Beta wherever its name shows, so people know to expect changes
  usedBy: z.string().trim().min(1).max(40).optional(), // G4: who uses it, in the Beta line ("schools"); "companies" when left out
});

export type Slot = z.infer<typeof slotSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

// A set as read from its folder: the files as written, references and all. Checked by checkSet (check.ts).
export type AppSet = Manifest & { key: string; files: Record<string, unknown>; companyRules: unknown[] };

export class SetFormatError extends Error {}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SetFormatError(`${path.basename(file)} isn't readable JSON: ${(e as Error).message}`);
  }
}

export function loadSet(dir: string): AppSet {
  const parsed = manifestSchema.safeParse(readJson(path.join(dir, "set.json")));
  if (!parsed.success) throw new SetFormatError(`set.json: ${parsed.error.issues.map((i) => `${i.path.join(" › ")}: ${i.message}`).join("; ")}`);
  const files: Record<string, unknown> = {};
  for (const app of parsed.data.apps) {
    const file = path.join(dir, "apps", `${app}.json`);
    if (!existsSync(file)) throw new SetFormatError(`set.json lists “${app}”, but apps/${app}.json isn't there.`);
    files[app] = readJson(file);
  }
  const rulesFile = path.join(dir, "company-rules.json");
  const companyRules = existsSync(rulesFile) ? readJson(rulesFile) : [];
  if (!Array.isArray(companyRules)) throw new SetFormatError("company-rules.json must be a list of company rules.");
  return { ...parsed.data, key: path.basename(dir), files, companyRules };
}

// --- references ---------------------------------------------------------------------------------------------

const APP = /^@app:([a-z0-9_]+)$/;
const SLOT = /^@slot:([a-z0-9_]+)$/;

// Every reference a value holds, so the check can name the ones that don't exist.
export function referencesIn(value: unknown, out = { apps: new Set<string>(), slots: new Set<string>(), single: new Set<string>() }, inList = false) {
  if (typeof value === "string") {
    const a = APP.exec(value);
    if (a) out.apps.add(a[1]!);
    const s = SLOT.exec(value);
    if (s) {
      out.slots.add(s[1]!);
      if (!inList) out.single.add(s[1]!);
    }
  } else if (Array.isArray(value)) for (const v of value) referencesIn(v, out, true);
  else if (value && typeof value === "object") for (const v of Object.values(value)) referencesIn(v, out, false);
  return out;
}

export type Filled = { apps: Record<string, string>; slots: Record<string, string[]> };

// The value with each reference swapped for an app's id or the people filling a slot. A reference to nothing it
// knows is left as it is, and the kernel's file check refuses it.
export function resolve<T>(value: T, filled: Filled): T {
  const one = (v: unknown, inList: boolean): unknown[] => {
    if (typeof v === "string") {
      const a = APP.exec(v);
      if (a) return [filled.apps[a[1]!] ?? v];
      const s = SLOT.exec(v);
      if (s && filled.slots[s[1]!]) return inList ? filled.slots[s[1]!]! : [filled.slots[s[1]!]![0] ?? v];
      return [v];
    }
    if (Array.isArray(v)) {
      const out = v.flatMap((x) => one(x, true));
      // Two slots filled by the same person name them once.
      return [v.some((x) => typeof x === "string" && SLOT.test(x)) ? [...new Set(out)] : out];
    }
    if (v && typeof v === "object") return [Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x, false)[0]]))];
    return [v];
  };
  return one(value, false)[0] as T;
}
