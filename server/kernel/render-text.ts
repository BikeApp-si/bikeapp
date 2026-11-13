import { isBalanceOf, isOp, walk, type Expr } from "./expr/ast";
import { formatMoney, renderExpr, type RenderCtx } from "./expr/render";
import { datedOf, ledgerOf, type CapabilityFile, type Column, type Role, type Sheet, type Step } from "./schema/file";
import { dayIn, formatDate, formatDay, type Formats } from "@/lib/format";
import { quickOf, tabsOf } from "./form";
import { includesRowsUnder } from "./query";
import { LIMITS } from "./schema/validate";
import { parentColumn } from "./tree";

// A capability as plain text, from its file with fixed templates: no AI, and the same file always gives the
// same text. The plan's side panel shows it before Create (5d, 5f, 5k); Customize shows it beside its chat
// (developer notes §6). In a plan, sentences are for the person reading it, so they are "You"; Customize is
// shared among admins, so it names people as People holds them (no viewer).

export type TextSection = { heading: string; lines: string[]; muted?: boolean };

export type TextCtx = {
  capId: string;
  files: ReadonlyMap<string, CapabilityFile>; // every capability, this one included
  personName(id: string): string | undefined;
  viewerId: string | null; // null: Customize, which names everyone
  // The company's rules (0.2): those with a part on this capability are listed, read-only (Customize can't change
  // them; the Company rules tab on the Ontology page does).
  company?: readonly { text: string; applications: readonly { capabilityId: string }[] }[];
  // Leaves out the form's line (0.3): the text Customize sends its prompt, until prompt 3 learns the form (M17b).
  withoutForm?: boolean;
  formats?: Formats; // the company's money, numbers and dates (M26); dollars when left out
  // A stand-in for several people (G2: a set's slot, before a company fills it, that's never one person), so
  // "Team leads see" reads as a group.
  group?(id: string): boolean;
};

// A plan's own sections: what it changes elsewhere, and connections it suggests but doesn't build.
export type PlanExtras = { alsoChanges?: string[]; suggested?: string[] };

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));
const orList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : (xs[0] ?? ""));
const rowWords = (s: Sheet) => s.row ?? { one: "row", many: "rows" };

function renderCtx(ctx: TextCtx, sheet: Sheet): RenderCtx {
  return {
    column: (id) => sheet.columns.find((c) => c.id === id),
    otherColumn: (sheetId, column, cap) => {
      const s = ctx.files.get(cap ?? ctx.capId)?.sheets.find((x) => x.id === sheetId);
      return { sheet: s?.name ?? sheetId, column: s?.columns.find((c) => c.id === column)?.name ?? column };
    },
    otherStep: (sheetId, step, cap) => ctx.files.get(cap ?? ctx.capId)?.sheets.find((x) => x.id === sheetId)?.steps?.find((s) => s.id === step)?.name,
    personName: (id) => (ctx.viewerId && id === ctx.viewerId ? "you" : ctx.personName(id)),
    formats: ctx.formats,
    linkedColumn: (via, col) => {
      const link = sheet.columns.find((c) => c.id === via)?.link;
      return ctx.files.get(link?.capability ?? ctx.capId)?.sheets.find((s) => s.id === link?.sheet)?.columns.find((c) => c.id === col);
    },
  };
}

