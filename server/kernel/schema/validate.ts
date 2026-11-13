import { checkExpr, kindOfColumn, type Kind, type Scope } from "../expr/check";
import { columnsUsed, isCol, isOp, isRef, readsOtherRows, walk, type BalanceOf, type Expr, type InForce, type Lookup, type SumOf } from "../expr/ast";
import { capabilityFileSchema, datedOf, keptByKernel, type CapabilityFile, type Column, type Sheet } from "./file";

// Every check the kernel makes on a capability file before a version is saved. Messages are plain words,
// so a plan can show them as they are.

const isRow = (e: Expr) => isRef(e) && e.ref === "row";

// treeDepth: how many levels a tree goes down, the rows at the top being the first (M28).
export const LIMITS = { sheets: 6, columns: 40, steps: 6, rules: 20, treeDepth: 8 } as const;

export type FileCtx = {
  // This capability's id, once it has one; links from other capabilities name it.
  selfId?: string;
  // The other capabilities' current files, by id, for links, connections and sums across capabilities.
  others?: ReadonlyMap<string, CapabilityFile>;
  // Ids of everyone in People; role members and people in rules must be among them.
  people?: ReadonlySet<string>;
};

export type FileCheck = { ok: true; file: CapabilityFile } | { ok: false; errors: string[] };

const NUMERIC = new Set(["number", "money", "percent", "days"]);
const isNumeric = (c: Column | undefined) => !!c && (NUMERIC.has(c.type) || (c.type === "computed" && c.result !== "date" && c.result !== "text"));

