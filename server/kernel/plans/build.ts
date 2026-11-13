import type { PlannerOutput } from "@/server/ai/prompts/workspace-planner@2";
import type { Part } from "../chats";
import { LIMITS } from "../schema/validate";

// A build from documents (4a–4b), the kernel's side: what was read, who is who across the export's tables,
// the check of prompt 1's plan against what was read, and the reply that shows it. Nothing here writes;
// Build all applies the plan.

export type ReadText = { name: string; pages: number | null; text: string };
export type ReadTable = { file: string; from: string | null; table: string[][] };
export type Known = { name: string; email: string };
export type PeopleMatch = { file: string; column: string; matched: number; notInPeople: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const rowsOf = (t: ReadTable) => Math.max(0, t.table.length - 1);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domain = (email: string) => email.toLowerCase().split("@")[1] ?? "";

// ── 4a's Part / Status list ──

const FUNCTION_WORDS = new Set(["how", "our", "the", "what", "about", "notes", "company"]);

// "Read how Fernwood runs, 4 pages", "Read the policies, 38 pages", "Read the Zoho export: 6 files, 3,214 rows".
export function readLabel(file: { name: string; texts: ReadText[]; tables: ReadTable[] }): string {
  const base = file.name.replace(/\.[^.]+$/, "").trim();
  if (file.tables.length && /\.zip$/i.test(file.name)) {
    const rows = file.tables.reduce((n, t) => n + rowsOf(t), 0);
    const from = /^(.+?)[\s_-]+export$/i.exec(base)?.[1];
    const what = from ? `the ${from.charAt(0).toUpperCase()}${from.slice(1)} export` : base;
    return `Read ${what}: ${plural(file.tables.length, "file")}, ${plural(rows, "row")}`;
  }
  if (file.tables.length) return `Read ${base}, ${plural(rowsOf(file.tables[0]!), "row")}`;
  const pages = file.texts[0]?.pages;
  const first = base.split(/\s+/)[0]!.toLowerCase();
  const what = /polic/i.test(base) ? "the policies" : FUNCTION_WORDS.has(first) ? base.charAt(0).toLowerCase() + base.slice(1) : base;
  return pages ? `Read ${what}, ${plural(pages, "page")}` : `Read ${what}`;
}

// ── People across the files ──

// The table that holds the company's people: an email column with one row per person, nearly all at the
// admin's own email domain, and a column of names. The largest such table wins; none, null.
export function findPeopleTable(tables: ReadTable[], adminEmail: string): { file: string; email: number; name: number } | null {
  const own = domain(adminEmail);
  let best: { file: string; email: number; name: number; rows: number } | null = null;
  for (const t of tables) {
    const [header = [], ...rows] = t.table;
    if (rows.length < 2) continue;
    const email = header.findIndex((_, c) => {
      const values = rows.map((r) => (r[c] ?? "").trim().toLowerCase()).filter(Boolean);
      return values.length === rows.length && new Set(values).size === values.length && values.filter((v) => EMAIL.test(v) && domain(v) === own).length >= values.length * 0.8;
    });
    if (email < 0) continue;
    const name = header.findIndex((h, c) => c !== email && /name/i.test(h));
    if (name < 0) continue;
    if (!best || rows.length > best.rows) best = { file: t.file, email, name, rows: rows.length };
  }
  return best && { file: best.file, email: best.email, name: best.name };
}

// Everyone Bike knows: People already in the workspace and the people table's rows.
export function knownPeople(tables: ReadTable[], found: ReturnType<typeof findPeopleTable>, workspace: Known[]): Known[] {
  const out = new Map(workspace.map((p) => [p.email.toLowerCase(), p]));
  const t = found && tables.find((x) => x.file === found.file);
  for (const r of t?.table.slice(1) ?? []) {
    const email = (r[found!.email] ?? "").trim().toLowerCase();
    if (email && !out.has(email)) out.set(email, { name: (r[found!.name] ?? "").trim(), email });
  }
  return [...out.values()];
}

// For every other table, the columns that name people (by email, full name or a first name only one person
// has), how many rows match someone known, and the names or emails that match no one.
export function matchPeople(tables: ReadTable[], peopleFile: string | null, known: Known[], own: string): PeopleMatch[] {
  const byKey = new Map<string, number>();
  const firsts = new Map<string, number>();
  for (const p of known) {
    byKey.set(p.email.toLowerCase(), 1);
    if (p.name) byKey.set(p.name.toLowerCase(), 1);
    const first = p.name.split(/\s+/)[0]?.toLowerCase();
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const isKnown = (v: string) => byKey.has(v) || firsts.get(v) === 1;
  const ownDomain = domain(own);
  const out: PeopleMatch[] = [];
  for (const t of tables) {
    if (t.file === peopleFile) continue;
    const [header = [], ...rows] = t.table;
    header.forEach((column, c) => {
      const values = rows.map((r) => (r[c] ?? "").trim()).filter(Boolean);
      if (!values.length) return;
      const matched = values.filter((v) => isKnown(v.toLowerCase())).length;
      // A column of the company's own emails names people even where some match no one.
      const ownEmails = values.filter((v) => EMAIL.test(v) && domain(v) === ownDomain).length;
      if (matched < values.length * 0.6 && ownEmails < values.length * 0.6) return;
      const missing = [...new Set(values.filter((v) => !isKnown(v.toLowerCase())))].sort();
      out.push({ file: t.file, column, matched, notInPeople: missing.slice(0, 10) });
    });
  }
  return out;
}

// ── The check of prompt 1's plan ──

export type BuildFacts = {
  texts: ReadText[];
  tables: ReadTable[];
  existing: string[]; // capability names in the workspace
};

// The numbers the lead may use: page counts, file counts, row counts and the number of capabilities.
function allowedNumbers(f: BuildFacts, capabilities: number): Set<number> {
  const pages = f.texts.map((t) => t.pages ?? 0);
  const rows = f.tables.map(rowsOf);
  const zips = new Map<string, number>();
  for (const t of f.tables) if (t.from) zips.set(t.from, (zips.get(t.from) ?? 0) + 1);
  const files = new Set([...f.texts.map((t) => t.name), ...f.tables.map((t) => t.from ?? t.file)]).size;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return new Set([...pages, sum(pages), ...rows, sum(rows), f.tables.length, f.texts.length, files, ...zips.values(), capabilities, capabilities + 1]);
}

export function checkBuildPlan(p: PlannerOutput, f: BuildFacts): string[] {
  const problems: string[] = [];
  const tableNames = new Set(f.tables.map((t) => t.file));
  const textPages = new Map(f.texts.map((t) => [t.name, t.pages]));
  const lower = (s: string) => s.trim().toLowerCase();
  const existing = new Set(f.existing.map(lower));

  if (p.people.file && !tableNames.has(p.people.file)) problems.push(`people.file "${p.people.file}" isn't one of the tables.`);

  const names = new Set<string>();
  const used = new Map<string, string>();
  if (p.people.file) used.set(p.people.file, "People");
  for (const c of p.capabilities) {
    const n = lower(c.name);
    if (n === "people") problems.push(`People isn't an app; it comes first on its own.`);
    if (existing.has(n)) problems.push(`"${c.name}" already exists in the workspace.`);
    if (names.has(n)) problems.push(`"${c.name}" is planned twice.`);
    names.add(n);
    for (const file of c.data) {
      if (!tableNames.has(file)) problems.push(`"${c.name}" brings in "${file}", which isn't one of the tables.`);
      else if (used.has(file)) problems.push(`"${file}" goes to both ${used.get(file)} and ${c.name}; each table goes to one.`);
      else used.set(file, c.name);
    }
    for (const ref of c.pages) {
      if (!textPages.has(ref.file)) problems.push(`"${c.name}" reads pages of "${ref.file}", which isn't one of the documents.`);
      const max = textPages.get(ref.file);
      const over = max ? ref.pages.filter((n) => n > max) : [];
      if (over.length) problems.push(`"${ref.file}" has ${max} pages; "${c.name}" names page ${over[0]}.`);
    }
    if (c.rules.length > LIMITS.rules) problems.push(`"${c.name}" has ${c.rules.length} rules; at most ${LIMITS.rules}, the rest in not_carried_over.`);
  }
  for (const c of p.connections) {
    for (const end of [c.from, c.to]) if (lower(end) !== "people" && !names.has(lower(end))) problems.push(`The connection "${c.says}" names "${end}", which isn't in the plan.`);
  }
  for (const h of p.holidays) {
    if (!textPages.has(h.file)) problems.push(`The holiday "${h.name}" comes from "${h.file}", which isn't one of the documents.`);
    const max = textPages.get(h.file);
    if (max && h.page && h.page > max) problems.push(`"${h.file}" has ${max} pages; the holiday "${h.name}" names page ${h.page}.`);
  }
  const allowed = allowedNumbers(f, p.capabilities.length);
  for (const m of p.lead.match(/\d[\d,]*/g) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (!allowed.has(n)) problems.push(`The lead says ${m}, which isn't a page, file, row or app count from what was read.`);
  }
  return problems;
}

// ── 4b, the plan reply ──

const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);

export function buildPlanParts(p: PlannerOutput, tables: ReadTable[]): Part[] {
  const rows = new Map(tables.map((t) => [t.file, rowsOf(t)]));
  const data = (files: string[]) => (files.length ? files.map((f) => `${f} · ${plural(rows.get(f) ?? 0, "row")}`).join(", ") : "—");
  const table: Part = {
    kind: "table",
    columns: ["#", "App", "What it runs", "Data it brings in"],
    rows: [["1", "People", p.people.what, data(p.people.file ? [p.people.file] : [])], ...p.capabilities.map((c, i) => [String(i + 2), c.name, c.what_it_runs, data(c.data)])],
  };
  const rules = p.capabilities.reduce((n, c) => n + c.rules.length, 0);
  const after = [
    p.connections.length ? `I'll connect them where your policies hand work on: ${joinAnd(p.connections.map((c) => c.says))}.` : "",
    rules ? `Your policies also describe ${plural(rules, "approval and reminder rule")}. I'll write each one as a rule you can read in Customize, with what it would have done on your last 90 days of data.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    { kind: "text", text: p.lead },
    table,
    ...(after ? [{ kind: "text", text: after } as Part] : []),
    { kind: "text", text: "Nothing goes live until you say so." },
    { kind: "buttons", buttons: [{ action: "build", label: "Build all", primary: true }] },
  ];
}
