import type { CapabilityFile, Role, Rule, Sheet, Step } from "./schema/file";
import { besideOf, columnText, roleText, stepText, type TextCtx } from "./render-text";

// A capability as simple pictures for Customize (V1, docs/plan.md §8f): its steps as a flow, who can see and do what
// as a grid, and, while a change waits for Apply, what that change adds and alters. Worked out from the file (and the
// saved file it would replace) with the same wording as the plain text: no AI, and the same files always give the
// same picture. Nothing here is a setting; changes still go through the chat.

export type Mark = "new" | "changed";

export type PictureStep = {
  id: string;
  n: number | null; // its place along the flow; end steps have none
  name: string;
  tone?: Step["tone"];
  start?: boolean;
  end?: Step["end"];
  brings: Brings[]; // what moves a row here, in each rule's own words ("When a signed PDF is added")
  only: string | null; // "for contracts over $50,000"
  waitsOn: string | null; // "Lena Ortiz"
  mark?: Mark;
};
// A rule's reading under its step; marked like the rule itself (counted once, with the rules).
export type Brings = { text: string; mark?: Mark; change?: Changed };
export type PictureFlow = { sheet: string; steps: PictureStep[]; ends: PictureStep[]; caption: string };

export type Cell = { kind: "yes" | "no" | "every" | "own" | "team" | "from"; steps?: string[]; mark?: Mark };
export type GridRow = { role: string; who: string | null; on: string | null; sees: Cell; adds: Cell; edits: Cell; moves: Cell; changes: Cell; mark?: Mark; newMembers: string[] };
export type Grid = { rows: GridRow[]; caption: string[] };

// Words to light in the sections that stay text: a new column or rule as it reads there, a changed rule's old and
// new wording split where they differ ("60" → "90").
export type Changed = { before: string; was: string; now: string; after: string };
export type TextMarks = { added: string[]; changed: Changed[] };

export type Picture = { flows: PictureFlow[]; grid: Grid; marks: TextMarks; summary: { added: number; changed: number } | null };

const rowsOf = (s: Sheet) => s.row ?? { one: "row", many: "rows" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Who a row waits on at a step: a person by name, else the column that names them, or that person's manager.
function waitWho(a: Extract<Rule["actions"][number], { kind: "ask_person" }>, sheet: Sheet, ctx: TextCtx): string {
  if (a.person) return ctx.personName(a.person) ?? "someone";
  const col = (id?: string) => sheet.columns.find((c) => c.id === id)?.name;
  if (a.managerOf) return `the ${col(a.managerOf) ?? "person"}’s manager`;
  if (a.column && !a.via) return `the ${col(a.column)?.toLowerCase() ?? "person"}`;
  return "the person named";
}

function flowOf(sheet: Sheet, file: CapabilityFile, ctx: TextCtx, before: CapabilityFile | null, underSheet: boolean): PictureFlow {
  const steps = sheet.steps ?? [];
  const was = before?.sheets.find((s) => s.id === sheet.id)?.steps ?? null;
  const rules = file.rules.filter((r) => r.enabled && r.trigger.sheet === sheet.id);
  const node = (st: Step, n: number | null): PictureStep => {
    const seen = new Set<string>();
    const brings: Brings[] = rules
      .filter((r) => r.actions.some((a) => (a.kind === "move_to_step" && a.step === st.id) || (a.kind === "ask_person" && a.step === st.id)))
      .filter((r) => !seen.has(r.reading.when) && seen.add(r.reading.when))
      .map((r) => {
        const prior = before?.rules.find((x) => x.id === r.id);
        if (before && !prior) return { text: r.reading.when, mark: "new" as const };
        if (prior && prior.reading.when !== r.reading.when) return { text: r.reading.when, mark: "changed" as const, change: splitChange(prior.reading.when, r.reading.when) };
        return { text: r.reading.when };
      });
    const ask = rules
      .filter((r) => (r.trigger.kind === "enters_step" && r.trigger.step === st.id) || r.actions.some((a) => a.kind === "ask_person" && a.step === st.id))
      .flatMap((r) => r.actions)
      .find((a): a is Extract<Rule["actions"][number], { kind: "ask_person" }> => a.kind === "ask_person" && (!a.step || a.step === st.id));
    const words = stepText(st, sheet, ctx);
    const prior = was?.find((x) => x.id === st.id);
    const mark: Mark | undefined = !was ? undefined : !prior ? "new" : prior.name !== st.name || !same(prior.onlyWhen, st.onlyWhen) ? "changed" : undefined;
    return {
      id: st.id,
      n,
      name: st.name,
      tone: st.tone,
      start: st.start,
      end: st.end,
      brings,
      only: words === st.name ? null : words.slice(st.name.length + 2),
      waitsOn: ask ? waitWho(ask, sheet, ctx) : null,
      ...(mark ? { mark } : {}),
    };
  };
  const flow = steps.filter((s) => !s.end);
  const ends = steps.filter((s) => s.end);
  const or = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : (xs[0] ?? ""));
  const arrows = [...flow.map((s) => stepText(s, sheet, ctx)), ...(ends.length ? [or(ends.map((e) => e.name))] : [])].join(" → ");
  // The plain text's own line: under its sheet when there is more than one flow ("Steps: Applied → … .").
  const caption = underSheet ? `Steps: ${arrows}.` : arrows;
  return { sheet: sheet.name, steps: flow.map((s, i) => node(s, i + 1)), ends: ends.map((s) => node(s, null)), caption };
}