// "Renews on (date, Start + 1 year)", "Customer tier (Standard or Enterprise, required)",
// "Purchase (a purchase in Spend, required)", "Notice (days: 90 for Enterprise, 30 for Standard)".
export function columnText(c: Column, sheet: Sheet, ctx: TextCtx): string {
  let kind: string = c.type.replace("_", " ");
  if (c.type === "choice") kind = orList((c.options ?? []).map((o) => o.name));
  if (c.type === "datetime") kind = "date and time";
  if (c.type === "number" && c.min !== undefined && c.max !== undefined) kind = `${c.min} to ${c.max}`;
  if (c.type === "link" && c.link) {
    const cap = ctx.files.get(c.link.capability ?? ctx.capId);
    const target = cap?.sheets.find((s) => s.id === c.link!.sheet);
    const elsewhere = c.link.capability && c.link.capability !== ctx.capId ? ` in ${cap?.name}` : "";
    // A plan says "a purchase in Spend" (5k); Customize "one row from Openings" (6g), naming the capability only when
    // its name isn't the sheet's ("one row from Customers", not "from Customers in Customers").
    const named = target && cap && target.name.trim().toLowerCase() === cap.name.trim().toLowerCase();
    kind = ctx.viewerId ? `a ${target ? rowWords(target).one : "row"}${elsewhere}` : `one row from ${target?.name ?? "another sheet"}${named ? "" : elsewhere}`;
    // A tree's own column: "Under (the cost centre it sits under)" (M28).
    if (c.id === parentColumn(sheet)) kind = `the ${rowWords(sheet).one} it sits under`;
    // A ledger's reversal (M29): "Reverses (the entry it reverses)".
    if (c.id === ledgerOf(sheet)?.reverses) kind = `the ${rowWords(sheet).one} it reverses`;
  }
  // A dated sheet's end (M30): "Until (the day before the next limit for the same category)".
  const dated = datedOf(sheet);
  if (dated && c.id === dated.until) {
    const key = sheet.columns.find((x) => x.id === dated.key)?.name.toLowerCase();
    return `${c.name} (the day before the next ${rowWords(sheet).one}${key ? ` for the same ${key}` : " starts"})`;
  }
  // A ledger's balance after each entry (M29): "Balance after (Who's entries added up, to this one)".
  const l = ledgerOf(sheet);
  if (l && c.id === l.balance) {
    const account = sheet.columns.find((x) => x.id === l.account)?.name ?? "its account";
    return `${c.name} (${account}'s ${rowWords(sheet).many} added up, to this one)`;
  }
  const d = c.default;
  const r = renderCtx(ctx, sheet);
  if (d?.kind === "expr" && isOp(d.expr) && d.expr.op === "if") return `${c.name} (${kind}: ${renderExpr(d.expr, r)}${c.required ? ", required" : ""})`;
  const def =
    d?.kind === "creator" ? (ctx.viewerId ? "you" : "whoever adds it") : d?.kind === "today" ? "today" : d?.kind === "expr" ? renderExpr(d.expr, r) : d?.kind === "value" ? renderExpr(d.value as Expr, { ...r, column: () => c }, c) : null;
  const value = def && c.type === "days" && d?.kind === "value" ? String(d.value) : def;
  const when = c.showWhen ? `shown when ${renderExpr(c.showWhen, r)}` : null;
  return `${c.name} (${[kind, c.required ? "required" : null, value, when].filter(Boolean).join(", ")})`;
}

// A tree (M28): "Cost centres sit under each other, up to 8 levels deep; one with cost centres under it can't be
// deleted. Total spent includes the cost centres under it."
function treeText(s: Sheet): string[] {
  if (!parentColumn(s)) return [];
  const { many } = rowWords(s);
  const Many = many.charAt(0).toUpperCase() + many.slice(1);
  const totals = s.columns.filter((c) => includesRowsUnder(s, c)).map((c) => c.name);
  return [
    `${Many} sit under each other, up to ${LIMITS.treeDepth} levels deep; one with ${many} under it can't be deleted.`,
    ...(totals.length ? [`${list(totals)} include${totals.length === 1 ? "s" : ""} the ${many} under it.`] : []),
  ];
}

// A ledger (M29): "Leave entries are only added: one can't be changed or deleted, only reversed, once. Moves for one
// Item can't add up to less than 0." And on a sheet that reads one: "Left counts the leave entries for its Who."
function ledgerText(file: CapabilityFile, s: Sheet): string[] {
  const out: string[] = [];
  const l = ledgerOf(s);
  if (l) {
    const { many } = rowWords(s);
    out.push(`${s.name} are only added: one can't be changed or deleted, only reversed, once.`);
    const account = s.columns.find((c) => c.id === l.account)?.name ?? "account";
    if (l.min !== undefined) out.push(`${many.charAt(0).toUpperCase() + many.slice(1)} for one ${account} can't add up to less than ${l.min}.`);
  }
  for (const c of s.columns) {
    if (c.type !== "computed" || !c.expr) continue;
    for (const n of walk(c.expr)) {
      if (!isBalanceOf(n)) continue;
      const ledger = file.sheets.find((x) => x.id === n.balanceOf.sheet);
      const of = n.balanceOf.of ? s.columns.find((x) => x.id === n.balanceOf.of)?.name : undefined;
      out.push(`${c.name} counts the ${(ledger?.name ?? "entries").toLowerCase()}${of ? ` for its ${of}` : " for it"}.`);
    }
  }
  return [...new Set(out)];
}

