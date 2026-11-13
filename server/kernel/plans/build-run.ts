import type { QuestionOutput } from "@/server/ai/prompts/import-question@2";
import type { PlannerOutput } from "@/server/ai/prompts/workspace-planner@2";
import type { Flag } from "@/server/files/documents";
import type { Part } from "../chats";
import type { CapabilityFile, Column, Sheet } from "../schema/file";
import type { ImportCheck } from "./import-check";
import { byName } from "./names";
import type { ReadText } from "./build";

// Build all (4c–4d), the kernel's side: the pages each capability reads, who can fill rows in, the check of
// the one question's choices and what each choice does, and the replies. Nothing here writes.

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const count = (n: number) => n.toLocaleString("en-US");

// The pages a capability reads, cut from each document by its [Page N] markers.
export function pagesOf(texts: ReadText[], refs: { file: string; pages: number[] }[]): ReadText[] {
  return refs.flatMap((ref) => {
    const doc = texts.find((t) => t.name === ref.file);
    if (!doc) return [];
    const wanted = new Set(ref.pages);
    const kept: string[] = [];
    let page = 1;
    let keep = wanted.has(1);
    for (const line of doc.text.split("\n")) {
      const marker = /^\[Page (\d+)\]$/.exec(line.trim());
      if (marker) {
        page = Number(marker[1]);
        keep = wanted.has(page);
      }
      if (keep) kept.push(line);
    }
    return kept.length ? [{ name: doc.name, pages: doc.pages, text: kept.join("\n") }] : [];
  });
}

// "3", "—" with no steps, "2 flows" when more than one sheet has steps (4d).
export function stepsLabel(file: CapabilityFile): string {
  const flows = file.sheets.filter((s) => s.steps?.length);
  if (!flows.length) return "—";
  return flows.length === 1 ? String(flows[0]!.steps!.length) : `${flows.length} flows`;
}

// The people who can edit every row of a sheet in a capability file not yet created: in a role with edit on
// that sheet, scope all, by name or as everyone.
export function editorsOf(file: CapabilityFile, sheetId: string, people: { id: string; name: string; email: string; title: string | null }[]) {
  const ids = new Set<string>();
  for (const r of file.roles) {
    if (!r.can.includes("edit") || r.scope !== "all" || (r.sheets && !r.sheets.includes(sheetId))) continue;
    if (r.members.kind === "everyone") people.forEach((p) => ids.add(p.id));
    if (r.members.kind === "people") r.members.people.forEach((id) => ids.add(id));
  }
  return people.filter((p) => ids.has(p.id));
}

// The sheets a table can be imported into: those whose rows stand on their own (not lines of a document).
export function importTargets(file: CapabilityFile): Sheet[] {
  return file.sheets.filter((s) => s.kind !== "lines");
}

// The sheet a table goes into: the one where most of its columns land (the first on a tie).
export function bestSheet<T extends { sheetId: string; mapped: number }>(options: T[]): T | undefined {
  return options.reduce<T | undefined>((best, o) => (!best || o.mapped > best.mapped ? o : best), undefined);
}

// What the empty columns can take in a fill choice.
const fillable = (c: Column) => c.type === "choice" || c.type === "text";

export function checkQuestion(q: QuestionOutput, ctx: { sheet: Sheet; gaps: ImportCheck["gaps"]; editors: { email: string }[] }): string[] {
  const problems: string[] = [];
  const n = ctx.gaps.length;
  if (!q.text.includes(count(n)) && !q.text.includes(String(n))) problems.push(`The question must say ${count(n)}, the number of rows.`);
  const empty = new Set(ctx.gaps.flatMap((g) => g.missing));
  for (const o of q.options) {
    if (o.kind === "wait" && !ctx.editors.some((e) => e.email.toLowerCase() === o.person?.toLowerCase()))
      problems.push(`"${o.label}": ${o.person ?? "nobody"} can't edit every row of ${ctx.sheet.name}; choose one of the people given.`);
    if (o.kind === "fill") {
      const column = o.column ? byName(ctx.sheet.columns, o.column) : undefined;
      if (!column || !empty.has(column.id)) problems.push(`"${o.label}": ${o.column ?? "no column"} isn't one of the empty columns.`);
      else if (empty.size > 1) problems.push(`"${o.label}": those rows have more than one empty column, so one value can't fill them.`);
      else if (!fillable(column)) problems.push(`"${o.label}": ${column.name} can't be filled with one value.`);
      else if (column.type === "choice" && !byName(column.options ?? [], o.value ?? "")) problems.push(`"${o.label}": ${o.value ?? "nothing"} isn't one of ${column.name}'s choices.`);
    }
  }
  if (q.options[0]?.kind === q.options[1]?.kind && q.options[0]?.kind !== "fill") problems.push("The two choices must do different things.");
  return problems;
}