function cells(r: Role, sheet: Sheet, file: CapabilityFile): Omit<GridRow, "role" | "who" | "on" | "mark" | "newMembers"> {
  const has = (p: Role["can"][number]): Cell => ({ kind: r.can.includes(p) ? "yes" : "no" });
  const scoped = (c: Cell): Cell => (c.kind === "yes" && r.scope !== "all" ? { kind: r.scope } : c);
  // A step by its name, on whichever of the role's sheets has it (Requesters move expenses on from Needs a receipt,
  // though their row in the grid is drawn for Purchases).
  const stepName = (id: string) => [sheet, ...file.sheets].map((x) => x.steps?.find((s) => s.id === id)?.name).find(Boolean) ?? id;
  const from = r.moveFrom?.map(stepName);
  const moves: Cell = !r.can.includes("move_steps") ? { kind: "no" } : from?.length ? { kind: "from", steps: from } : scoped({ kind: "yes" });
  return { sees: { kind: r.scope === "all" ? "every" : r.scope }, adds: has("add"), edits: scoped(has("edit")), moves, changes: has("customize") };
}

function whoOf(r: Role, file: CapabilityFile, ctx: TextCtx): string | null {
  if (r.members.kind === "people") return r.members.people.map((id) => ctx.personName(id) ?? "someone").join(", ") || null;
  if (r.members.kind === "column") {
    const m = r.members;
    const col = file.sheets.find((s) => s.id === m.sheet)?.columns.find((c) => c.id === m.column);
    return col ? `named in ${col.name}` : null;
  }
  return null;
}

function gridOf(file: CapabilityFile, ctx: TextCtx, before: CapabilityFile | null): Grid {
  const rows: GridRow[] = [];
  for (const r of file.roles) {
    const main = besideOf(r, file);
    if (main && !r.sheets?.length) continue; // switched off: says nothing, as in the text
    const sheet = file.sheets.find((s) => s.id === (r.sheets?.[0] ?? file.sheets[0]?.id)) ?? file.sheets[0]!;
    const c = cells(r, sheet, file);
    const prior = before?.roles.find((x) => x.id === r.id) ?? null;
    const newMembers = prior && r.members.kind === "people" && prior.members.kind === "people" ? r.members.people.filter((p) => !(prior.members as { people: string[] }).people.includes(p)).map((p) => ctx.personName(p) ?? "someone") : [];
    if (prior) {
      const pc = cells(prior, sheet, before!);
      for (const k of ["sees", "adds", "edits", "moves", "changes"] as const) if (!same(pc[k], c[k])) c[k] = { ...c[k], mark: "changed" };
    }
    rows.push({
      role: main ? main.name : r.members.kind === "everyone" ? "Everyone" : r.name,
      who: main ? null : whoOf(r, file, ctx),
      on: main ? rowsOf(sheet).many : null,
      ...c,
      ...(before && !prior ? { mark: "new" as const } : {}),
      newMembers,
    });
  }
  if (!file.roles.some((r) => r.members.kind === "everyone")) {
    const no: Cell = { kind: "no" };
    rows.push({ role: "Everyone else", who: null, on: null, sees: no, adds: no, edits: no, moves: no, changes: no, newMembers: [] });
  }
  const caption = [...file.roles.filter((r) => !besideOf(r, file)).map((r) => roleText(r, file, ctx)), ...(file.roles.some((r) => r.members.kind === "everyone") ? [] : ["Everyone else sees nothing."])];
  return { rows, caption };
}

// Where two sentences differ, word by word from each end: "60 days before …" and "90 days before …" give was "60",
// now "90".
export function splitChange(was: string, now: string): Changed {
  const a = was.split(" ");
  const b = now.split(" ");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const join = (xs: string[]) => xs.join(" ");
  return { before: join(b.slice(0, i)), was: join(a.slice(i, a.length - j)), now: join(b.slice(i, b.length - j)), after: join(b.slice(b.length - j)) };
}

function marksOf(file: CapabilityFile, ctx: TextCtx, before: CapabilityFile): TextMarks {
  const added: string[] = [];
  const changed: Changed[] = [];
  for (const s of file.sheets) {
    const was = before.sheets.find((x) => x.id === s.id);
    for (const c of s.columns) if (c.type !== "computed" && c.type !== "step" && !was?.columns.some((x) => x.id === c.id)) added.push(columnText(c, s, ctx));
  }
  for (const r of file.rules) {
    const prior = before.rules.find((x) => x.id === r.id);
    if (!prior) added.push(r.text);
    else if (prior.text !== r.text) changed.push(splitChange(prior.text, r.text));
  }
  return { added: [...new Set(added)], changed };
}

// before: the saved file a waiting change would replace; null when nothing waits, and nothing is marked.
export function renderCapabilityPicture(file: CapabilityFile, ctx: TextCtx, before: CapabilityFile | null = null): Picture {
  const withSteps = file.sheets.filter((s) => s.steps?.length);
  const flows = withSteps.map((s) => flowOf(s, file, ctx, before, withSteps.length > 1));
  const grid = gridOf(file, ctx, before);
  const marks = before ? marksOf(file, ctx, before) : { added: [], changed: [] };
  if (!before) return { flows, grid, marks, summary: null };
  const steps = flows.flatMap((f) => [...f.steps, ...f.ends]);
  const added = steps.filter((s) => s.mark === "new").length + grid.rows.filter((r) => r.mark === "new").length + grid.rows.reduce((n, r) => n + r.newMembers.length, 0) + marks.added.length;
  const changed = steps.filter((s) => s.mark === "changed").length + grid.rows.filter((r) => [r.sees, r.adds, r.edits, r.moves, r.changes].some((c) => c.mark)).length + marks.changed.length;
  return { flows, grid, marks, summary: { added, changed } };
}