export function validateFile(raw: unknown, ctx: FileCtx = {}): FileCheck {
  const parsed = capabilityFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(" › ") || "The file"}: ${i.message}`) };
  }
  const file = parsed.data;
  const errors: string[] = [];
  const err = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

  const sheetIn = (capability: string | undefined, sheet: string): Sheet | undefined =>
    (capability && capability !== ctx.selfId ? ctx.others?.get(capability) : file)?.sheets.find((s) => s.id === sheet);
  const colIn = (sheet: Sheet | undefined, id: string) => sheet?.columns.find((c) => c.id === id);

  // Expressions on a sheet see that sheet's columns, and sums over rows that point at it.
  function scopeFor(sheet: Sheet): Scope {
    return {
      column: (id) => {
        const c = colIn(sheet, id);
        return c ? kindOfColumn(c.type, c.result) : null;
      },
      sumOf: (s: SumOf) => {
        const other = sheetIn(s.capability, s.sheet);
        if (!other) return `There is no sheet “${s.sheet}” to add up.`;
        if (!isNumeric(colIn(other, s.column))) return `“${s.column}” in ${other.name} isn't a number to add up.`;
        const missing = s.steps?.find((id) => !other.steps?.some((st) => st.id === id));
        if (missing) return `${other.name} has no step “${missing}” to add up at.`;
        if (s.by === undefined) {
          return other.kind === "lines" && other.parentSheet === sheet.id && (!s.capability || s.capability === ctx.selfId)
            ? null
            : `${other.name} aren't lines of ${sheet.name}.`;
        }
        const by = colIn(other, s.by);
        // A sheet adds up its own rows only as a tree, through the row each sits under: a total that includes the
        // rows under it (M28).
        if (other === sheet && (!s.capability || s.capability === ctx.selfId) && !(sheet.kind === "tree" && sheet.tree?.parent === s.by))
          return `${sheet.name} adds up its own rows only when they sit under each other, through the row each one sits under.`;
        const across = !!s.capability && s.capability !== ctx.selfId;
        const pointsHere = by?.type === "link" && by.link?.sheet === sheet.id && (across ? by.link.capability === ctx.selfId : !by.link.capability);
        return by && pointsHere ? null : `${other.name} has no link to ${sheet.name} called “${s.by}”.`;
      },
      linked: (via, col) => {
        const link = colIn(sheet, via);
        if (link?.type !== "link" || !link.link) return `“${via}” isn't a link column on ${sheet.name}.`;
        const target = sheetIn(link.link.capability, link.link.sheet);
        const c = colIn(target, col);
        if (!c) return `The row “${link.name}” points to has no column “${col}”.`;
        return kindOfColumn(c.type, c.result);
      },
      lookup: (l: Lookup) => {
        const other = file.sheets.find((x) => x.id === l.sheet);
        if (!other) return `There is no sheet “${l.sheet}” to look in.`;
        const [where, is, value] = [colIn(other, l.where), colIn(sheet, l.is), colIn(other, l.value)];
        if (!where || !is || where.type !== is.type) return `${other.name} can't be matched to ${sheet.name} by “${l.where}”.`;
        if (!value) return `${other.name} has no column “${l.value}”.`;
        return kindOfColumn(value.type, value.result);
      },
      // A ledger's balance, read on the row it is the balance of (M29): a link to this sheet's row, or a column of
      // this row matched to its account (Balances: Who).
      balanceOf: (b: BalanceOf) => {
        const ledger = file.sheets.find((x) => x.id === b.sheet);
        if (ledger?.kind !== "ledger" || !ledger.ledger) return `There is no ledger “${b.sheet}” to read a balance from.`;
        if (ledger === sheet) return `${sheet.name} keeps its balance after each entry itself.`;
        const account = colIn(ledger, ledger.ledger.account);
        if (b.of === undefined)
          return account?.type === "link" && account.link?.sheet === sheet.id && !account.link.capability ? null : `${ledger.name} isn't kept for ${sheet.name}'s rows.`;
        const of = colIn(sheet, b.of);
        if (!of || !account || of.type !== account.type || (of.type === "link" && of.link?.sheet !== account.link?.sheet))
          return `${ledger.name} can't be matched to ${sheet.name} by “${b.of}”.`;
        return null;
      },
      // The row of a dated sheet in force on a date (M30): matched by this row's `is` to the sheet's key, on this
      // row's date column `on`, or today.
      inForce: (f: InForce) => {
        const other = file.sheets.find((x) => x.id === f.sheet);
        const d = other && datedOf(other);
        if (!other || !d) return `There is no dated sheet “${f.sheet}” to read from.`;
        if (other === sheet) return `${sheet.name} can't read its own rows in force.`;
        const key = d.key ? colIn(other, d.key) : undefined;
        if (key) {
          const is = f.is ? colIn(sheet, f.is) : undefined;
          const sameOptions = key.type !== "choice" || (is?.options ?? []).every((o) => key.options?.some((k) => k.id === o.id));
          const sameLink = key.type !== "link" || (is?.link?.sheet === key.link?.sheet && (is?.link?.capability ?? "") === (key.link?.capability ?? ""));
          if (!is || is.type !== key.type || !sameOptions || !sameLink) return `${other.name} can't be matched to ${sheet.name} by “${f.is ?? ""}”.`;
        } else if (f.is) return `${other.name} keeps one series, so it isn't matched by “${f.is}”.`;
        if (f.on && colIn(sheet, f.on)?.type !== "date") return `“${f.on}” isn't a date on ${sheet.name} to read ${other.name} on.`;
        const value = colIn(other, f.value);
        if (!value) return `${other.name} has no column “${f.value}”.`;
        return kindOfColumn(value.type, value.result);
      },
    };
  }

  function checkOn(sheet: Sheet, where: string, e: Expr, want?: Kind) {
    const { kind, errors: errs } = checkExpr(e, scopeFor(sheet));
    if ([...walk(e)].some(isRow)) errs.push("names the row itself, which only a rule's field map can.");
    for (const m of errs) err(where, m);
    if (want && errs.length === 0 && kind !== want && kind !== "any" && kind !== "null") {
      err(where, want === "bool" ? "needs a yes/no condition." : `gives the wrong kind of value.`);
    }
  }

  // M32: a repeating rule has no row. It adds rows to its own sheet on a schedule, each value given outright (a value,
  // a person, today or a date counted from it), and fills every question a row can't be added without, since nobody
  // is there to answer it.
  function checkRepeat(rule: CapabilityFile["rules"][number], sheet: Sheet, where: string) {
    const t = rule.trigger;
    const e = t.every;
    if (!e) return err(where, "repeats, but doesn't say how often.");
    if (t.step || t.field || t.date || t.from || t.offsetDays !== undefined) err(where, "repeats on a schedule, so it doesn't start at a step, a column or a date.");
    if (e.unit === "week" && (!e.weekday || e.day || e.month)) err(where, "repeats every week, so it needs a weekday and nothing else.");
    if (e.unit === "month" && (!e.day || e.weekday || e.month)) err(where, "repeats every month, so it needs a day of the month and nothing else.");
    if (e.unit === "year" && (!e.month || !e.day || e.weekday)) err(where, "repeats every year, so it needs a month and a day.");
    if (e.unit === "year" && e.month && e.day && e.day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][e.month - 1]!) err(where, "repeats on a day that month doesn't have.");
    if (t.starts && t.ends && t.ends < t.starts) err(where, "ends before it starts.");
    if (rule.condition !== undefined) err(where, "has a condition, but a repeating rule has no row to check it on.");
    if (sheet.kind === "lines") err(where, `adds lines to ${sheet.name}, but lines belong to a document; add the document instead.`);
    for (const a of rule.actions) {
      if (a.kind !== "create_row_in" || (a.target.capability && a.target.capability !== ctx.selfId) || a.target.sheet !== sheet.id) {
        err(where, `repeats, so all it can do is add rows to ${sheet.name}.`);
        continue;
      }
      for (const [col, v] of Object.entries(a.map)) {
        const c = colIn(sheet, col);
        if (!c || c.type === "computed") {
          err(where, `fills “${col}”, which isn't a column it can fill in ${sheet.name}.`);
          continue;
        }
        if (keptByKernel(sheet, col)) err(where, `fills ${c.name}, which Bike keeps itself in ${sheet.name}.`);
        else if ([...walk(v)].some((n) => !(n === null || typeof n !== "object" || isOp(n) || (isRef(n) && n.ref === "today"))))
          err(where, `fills ${c.name} from a row, but a repeating rule has no row; give the value itself.`);
        else if (c.type === "link" || c.type === "file" || c.type === "step") err(where, `fills ${c.name}, which a repeating rule can't fill; leave it for a person.`);
        else if (c.type === "person" && !(typeof v === "string" && (!ctx.people || ctx.people.has(v)))) err(where, `fills ${c.name} with someone who isn't in People.`);
        else if (c.type === "choice" && !(typeof v === "string" && c.options?.some((o) => o.id === v))) err(where, `fills ${c.name} with a choice it doesn't have.`);
        else if (c.type !== "person" && c.type !== "choice") {
          const kind = checkExpr(v, scopeFor(sheet)).kind;
          const want = kindOfColumn(c.type);
          const ok = kind === want || kind === "null" || (want === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
          if (!ok) err(where, `fills ${c.name} with the wrong kind of value.`);
        }
      }
      // Every question a row needs, and whoever-adds-it (nobody adds it), is filled by the rule.
      for (const c of sheet.columns) {
        if (c.type === "computed" || c.type === "step" || keptByKernel(sheet, c.id) || c.id in a.map) continue;
        if (c.default?.kind === "creator") err(where, `leaves ${c.name} empty; a repeating rule adds rows for nobody, so say who.`);
        else if (c.required && !c.default) err(where, `leaves ${c.name} empty, and ${sheet.name} needs it.`);
      }
    }
  }

  const unique = (where: string, ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) err(where, `two ${what} have the id “${id}”.`);
      seen.add(id);
    }
  };

  if (file.sheets.length > LIMITS.sheets) err(file.name, `at most ${LIMITS.sheets} sheets; put the rest under Later.`);
  if (file.rules.length > LIMITS.rules) err(file.name, `at most ${LIMITS.rules} rules; put the rest under Later.`);
  unique(file.name, file.sheets.map((s) => s.id), "sheets");
  unique(file.name, file.roles.map((r) => r.id), "roles");
  unique(file.name, file.rules.map((r) => r.id), "rules");

  for (const sheet of file.sheets) {
    const where = `${sheet.name} sheet`;
    if (sheet.columns.length > LIMITS.columns) err(where, `at most ${LIMITS.columns} columns.`);
    unique(where, sheet.columns.map((c) => c.id), "columns");
    if (!colIn(sheet, sheet.titleColumn)) err(where, `the title column “${sheet.titleColumn}” isn't one of its columns.`);

    // Kinds.
    if (sheet.kind === "lines") {
      const parent = file.sheets.find((s) => s.id === sheet.parentSheet);
      if (!parent || parent.kind !== "document") err(where, "lines need a document sheet in this app to belong to.");
    } else if (sheet.parentSheet) err(where, "only lines belong to another sheet.");
    if (sheet.kind === "allocation") {
      const a = sheet.allocation;
      if (!a) err(where, "an allocation names what it allocates from and to, and the amount.");
      else {
        const from = colIn(sheet, a.from);
        const to = colIn(sheet, a.to);
        if (from?.type !== "link" || to?.type !== "link") err(where, "allocates from one linked row to another; both must be link columns.");
        if (!isNumeric(colIn(sheet, a.amount)) || colIn(sheet, a.amount)?.type === "computed") err(where, "the allocated amount must be a number or money column.");
        if (from?.link && !isNumeric(colIn(sheetIn(from.link.capability, from.link.sheet), a.fromLimit)))
          err(where, `“${a.fromLimit}” isn't an amount on the row it allocates from.`);
        if (a.toLimit && to?.link && !isNumeric(colIn(sheetIn(to.link.capability, to.link.sheet), a.toLimit)))
          err(where, `“${a.toLimit}” isn't an amount on the row it allocates to.`);
      }
    } else if (sheet.allocation) err(where, "only an allocation sheet allocates.");
    if (sheet.kind === "tree") {
      const parent = sheet.tree && colIn(sheet, sheet.tree.parent);
      if (!sheet.tree) err(where, "a tree names the column that says which row each row sits under.");
      else if (parent?.type !== "link" || parent.link?.sheet !== sheet.id || (parent.link.capability && parent.link.capability !== ctx.selfId))
        err(where, `“${sheet.tree.parent}” must be a link to ${sheet.name} itself, naming the row each one sits under.`);
      else if (parent.required || parent.default || parent.id === sheet.titleColumn)
        err(where, "the rows at the top sit under nothing, so the column naming the row above isn't required, has no default and isn't the title.");
    } else if (sheet.tree) err(where, "only a tree sheet has rows that sit under each other.");
    if (sheet.kind === "ledger") {
      const l = sheet.ledger;
      if (!l) err(where, "a ledger names whose balance each entry counts toward, and the amount.");
      else {
        const [account, amount, balance, reverses] = [colIn(sheet, l.account), colIn(sheet, l.amount), colIn(sheet, l.balance), colIn(sheet, l.reverses)];
        if (!account || (account.type !== "person" && account.type !== "link") || !account.required)
          err(where, `“${l.account}” must be a required person or link column: whose balance each entry counts toward.`);
        else if (account.type === "link" && (account.link?.sheet === sheet.id || (account.link?.capability && account.link.capability !== ctx.selfId)))
          err(where, "an entry counts toward a row of another sheet in this app, not toward another entry.");
        if (!amount || !["number", "money", "days"].includes(amount.type) || !amount.required) err(where, `“${l.amount}” must be a required number, money or days column: the entry's amount.`);
        if (!balance || balance.type !== amount?.type || balance.required || balance.default || balance.showWhen)
          err(where, `“${l.balance}” is the balance after each entry, which the kernel keeps: the same kind of number as the amount, not required, with no default.`);
        if (reverses?.type !== "link" || reverses.link?.sheet !== sheet.id || (reverses.link.capability && reverses.link.capability !== ctx.selfId) || reverses.required || reverses.default)
          err(where, `“${l.reverses}” must be a link to ${sheet.name} itself, not required, with no default: the entry a reversal reverses.`);
        const kept = [l.account, l.amount, l.balance, l.reverses];
        if (new Set(kept).size !== kept.length) err(where, "a ledger's account, amount, balance and reversal are four different columns.");
        if ([l.balance, l.reverses, l.amount].includes(sheet.titleColumn)) err(where, "an entry's title can't be its amount, its balance or the entry it reverses.");
        if (sheet.columns.some((c) => c.type === "step")) err(where, "entries are only added, so a ledger has no steps.");
        if (sheet.checks?.length) err(where, "a ledger keeps its balance with its lowest value, not with checks.");
        // An entry never changes once added, so nothing on it is worked out again from other rows.
        if (sheet.columns.some((c) => c.type === "computed" && c.expr && [...walk(c.expr)].some((n) => typeof n === "object" && n !== null && ("sumOf" in n || "balanceOf" in n))))
          err(where, "an entry doesn't change once added, so its columns can't add up other rows.");
        for (const id of [l.balance, l.reverses]) if (sheet.form?.tabs.some((t) => t.sections.some((x) => x.columns.includes(id))) || sheet.form?.quick?.includes(id))
          err(where, "its form asks for a column the kernel fills in.");
      }
    } else if (sheet.ledger) err(where, "only a ledger sheet keeps a balance.");
    if (sheet.kind === "dated") {
      const d = sheet.dated;
      if (!d) err(where, "a dated sheet names the date each row starts, and what each row is for.");
      else {
        const [key, from, until] = [d.key ? colIn(sheet, d.key) : undefined, colIn(sheet, d.from), colIn(sheet, d.until)];
        if (d.key && (!key || !["choice", "link", "person", "text"].includes(key.type) || !key.required))
          err(where, `“${d.key}” must be a required choice, link, person or text column: what each row's value is for.`);
        else if (key?.type === "link" && key.link?.sheet === sheet.id) err(where, "a row's value is for a row of another sheet, not for another row of the same sheet.");
        if (from?.type !== "date" || !from.required) err(where, `“${d.from}” must be a required date column: the day each row starts.`);
        if (until?.type !== "date" || until.required || until.default || until.showWhen)
          err(where, `“${d.until}” is the day before the next one starts, which the kernel keeps: a date, not required, with no default.`);
        const own = [d.key, d.from, d.until].filter(Boolean);
        if (new Set(own).size !== own.length) err(where, "a dated sheet's key, start and end are different columns.");
        if (sheet.titleColumn === d.until) err(where, "a row's title can't be the day it ends, which the kernel fills.");
        if (sheet.columns.some((c) => c.type === "step")) err(where, "a dated sheet keeps values by date, so it has no steps.");
        if (sheet.form?.tabs.some((t) => t.sections.some((x) => x.columns.includes(d.until))) || sheet.form?.quick?.includes(d.until))
          err(where, "its form asks for a column the kernel fills in.");
      }
    } else if (sheet.dated) err(where, "only a dated sheet keeps values by the date each starts.");

    // Columns.
    for (const c of sheet.columns) {
      const at = `${where} › ${c.name}`;
      if (c.type === "choice") {
        if (!c.options?.length) err(at, "a choice needs its options.");
        else unique(at, c.options.map((o) => o.id), "options");
      } else if (c.options) err(at, "only a choice has options.");
      if (c.min !== undefined || c.max !== undefined) {
        if (c.type !== "number") err(at, "only a number has a lowest and highest value.");
        else if (c.min !== undefined && c.max !== undefined && c.min > c.max) err(at, "the lowest value is above the highest.");
      }
      if (c.type === "link") {
        if (!c.link) err(at, "a link names the sheet it points to.");
        else if (!sheetIn(c.link.capability, c.link.sheet)) err(at, "points to a sheet that doesn't exist.");
        if (c.link?.pick && (c.id === sheet.tree?.parent || c.id === sheet.ledger?.reverses))
          err(at, "names a row of this same sheet, so it isn't a pick from a list.");
      } else if (c.link) err(at, "only a link points to a sheet.");
      if (c.type === "computed") {
        if (!c.expr || !c.result) err(at, "a computed column needs its formula and what it gives.");
        else checkOn(sheet, at, c.expr);
        if (c.required || c.default) err(at, "a computed column is worked out, so it has no default and isn't required.");
      } else if (c.expr || c.result) err(at, "only a computed column has a formula.");
      if (c.replacedBy) {
        const by = colIn(sheet, c.replacedBy);
        if (c.type !== "text") err(at, "only typed text is kept when a link takes its place.");
        if (by?.type !== "link") err(at, "is kept for a link column that doesn't exist.");
        if (c.required || c.default || c.id === sheet.titleColumn) err(at, "is kept from before, read only, so it isn't required, has no default and isn't the title.");
      }
      if (c.hintFor) {
        if (c.type !== "computed") err(at, "only a computed column is shown beside another one.");
        const target = colIn(sheet, c.hintFor);
        if (!target || target.id === c.id || target.hintFor) err(at, "is shown beside a column that doesn't exist.");
      }
      if (c.default) {
        const d = c.default;
        if (d.kind === "creator" && c.type !== "person") err(at, "only a person column can default to whoever adds it.");
        if (d.kind === "today" && c.type !== "date" && c.type !== "datetime") err(at, "only a date can default to today.");
        if (d.kind === "expr") checkOn(sheet, at, d.expr, kindOfColumn(c.type));
      }
    }
    for (const by of [sheet.sort, sheet.sort?.then])
      if (by && (!colIn(sheet, by.column) || colIn(sheet, by.column)?.hintFor)) err(where, `is sorted by a column “${by.column}” it doesn't show.`);
    if (colIn(sheet, sheet.titleColumn)?.hintFor) err(where, "its title column can't be a hint.");

    // Computed columns can't go round in a circle.
    const computed = new Map(sheet.columns.filter((c) => c.type === "computed" && c.expr).map((c) => [c.id, columnsUsed(c.expr!)]));
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycle = (id: string): boolean => {
      if (done.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const hit = (computed.get(id) ?? []).some((d) => computed.has(d) && cycle(d));
      visiting.delete(id);
      done.add(id);
      return hit;
    };
    for (const id of computed.keys()) if (cycle(id)) err(where, "its computed columns depend on each other in a circle.");

    // Steps.
    const stepCols = sheet.columns.filter((c) => c.type === "step");
    if (stepCols.length > 1) err(where, "one step column per sheet.");
    const steps = sheet.steps ?? [];
    if (stepCols.length === 1) {
      if (steps.length < 2) err(where, "a step column needs at least two steps.");
      // End steps don't count: a flow has up to 6 steps on the way, plus where rows end.
      if (steps.filter((s) => !s.end).length > LIMITS.steps) err(where, `at most ${LIMITS.steps} steps before the end.`);
      unique(where, steps.map((s) => s.id), "steps");
      if (steps.filter((s) => s.start).length !== 1) err(where, "exactly one step is where rows start.");
      if (!steps.some((s) => s.end)) err(where, "at least one step is where rows end.");
      if (steps.some((s) => s.start && s.end)) err(where, "the first step can't also be an end.");
      if (steps.some((s) => s.start && s.moveIn && s.moveIn !== "anyone")) err(where, "rows start in the first step, so nobody moves them into it.");
      if (steps.some((s) => s.end === "final" && s.moveOut && s.moveOut !== "anyone")) err(where, "rows stay in a final step, so nobody moves them out of it.");
      if (steps[0] && !steps[0].start) err(where, "the start step comes first.");
      for (const s of steps) if (s.onlyWhen) checkOn(sheet, `${where} › ${s.name}`, s.onlyWhen, "bool");
    } else if (steps.length) err(where, "has steps but no step column.");
  }

  // Roles.
  const anyStep = (id: string) => file.sheets.some((s) => s.steps?.some((st) => st.id === id));
  for (const role of file.roles) {
    const where = `Role ${role.name}`;
    const m = role.members;
    if (m.kind === "people" && ctx.people) for (const p of m.people) if (!ctx.people.has(p)) err(where, "names someone who isn't in People.");
    if (m.kind === "column" && colIn(sheetIn(undefined, m.sheet), m.column)?.type !== "person")
      err(where, "its members come from a column that isn't a person column.");
    for (const s of role.sheets ?? []) if (!sheetIn(undefined, s)) err(where, `covers a sheet “${s}” that doesn't exist.`);
    for (const s of role.moveFrom ?? []) if (!anyStep(s)) err(where, `moves rows from a step “${s}” that doesn't exist.`);
    if (role.moveFrom && !role.can.includes("move_steps")) err(where, "lists steps to move but can't move steps.");
    if (role.beside && !file.roles.some((r) => r.id === role.beside!.role && r !== role)) err(where, `is beside a role “${role.beside.role}” that doesn't exist.`);
    if (role.beside && (!sheetIn(undefined, role.beside.sheet) || (role.sheets && role.sheets.some((s) => s !== role.beside!.sheet)))) err(where, "is beside its role for a sheet it doesn't cover.");

    const covered = file.sheets.filter((s) => !role.sheets || role.sheets.includes(s.id));
    if (role.scope === "all") {
      if (role.scopeColumns) err(where, "sees all rows, so it needs no column to decide whose they are.");
      continue;
    }
    for (const sheet of covered) {
      // Lines go with their document.
      if (sheet.kind === "lines") continue;
      const sc = role.scopeColumns?.[sheet.id];
      const at = `${where} › ${sheet.name}`;
      if (!sc) {
        err(at, "needs a person column that says whose each row is.");
        continue;
      }
      if (!sc.via) {
        if (colIn(sheet, sc.column)?.type !== "person") err(at, `“${sc.column}” isn't a person column on this sheet.`);
        continue;
      }
      // One hop: a link column on this sheet, then a person column on the row it points to. Never further.
      const via = colIn(sheet, sc.via);
      if (via?.type !== "link" || !via.link) {
        err(at, `“${sc.via}” isn't a link column on this sheet.`);
        continue;
      }
      if (colIn(sheetIn(via.link.capability, via.link.sheet), sc.column)?.type !== "person")
        err(at, `“${sc.column}” isn't a person column on the row “${via.name}” points to. Whose a row is can be at most one link away.`);
    }
    for (const id of Object.keys(role.scopeColumns ?? {})) if (!covered.some((s) => s.id === id)) err(where, `decides whose rows are on a sheet it doesn't cover.`);
  }

  // The form (0.3): its tabs and the questions asked when a row is added; questions shown only when relevant.
  for (const sheet of file.sheets) {
    const where = `${sheet.name} sheet`;
    const fillable = (id: string) => {
      const c = colIn(sheet, id);
      return !!c && c.type !== "computed" && c.type !== "step";
    };
    if (sheet.form) {
      const tabs = sheet.form.tabs;
      if (tabs.length > 5) err(where, "its form has more than 5 tabs.");
      unique(where, tabs.map((t) => t.name.toLowerCase()), "tab names");
      const placed = tabs.flatMap((t) => t.sections.flatMap((x) => x.columns));
      for (const id of placed) if (!fillable(id)) err(where, `its form has a question “${id}” that can't be filled.`);
      if (new Set(placed).size !== placed.length) err(where, "its form has a question in more than one place.");
      for (const id of sheet.form.quick ?? []) if (!fillable(id)) err(where, `asks “${id}” when a row is added, but it can't be filled.`);
    }
    for (const c of sheet.columns) {
      if (!c.showWhen) continue;
      const at = `${where} › ${c.name}`;
      if (c.type === "computed" || c.type === "step" || c.id === sheet.titleColumn) err(at, "is always shown, so it can't have a condition.");
      checkOn(sheet, at, c.showWhen, "bool");
      const reads = columnsUsed(c.showWhen);
      if (readsOtherRows(c.showWhen)) err(at, "can only be shown depending on this row's own answers.");
      if (reads.includes(c.id)) err(at, "can't be shown depending on its own answer.");
      else if (reads.some((id) => colIn(sheet, id)?.showWhen)) err(at, "can't depend on a question that is itself shown only sometimes.");
    }
  }

  // Checks on new rows.
  for (const sheet of file.sheets) {
    unique(`${sheet.name} sheet`, (sheet.checks ?? []).map((c) => c.id), "checks");
    for (const c of sheet.checks ?? []) checkOn(sheet, `${sheet.name} sheet › ${c.name}`, c.condition, "bool");
  }

  // Role views: a sheet the role sees, and its columns.
  for (const role of file.roles) {
    const v = role.view;
    if (!v) continue;
    const where = `Role ${role.name} › view`;
    const sheet = sheetIn(undefined, v.sheet);
    if (!sheet || (role.sheets && !role.sheets.includes(v.sheet)) || !role.can.includes("see")) {
      err(where, "shows a sheet the role doesn't see.");
      continue;
    }
    const known = (id: string | undefined) => !id || !!colIn(sheet, id);
    for (const c of v.columns) {
      if (!known(c.column) || !known(c.hint) || !known(c.to)) err(where, `shows a column that isn't on ${sheet.name}.`);
      const isDay = (id: string | undefined) => !id || ["date", "datetime"].includes(colIn(sheet, id)?.type ?? "");
      if (c.to && (!isDay(c.column) || !isDay(c.to))) err(where, "a range runs from one date column to another.");
    }
    if (!known(v.next)) err(where, `shows a column that isn't on ${sheet.name}.`);
    for (const f of (v.form ?? []).flat()) {
      const c = colIn(sheet, f);
      if (!c || c.type === "computed" || c.type === "step") err(where, `its form has a field “${f}” that can't be filled.`);
    }
  }

  // Rules.
  for (const rule of file.rules) {
    const where = `Rule “${rule.text}”`;
    const sheet = sheetIn(undefined, rule.trigger.sheet);
    if (!sheet) {
      err(where, "starts on a sheet that doesn't exist.");
      continue;
    }
    const t = rule.trigger;
    if (t.kind === "repeats") {
      checkRepeat(rule, sheet, where);
      continue;
    }
    if (t.every || t.starts || t.ends) err(where, "has a schedule, which only a repeating rule can.");
    // 0.3: a rule for a new row that goes on only once a question is answered, when that question is asked only
    // sometimes ("Receipt, when Amount is over $75"), would leave the other rows waiting for an answer nobody is asked
    // for, unless it also reads what decides whether the question is asked.
    if (t.kind === "row_created" && rule.condition !== undefined) {
      const reads = columnsUsed(rule.condition);
      for (const n of walk(rule.condition)) {
        const inner = isOp(n) && n.op === "not" && isOp(n.args[0]!) && n.args[0].op === "empty" ? n.args[0].args[0] : undefined;
        const col = inner && isCol(inner) && !inner.via ? colIn(sheet, inner.col) : undefined;
        if (col?.showWhen && !columnsUsed(col.showWhen).some((id) => reads.includes(id)))
          err(where, `waits for ${col.name} to be filled in, but ${col.name} is asked only sometimes; say what happens to a row it isn't asked on.`);
      }
    }
    const hasStep = (id: string | undefined) => !!id && !!sheet.steps?.some((s) => s.id === id);
    if (t.kind === "enters_step" && !hasStep(t.step)) err(where, "starts at a step that doesn't exist.");
    if (t.kind === "field_changed" && !colIn(sheet, t.field ?? "")) err(where, "watches a column that doesn't exist.");
    const dateCol = colIn(sheet, t.date ?? "");
    const isDate = dateCol?.type === "date" || dateCol?.type === "datetime" || (dateCol?.type === "computed" && dateCol.result === "date");
    // A date rule counts from a date column, or from the day the row was added.
    if (t.kind === "date_reached" && (t.from === "added" ? t.date !== undefined : !isDate)) err(where, "counts from a column that isn't a date.");
    if (t.from && t.kind !== "date_reached") err(where, "counts from the day a row was added, which only a date rule can.");
    if (rule.condition) checkOn(sheet, where, rule.condition, "bool");
    const personCol = (id: string) => colIn(sheet, id)?.type === "person";
    for (const a of rule.actions) {
      switch (a.kind) {
        case "move_to_step":
          if (!hasStep(a.step)) err(where, "moves rows to a step that doesn't exist.");
          break;
        case "ask_person": {
          if (a.step !== undefined && !hasStep(a.step)) err(where, "moves rows to a step that doesn't exist.");
          if (!a.step && !a.until && !a.decision) err(where, "says how long the row waits: at a step, until a column is filled, or until they decide.");
          if (a.until && !colIn(sheet, a.until)) err(where, "waits for a column that doesn't exist.");
          if ([a.person, a.column, a.managerOf].filter(Boolean).length !== 1) err(where, "asks exactly one person, column or manager.");
          if (a.person && ctx.people && !ctx.people.has(a.person)) err(where, "asks someone who isn't in People.");
          if (a.via) {
            const link = colIn(sheet, a.via);
            const target = link?.type === "link" && link.link ? sheetIn(link.link.capability, link.link.sheet) : undefined;
            if (!target) err(where, `“${a.via}” isn't a link column on ${sheet.name}.`);
            else if (!a.column || colIn(target, a.column)?.type !== "person") err(where, "asks a column that isn't a person column on the linked row.");
          } else if ((a.column && !personCol(a.column)) || (a.managerOf && !personCol(a.managerOf))) err(where, "asks a column that isn't a person column.");
          if (a.decision) {
            const d = colIn(sheet, a.decision.column);
            const ids = d?.options?.map((o) => o.id) ?? [];
            if (d?.type !== "choice" || !ids.includes(a.decision.approve) || !ids.includes(a.decision.decline))
              err(where, "records its decision in a choice column with an approve and a decline option.");
          }
          break;
        }
        case "notify":
          if (!a.people?.length && !a.columns?.length) err(where, "tells nobody.");
          for (const p of a.people ?? []) if (ctx.people && !ctx.people.has(p)) err(where, "tells someone who isn't in People.");
          for (const c of a.columns ?? []) if (!personCol(c)) err(where, "tells a column that isn't a person column.");
          break;
        case "create_row_in":
        case "update_row_in": {
          const target = sheetIn(a.target.capability, a.target.sheet);
          if (!target) {
            err(where, "writes to a sheet that doesn't exist.");
            break;
          }
          if (a.kind === "update_row_in" && target.kind === "ledger") err(where, `changes a row of ${target.name}, but its entries are only added.`);
          if (a.kind === "update_row_in") {
            const via = colIn(sheet, a.via);
            if (via?.type !== "link" || via.link?.sheet !== a.target.sheet) err(where, "updates a row it has no link to.");
          }
          for (const [col, e] of Object.entries(a.map)) {
            const c = colIn(target, col);
            if (!c || c.type === "computed") err(where, `fills “${col}”, which isn't a column it can fill in ${target.name}.`);
            else if (keptByKernel(target, col)) err(where, `fills ${c.name}, which Bike keeps itself in ${target.name}.`);
            // The row itself only goes into a link column that points back at its sheet.
            if (isRow(e)) {
              const across = !!a.target.capability && a.target.capability !== ctx.selfId;
              const back = c?.type === "link" && c.link?.sheet === sheet.id && (across ? c.link.capability === ctx.selfId : !c.link.capability || c.link.capability === ctx.selfId);
              if (!back) err(where, `fills “${c?.name ?? col}” with the row itself, but it isn't a link to ${sheet.name}.`);
            } else checkOn(sheet, where, e);
          }
          break;
        }
        case "ai_step":
          if (a.column && !colIn(sheet, a.column)) err(where, "proposes a value for a column that doesn't exist.");
          if (a.person && ctx.people && !ctx.people.has(a.person)) err(where, "has someone confirm who isn't in People.");
          break;
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, file };
}