// What the chosen answer does to the rows, and its line in "What I couldn't carry over".
export function applyAnswer(
  q: QuestionOutput,
  choice: number,
  ctx: { sheet: Sheet; gaps: ImportCheck["gaps"]; people: { id: string; name: string; email: string }[]; capability: string },
): { rows: { values: Record<string, unknown> }[]; gaps: { rows: ImportCheck["gaps"]; personId: string; label: string } | null; outcome: { item: string; why: string } } {
  const o = q.options[choice]!;
  const item = `${count(ctx.gaps.length)} ${ctx.sheet.row?.one ?? "row"} ${ctx.gaps.length === 1 ? "row" : "rows"}`;
  if (o.kind === "wait") {
    const person = ctx.people.find((p) => p.email.toLowerCase() === o.person?.toLowerCase())!;
    const names = [...new Set(ctx.gaps.flatMap((g) => g.missing))].map((id) => ctx.sheet.columns.find((c) => c.id === id)!.name.toLowerCase());
    const label = `Fill in the ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
    return { rows: [], gaps: { rows: ctx.gaps, personId: person.id, label }, outcome: { item, why: `${q.issue}. Listed in ${ctx.capability} for ${person.name.split(" ")[0]} to check.` } };
  }
  if (o.kind === "fill") {
    const column = byName(ctx.sheet.columns, o.column!)!;
    const value = column.type === "choice" ? byName(column.options ?? [], o.value!)!.id : o.value!;
    const name = column.type === "choice" ? byName(column.options ?? [], o.value!)!.name : o.value!;
    return { rows: ctx.gaps.map((g) => ({ values: { ...g.values, [column.id]: value } })), gaps: null, outcome: { item, why: `${q.issue}. Put under ${name}.` } };
  }
  return { rows: [], gaps: null, outcome: { item, why: `${q.issue}. Left out.` } };
}

// ── 4c, building ──

export type Built = { name: string; capabilityId: string; rows: number; of: number; sheets: number; steps: string; rules: number };

export function buildingParts(p: PlannerOutput, s: { people: { rows: number; of: number } | null; built: Built[]; waitingOn?: string }, totals: Map<string, number>): Part[] {
  const of = (files: string[]) => files.reduce((n, f) => n + (totals.get(f) ?? 0), 0);
  const peopleOf = p.people.file ? (totals.get(p.people.file) ?? 0) : 0;
  const rows: Extract<Part, { kind: "status" }>["rows"] = [
    { label: "People", state: s.people ? "done" : "doing", count: s.people ? (s.people.of ? `${count(s.people.rows)} of ${count(s.people.of)}` : "—") : peopleOf ? count(peopleOf) : "—" },
  ];
  let current = !!s.people;
  for (const c of p.capabilities) {
    const done = s.built.find((b) => b.name === c.name);
    const total = of(c.data);
    if (done) rows.push({ label: c.name, state: "done", count: done.of ? `${count(done.rows)} of ${count(done.of)}` : "—" });
    else if (current) {
      const waiting = s.waitingOn === c.name;
      rows.push({ label: c.name, state: waiting ? "waiting" : "doing", count: total ? (waiting ? `0 of ${count(total)}` : count(total)) : "—" });
      current = false;
    } else rows.push({ label: c.name, state: "next", count: total ? count(total) : "—" });
  }
  return [
    { kind: "text", text: "Building. Each app is checked against your files before the next one starts." },
    { kind: "status", head: "Capability", rows },
  ];
}

// "I read your write-up, 38 pages of policy and 6 files from Zoho. I'll fill People first, then build 6 capabilities. …"
export function collapsedLead(lead: string): string {
  const bits = lead.split("**");
  if (bits.length >= 3) return `${bits.slice(0, 2).join("").trimEnd()}. …`;
  const first = /^.*?[.!?](\s|$)/.exec(lead)?.[0]?.trim() ?? lead;
  return `${first} …`;
}

// ── 4d, done ──

// " I kept the 10 public holidays your policies list (p. 13)." when the build kept any.
function holidaysLine(p: PlannerOutput, kept: number): string {
  if (!kept) return "";
  const pages = [...new Set(p.holidays.map((h) => h.page).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const where = pages.length ? ` (p. ${pages.length > 1 && pages.at(-1)! - pages[0]! === pages.length - 1 ? `${pages[0]}–${pages.at(-1)}` : pages.join(", ")})` : "";
  return ` I kept the ${plural(kept, "public holiday")} your policies list${where}.`;
}

export function doneParts(
  p: PlannerOutput,
  s: { company: string; people: { rows: number; of: number }; built: Built[]; outcomes: { item: string; why: string }[]; flags: Flag[]; holidays?: number; ontology?: boolean },
): Part[] {
  const imported = s.people.rows + s.built.reduce((n, b) => n + b.rows, 0);
  const of = s.people.of + s.built.reduce((n, b) => n + b.of, 0);
  const rules = s.built.reduce((n, b) => n + b.rules, 0);
  const lead = `Done. ${s.company} now runs on Bike: People, **${plural(s.built.length, "app", "apps")}** with ${plural(p.connections.length, "connection")} and ${plural(rules, "rule")} between them, and ${count(imported)} of ${count(of)} rows imported.${holidaysLine(p, s.holidays ?? 0)}${s.ontology ? " I’ve written the Ontology page from them." : ""}`;
  const table: Part = {
    kind: "table",
    columns: ["App", "Sheets", "Steps", "Rows"],
    rows: [["People", "1", "—", count(s.people.rows)], ...s.built.map((b) => [b.name, String(b.sheets), b.steps, b.of || b.rows ? count(b.rows) : "—"])],
  };
  const couldNot = [
    ...s.outcomes,
    ...p.not_carried_over,
    ...s.flags.map((f) => ({ item: `${f.page ? `Page ${f.page} of ` : ""}${f.file}`, why: `“${f.excerpt}” reads like an instruction to Bike. Read as data, not followed.` })),
  ];
  const last = s.built.at(-1);
  return [
    { kind: "text", text: lead },
    table,
    ...(couldNot.length
      ? ([{ kind: "heading", text: "What I couldn’t carry over" }, { kind: "table", columns: ["Item", "Why, and what I did"], rows: couldNot.map((c) => [c.item, c.why]) }] as Part[])
      : []),
    ...(last ? [{ kind: "link", label: `Open ${last.name}`, href: `/c/${last.capabilityId}` } as Part] : []),
    { kind: "link", label: "Go to Home", href: "/home", outline: true },
  ];
}