// A dated sheet (M30): "Spending limits are kept by date: each category's limit starts on its From date and lasts until
// the next one. A limit already in force can't be changed or deleted; add a new one from the date it changes."
function datedText(s: Sheet): string[] {
  const d = datedOf(s);
  if (!d) return [];
  const { one } = rowWords(s);
  const key = s.columns.find((c) => c.id === d.key)?.name.toLowerCase();
  const from = s.columns.find((c) => c.id === d.from)?.name ?? "From";
  return [
    `${s.name} are kept by date: ${key ? `each ${key}'s ${one}` : `each ${one}`} starts on its ${from} date and lasts until the next one. A ${one} already in force can't be changed or deleted; add a new one from the date it changes.`,
  ];
}

// A sheet's checks (8f): "An expense is added only when Amount is at most … (Within the limit)."
function checksText(s: Sheet, ctx: TextCtx): string[] {
  const { one } = rowWords(s);
  const article = /^[aeiou]/i.test(one) ? "An" : "A";
  return (s.checks ?? []).map((c) => `${article} ${one} is added only when ${renderExpr(c.condition, renderCtx(ctx, s))} (${c.name}).`);
}

// "The form: Basics (Customer, Value a year, Owner), Dates (Start, Renews on and Notice). Asked when creating:
// Customer and Value a year." Only for a sheet with its own form.
function formText(file: CapabilityFile, s: Sheet, ctx: TextCtx): string[] {
  if (!s.form || ctx.withoutForm) return [];
  const name = (id: string) => s.columns.find((c) => c.id === id)?.name ?? id;
  const tabs = tabsOf(s).map((t) => `${t.name} (${list(t.sections.flatMap((x) => x.columns).map(name))})`);
  const quick = quickOf(file, ctx.capId, s, new Map(ctx.files).set(ctx.capId, file)).map(name);
  return [`The form: ${tabs.join(", ")}. Asked when creating: ${list(quick)}.`];
}

// "Legal review, for contracts over $50,000".
export function stepText(st: Step, sheet: Sheet, ctx: TextCtx): string {
  if (!st.onlyWhen) return st.name;
  const e = st.onlyWhen;
  const words = { gt: "over", gte: "at least", lt: "under", lte: "at most" } as Record<string, string>;
  if (isOp(e) && words[e.op] && typeof e.args[1] === "number") {
    const col = renderCtx(ctx, sheet).column((e.args[0] as { col: string }).col);
    const v = col?.type === "money" ? formatMoney(e.args[1], ctx.formats) : String(e.args[1]);
    return `${st.name}, for ${rowWords(sheet).many} ${words[e.op]} ${v}`;
  }
  return `${st.name}, when ${renderExpr(e, renderCtx(ctx, sheet))}`;
}

const MOVERS: Record<string, Record<string, string>> = {
  moveIn: { submitter: "only the person who asked moves it here", not_submitter: "not by the person who asked" },
  moveOut: { submitter: "only the person who asked moves it on", not_submitter: "someone other than the person who asked moves it on" },
};

// The flow on one line ("Draft → Signed → Active → Renewal due → Renewed or Ended"), then each step setting
// that isn't "anyone". Under its sheet when a capability has more than one flow ("Steps: Draft → Open →
// Filled or Closed.", 6g).
function stepsText(sheet: Sheet, ctx: TextCtx, underSheet = false): string[] {
  const steps = sheet.steps ?? [];
  if (!steps.length) return [];
  const flow = steps.filter((s) => !s.end).map((s) => stepText(s, sheet, ctx));
  const ends = steps.filter((s) => s.end).map((s) => s.name);
  const arrows = [...flow, ...(ends.length ? [orList(ends)] : [])].join(" → ");
  const line = underSheet ? `Steps: ${arrows}.` : arrows;
  const settings = steps.flatMap((s) => (["moveIn", "moveOut"] as const).filter((k) => s[k] && s[k] !== "anyone").map((k) => `${s.name}: ${MOVERS[k]![s[k]!]}`));
  return [line, ...settings];
}

// A role Customize added beside another for one sheet (C1, "Lead owners on Companies"): the same people seeing that
// sheet another way. It reads inside the other role's sentence, not as a group of its own.
export function besideOf(r: Role, file: CapabilityFile): Role | undefined {
  return r.beside ? file.roles.find((b) => b !== r && b.id === r.beside!.role) : undefined;
}

// "every contract", "their own leads and companies", "their team's candidates". A role that sees its own or its team's
// rows names every sheet it sees through a person on the row (small thing 2, Nov 5); sheets it sees only through a
// link (a contract's renewals) stay out, so "Contract owners see their own contracts" reads as on the screens.
// A sheet seen one link away (E1, G3) names the row it links to: "the bills of their own purchases".
const seesIn = (r: Role, sheet: Sheet, ctx: TextCtx, file?: CapabilityFile) => {
  const words = rowWords(sheet);
  if (r.scope === "all") return `every ${words.one}`;
  const whose = r.scope === "own" ? "their own" : "their team’s";
  const via = r.scopeColumns?.[sheet.id]?.via;
  if (via) return `the ${words.many} of ${whose} ${linkedMany(sheet, via, ctx)}`;
  const more = (file?.sheets ?? []).filter((s) => s.id !== sheet.id && (!r.sheets || r.sheets.includes(s.id)) && r.scopeColumns?.[s.id] && !r.scopeColumns[s.id]!.via);
  return `${whose} ${list([words.many, ...more.map((s) => rowWords(s).many)])}`;
};
// The rows a link column points at, in their own words ("purchases"), here or in another capability.
const linkedMany = (sheet: Sheet, via: string, ctx: TextCtx) => {
  const column = sheet.columns.find((c) => c.id === via);
  const target = ctx.files.get(column?.link?.capability ?? ctx.capId)?.sheets.find((s) => s.id === column?.link?.sheet);
  return target ? (target.row?.many ?? target.name.toLowerCase()) : (column?.name.toLowerCase() ?? "rows");
};
const verbsOf = (r: Role) => (["add", "edit", "move_steps"] as const).filter((p) => r.can.includes(p)).map((p) => (p === "move_steps" ? "move" : p));

// "You and Krishna see every contract, add, edit and move them, and change how it works."
// With a role beside it: "Lead owners see their own leads and every company and can add, edit and move them."
export function roleText(r: Role, file: CapabilityFile, ctx: TextCtx): string {
  const main = file.sheets.find((s) => !r.sheets || r.sheets.includes(s.id)) ?? file.sheets[0]!;
  let who: string;
  let plural = true;
  if (r.members.kind === "everyone") [who, plural] = ["Everyone", false];
  else if (r.members.kind === "column") who = r.name;
  else {
    const ids = r.members.people;
    const me = ctx.viewerId && ids.includes(ctx.viewerId) ? ["You"] : [];
    const names = [...me, ...ids.filter((id) => id !== ctx.viewerId).map((id) => ctx.personName(id) ?? "someone")];
    who = list(names);
    plural = names.length > 1 || names[0] === "You" || (ids.length === 1 && !!ctx.group?.(ids[0]!));
  }
  const verbs = verbsOf(r);
  // Switched off (covering nothing), a role beside this one says nothing.
  const beside = file.roles.filter((b) => besideOf(b, file) === r && b.sheets?.length).map((b) => ({ role: b, sheet: file.sheets.find((s) => s.id === b.sheets![0])! }));
  // Beside roles that allow the same actions join the list of what they see; the others get a sentence of their own.
  const same = beside.filter((b) => list(verbsOf(b.role)) === list(verbs));
  const other = beside.filter((b) => !same.includes(b));
  const sees = list([seesIn(r, main, ctx, file), ...same.map((b) => seesIn(b.role, b.sheet, ctx))]);
  const doing = !verbs.length ? "" : r.scope === "all" ? `, ${list(verbs)} them` : ` and can ${list(verbs)} them`;
  const customize = r.can.includes("customize") ? ", and change how it works" : "";
  const also = other.map((b) => {
    const v = verbsOf(b.role);
    return ` ${plural ? "They" : who} also ${plural ? "see" : "sees"} ${seesIn(b.role, b.sheet, ctx)}${v.length ? ` and can ${list(v)} them` : ""}.`;
  });
  return `${who} ${plural ? "see" : "sees"} ${sees}${doing}${customize}.${also.join("")}`;
}

// What comes in from People and other capabilities, and what goes out to them.
function connectionsText(file: CapabilityFile, ctx: TextCtx): string[] {
  const out: string[] = [];
  for (const s of file.sheets)
    for (const c of s.columns) {
      if (c.type === "person") out.push(`People fills ${c.name}.`);
      if (c.type === "link" && c.link?.capability && c.link.capability !== ctx.capId) out.push(`${ctx.files.get(c.link.capability)?.name ?? "Another app"} fills ${c.name}.`);
    }
  for (const rule of file.rules) {
    const sheet = file.sheets.find((s) => s.id === rule.trigger.sheet);
    if (!sheet) continue;
    const at = rule.trigger.kind === "enters_step" ? `At ${sheet.steps?.find((s) => s.id === rule.trigger.step)?.name}` : `When a ${rowWords(sheet).one} is added`;
    for (const a of rule.actions) {
      if (a.kind !== "create_row_in" && a.kind !== "update_row_in") continue;
      const cap = ctx.files.get(a.target.capability ?? ctx.capId);
      if (!cap || !a.target.capability || a.target.capability === ctx.capId) continue;
      const target = cap.sheets.find((s) => s.id === a.target.sheet);
      if (a.kind === "create_row_in") out.push(`${at}, start a ${target ? rowWords(target).one : "row"} in ${cap.name}.`);
      else {
        const via = sheet.columns.find((c) => c.id === a.via)?.name.toLowerCase() ?? "linked row";
        const stepCol = target?.columns.find((c) => c.type === "step");
        const to = stepCol && typeof a.map[stepCol.id] === "string" ? target?.steps?.find((s) => s.id === a.map[stepCol.id]) : undefined;
        out.push(to ? `${at}, ${cap.name} moves the ${via} to ${to.name}.` : `${at}, ${cap.name} updates the ${via}.`);
      }
    }
  }
  // Totals elsewhere that add up this capability's rows ("At Paid, Tools and budgets adds the amount to Spent").
  for (const [id, other] of ctx.files) {
    if (id === ctx.capId) continue;
    for (const s of other.sheets)
      for (const c of s.columns) {
        const sum = c.expr && typeof c.expr === "object" && c.expr !== null && "sumOf" in c.expr ? c.expr.sumOf : undefined;
        if (!sum || sum.capability !== ctx.capId) continue;
        const from = file.sheets.find((x) => x.id === sum.sheet);
        const col = from?.columns.find((x) => x.id === sum.column)?.name.toLowerCase() ?? "amount";
        const steps = (sum.steps ?? []).map((st) => from?.steps?.find((x) => x.id === st)?.name ?? st);
        out.push(`${steps.length ? `At ${orList(steps)}, ` : ""}${other.name} adds the ${col} to ${c.name}.`);
      }
  }
  return out;
}

export function renderCapabilityText(file: CapabilityFile, ctx: TextCtx, extras: PlanExtras = {}): TextSection[] {
  const flows = file.sheets.filter((s) => s.steps?.length).length;
  const sections: TextSection[] = file.sheets.map((s) => ({
    heading: `${s.name} sheet`,
    lines: [`${s.columns.filter((c) => c.type !== "computed" && c.type !== "step").map((c) => columnText(c, s, ctx)).join(", ")}.`, ...treeText(s), ...ledgerText(file, s), ...datedText(s), ...checksText(s, ctx), ...formText(file, s, ctx), ...(flows > 1 ? stepsText(s, ctx, true) : [])],
  }));
  const steps = flows > 1 ? [] : file.sheets.flatMap((s) => stepsText(s, ctx));
  if (steps.length) sections.push({ heading: "Steps", lines: steps });
  // Two rules written from one sentence (ask Lena, then move on when she approves) read as that sentence once.
  if (file.rules.length) sections.push({ heading: "What happens by itself", lines: [...new Set(file.rules.map((r) => r.text))] });
  const company = (ctx.company ?? []).filter((r) => r.applications.some((a) => a.capabilityId === ctx.capId)).map((r) => r.text);
  if (company.length) sections.push({ heading: "Company rules that apply here", lines: [...company, "Changed in Ontology › Company rules."] });
  sections.push({
    heading: "Who can see and do what",
    lines: [...file.roles.filter((r) => !besideOf(r, file)).map((r) => roleText(r, file, ctx)), ...(file.roles.some((r) => r.members.kind === "everyone") ? [] : ["Everyone else sees nothing."])],
  });
  if (extras.alsoChanges?.length) sections.push({ heading: "Also changes", lines: extras.alsoChanges });
  const connections = [...connectionsText(file, ctx), ...(extras.suggested ?? [])];
  if (connections.length) sections.push({ heading: extras.suggested?.length ? "Connections (suggested)" : "Connections", lines: connections });
  if (file.later.length) sections.push({ heading: "Later", lines: file.later, muted: true });
  sections.push({ heading: "Coming soon", lines: ["Connections to other software"], muted: true });
  return sections;
}

// What a plan adds to a capability that exists, from its file before and after: "Spend › Purchases: a new
// Billed step after Received." Worked out from the files, not from the AI's words.
export function addedLines(before: CapabilityFile, after: CapabilityFile, personName: (id: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const s of after.sheets) {
    const was = before.sheets.find((x) => x.id === s.id);
    const where = `${after.name} › ${s.name}`;
    if (!was) {
      out.push(`${after.name}: a new ${s.name} sheet.`);
      continue;
    }
    for (const c of s.columns) if (!was.columns.some((x) => x.id === c.id)) out.push(`${where}: a new ${c.name} column.`);
    (s.steps ?? []).forEach((st, i) => {
      if (was.steps?.some((x) => x.id === st.id)) return;
      const prev = s.steps![i - 1];
      out.push(`${where}: a new ${st.name} step${prev ? ` after ${prev.name}` : ""}.`);
    });
  }
  for (const r of after.roles) {
    const was = before.roles.find((x) => x.id === r.id);
    if (r.members.kind !== "people" || was?.members.kind !== "people") continue;
    const old = was.members.people;
    for (const id of r.members.people.filter((p) => !old.includes(p))) out.push(`${after.name}: ${personName(id) ?? "someone"} added to ${r.name}.`);
  }
  for (const r of after.rules) if (!before.rules.some((x) => x.id === r.id)) out.push(`${after.name}: a new rule, “${r.text.replace(/\.$/, "")}”.`);
  return out;
}

// The line on the right of "How {capability} works": "Version 4 · Oct 21 by Wade", "Version 5 · just now by
// Wade", or while a change is shown or applied, "Preview of version 5" / "Updating to version 5".
export function versionLine(v: { version: number; at: Date; by: string | null }, now: Date, timeZone: string, state: "saved" | "preview" | "updating" = "saved", fmt?: Formats): string {
  if (state === "preview") return `Preview of version ${v.version}`;
  if (state === "updating") return `Updating to version ${v.version}`;
  const sameYear = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(v.at) === new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now);
  const when =
    now.getTime() - v.at.getTime() < 60_000
      ? "just now"
      : sameYear
        ? formatDay(dayIn(v.at, timeZone), fmt)
        : formatDate(dayIn(v.at, timeZone), fmt);
  return `Version ${v.version} · ${when}${v.by ? ` by ${v.by}` : ""}`;
}
