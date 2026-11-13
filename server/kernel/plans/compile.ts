import type { Action, CapabilityFile, Column, Role, Rule, Sheet, Step } from "../schema/file";
import { sameJson } from "@/lib/same-json";
import type { DraftAction, DraftAlsoChange, DraftCapability, DraftColumn, DraftEdit, DraftRule, DraftStep } from "./draft";
import { byName, capabilityId, newId, personId, resolveExpr, type World } from "./names";
import { defaultForm } from "../form";
import { LinkError, linkInstead } from "../customize/link-instead";

// A plan by name → capability files by id. Problems come back in plain words, for the AI's one retry and,
// failing that, for the log. Nothing here reads or writes the database.

type Problems = string[];

export function column(c: DraftColumn, id: string): Column {
  return {
    id,
    name: c.name.trim(),
    type: c.type,
    ...(c.required ? { required: true } : {}),
    ...(c.type === "choice" ? { options: [] as { id: string; name: string }[] } : {}),
    ...(c.type === "computed" && c.result ? { result: c.result } : {}),
  };
}

export function step(st: DraftStep, id: string): Step {
  return {
    id,
    name: st.name.trim(),
    ...(st.start ? { start: true as const } : {}),
    ...(st.end ? { end: st.end } : {}),
    ...(st.move_out !== "anyone" ? { moveOut: st.move_out } : {}),
    ...(st.move_in !== "anyone" ? { moveIn: st.move_in } : {}),
    ...(st.button ? { button: st.button.trim() } : {}),
  };
}

// The parts of a column that name other things (links, formulas, defaults), once every id in reach exists.
export function finishColumn(world: World, capId: string, sheet: Sheet, col: Column, d: DraftColumn, p: Problems) {
  const where = `${sheet.name} › ${col.name}`;
  const scope = { world, capId, sheet, problems: p, where };
  if (col.type === "choice") {
    const taken = new Set<string>();
    col.options = d.options.map((o) => ({ id: newId(o, taken), name: o.trim() }));
  }
  if (d.link) {
    const target = capabilityId(world, d.link.capability, capId);
    const s = target ? byName(world.files.get(target)?.sheets, d.link.sheet) : undefined;
    if (!target || !s) p.push(`${where}: links to a sheet “${d.link.sheet}” that doesn't exist.`);
    else {
      // The row a tree's row sits under is never a pick from a list (G1), though a design sometimes marks it so.
      const pick = d.link.pick && sheet.tree?.parent !== col.id;
      col.link = { ...(target !== capId ? { capability: target } : {}), sheet: s.id, ...(pick ? { pick: true as const } : {}) };
    }
  }
  if (d.formula) col.expr = resolveExpr(d.formula, scope);
  if (d.default) {
    const like = { col, steps: sheet.steps };
    switch (d.default.kind) {
      case "creator":
      case "today":
        col.default = { kind: d.default.kind };
        break;
      case "value":
        if (d.default.value != null) col.default = { kind: "value", value: resolveExpr(d.default.value, scope, like) };
        break;
      case "formula":
        if (d.default.value) col.default = { kind: "expr", expr: resolveExpr(d.default.value, scope, like) };
        break;
    }
  }
}

function role(world: World, file: CapabilityFile, r: DraftRole, taken: Set<string>, p: Problems): Role {
  const where = `Role “${r.name}”`;
  const sheet = (n: string) => {
    const s = byName(file.sheets, n);
    if (!s) p.push(`${where}: there is no sheet “${n}”.`);
    return s;
  };
  let members: Role["members"];
  if (r.everyone) members = { kind: "everyone" };
  else if (r.person_column) {
    const s = sheet(r.person_column.sheet);
    const c = byName(s?.columns, r.person_column.column);
    if (s && !c) p.push(`${where}: ${s.name} has no column “${r.person_column.column}”.`);
    members = { kind: "column", sheet: s?.id ?? "", column: c?.id ?? "" };
  } else {
    // Someone not in People is named as a problem and left out, so the file check doesn't repeat it.
    const ids = r.people.flatMap((e) => {
      const id = personId(world, e);
      if (!id) p.push(`${where}: ${e} isn't in People.`);
      return id ? [id] : [];
    });
    members = { kind: "people", people: ids };
  }
  const scopeColumns = Object.fromEntries(
    r.scope_columns.flatMap((sc) => {
      const s = sheet(sc.sheet);
      if (!s) return [];
      const via = sc.via ? byName(s.columns, sc.via) : undefined;
      const on = via?.link ? world.files.get(via.link.capability ?? world.newId)?.sheets.find((x) => x.id === via.link!.sheet) : s;
      const c = byName(on?.columns, sc.column);
      if (!c || (sc.via && !via)) p.push(`${where}: ${s.name} has no person column “${sc.column}” to decide whose rows they are.`);
      return [[s.id, { column: c?.id ?? sc.column, ...(via ? { via: via.id } : {}) }]];
    }),
  );
  return {
    id: newId(r.name, taken),
    name: r.name.trim(),
    members,
    can: [...new Set(r.can)],
    ...(r.sheets ? { sheets: r.sheets.map((n) => sheet(n)?.id ?? n) } : {}),
    scope: r.scope,
    ...(r.scope !== "all" && Object.keys(scopeColumns).length ? { scopeColumns } : {}),
  };
}
type DraftRole = DraftCapability["roles"][number];

// The new capability's file, without rules (they come from the logic writer).
// base: the capability a sheet is added to by Customize; its sheets come first, so the new sheet's links,
// formulas and document can name them (C1).
export function compileCapability(d: DraftCapability, world: World, p: Problems, base?: CapabilityFile): CapabilityFile {
  const sheetIds = new Set<string>(base?.sheets.map((s) => s.id));
  const sheets: Sheet[] = d.sheets.map((s) => {
    const colIds = new Set<string>();
    const stepIds = new Set<string>();
    const columns = s.columns.map((c) => column(c, newId(c.name, colIds)));
    return {
      id: newId(s.name, sheetIds),
      name: s.name.trim(),
      kind: s.kind,
      titleColumn: byName(columns, s.title_column)?.id ?? (p.push(`${s.name}: its title column “${s.title_column}” isn't one of its columns.`), ""),
      columns,
      ...(s.steps.length ? { steps: s.steps.map((st) => step(st, newId(st.name, stepIds))) } : {}),
      row: { one: s.row_one.trim(), many: s.row_many.trim() },
      ...(s.add_action ? { addAction: s.add_action.trim() } : {}),
    };
  });
  const all = [...(base?.sheets ?? []), ...sheets];
  d.sheets.forEach((s, i) => {
    if (s.parent_sheet) {
      const parent = byName(all, s.parent_sheet);
      if (!parent) p.push(`${s.name}: its document sheet “${s.parent_sheet}” doesn't exist.`);
      else sheets[i]!.parentSheet = parent.id;
    }
    if (s.tree_parent) {
      const parent = byName(sheets[i]!.columns, s.tree_parent);
      if (!parent) p.push(`${s.name}: it has no column “${s.tree_parent}” naming the row each one sits under.`);
      else sheets[i]!.tree = { parent: parent.id };
    }
    if (s.kind === "ledger") ledgerFor(sheets[i]!, s, p);
    if (s.kind === "dated") datedFor(sheets[i]!, s, p);
  });
  // No description: a capability made from chat says where it came from under its name (5i, "Created from
  // your message today").
  const file: CapabilityFile = { name: d.name.trim(), icon: d.icon, sheets: all, roles: [], rules: [], later: d.later };
  const inWorld: World = { ...world, files: new Map([...world.files, [world.newId, file]]) };
  // Links and formulas can name any sheet, here or in another capability, so they come once every id exists.
  d.sheets.forEach((s, i) => {
    const sheet = sheets[i]!;
    s.columns.forEach((c, j) => finishColumn(inWorld, world.newId, sheet, sheet.columns[j]!, c, p));
    s.steps.forEach((st, j) => {
      if (st.only_when) sheet.steps![j]!.onlyWhen = resolveExpr(st.only_when, { world: inWorld, capId: world.newId, sheet, problems: p, where: `${sheet.name} › ${st.name}` });
    });
  });
  const roleIds = new Set<string>();
  file.roles = d.roles.map((r) => role(inWorld, file, r, roleIds, p));
  // Long sheets get tabs (0.3).
  for (const sheet of sheets) {
    const form = defaultForm(sheet);
    if (form) sheet.form = form;
  }
  return file;
}

function action(world: World, capId: string, sheet: Sheet, a: DraftAction, p: Problems, where: string): Action | null {
  const scope = { world, capId, sheet, problems: p, where };
  const stepId = (n: string | null, on: Sheet = sheet) => {
    if (!n) return undefined;
    const st = byName(on.steps, n);
    if (!st) p.push(`${where}: ${on.name} has no step “${n}”.`);
    return st?.id ?? n;
  };
  const col = (n: string | null, on: Sheet = sheet) => {
    if (!n) return undefined;
    const c = byName(on.columns, n);
    if (!c) p.push(`${where}: ${on.name} has no column “${n}”.`);
    return c?.id ?? n;
  };
  switch (a.kind) {
    case "move_to_step":
      return { kind: "move_to_step", step: stepId(a.step) ?? "" };
    case "create_row_in":
    case "update_row_in": {
      const targetCap = a.target ? capabilityId(world, a.target.capability, capId) : undefined;
      const target = targetCap && a.target ? byName(world.files.get(targetCap)?.sheets, a.target.sheet) : undefined;
      if (!target || !targetCap) {
        p.push(`${where}: writes to a sheet “${a.target?.sheet ?? ""}” that doesn't exist.`);
        return null;
      }
      const map = Object.fromEntries(
        a.map.map((m) => {
          const tc = byName(target.columns, m.column);
          if (!tc) p.push(`${where}: ${target.name} has no column “${m.column}”.`);
          return [tc?.id ?? m.column, resolveExpr(m.value, scope, tc && { col: tc, steps: target.steps })];
        }),
      );
      const ref = { ...(targetCap !== capId ? { capability: targetCap } : {}), sheet: target.id };
      return a.kind === "create_row_in" ? { kind: "create_row_in", target: ref, map } : { kind: "update_row_in", target: ref, via: col(a.via) ?? "", map };
    }
    case "notify":
      return {
        kind: "notify",
        ...(a.people.length ? { people: a.people.flatMap((e) => personId(world, e) ?? (p.push(`${where}: ${e} isn't in People.`), [])) } : {}),
        ...(a.columns.length ? { columns: a.columns.map((c) => col(c)!) } : {}),
        message: a.message ?? "",
      };
    case "ask_person": {
      const via = a.via ? byName(sheet.columns, a.via) : undefined;
      const linked = via?.link ? world.files.get(via.link.capability ?? capId)?.sheets.find((x) => x.id === via.link!.sheet) : undefined;
      if (a.via && !linked) p.push(`${where}: “${a.via}” isn't a link column on ${sheet.name}.`);
      const decision = a.decision
        ? (() => {
            const c = byName(sheet.columns, a.decision.column);
            const opt = (n: string) => byName(c?.options, n)?.id ?? (p.push(`${where}: ${a.decision!.column} has no choice “${n}”.`), n);
            if (!c) p.push(`${where}: ${sheet.name} has no column “${a.decision.column}”.`);
            return { column: c?.id ?? a.decision.column, approve: opt(a.decision.approve), decline: opt(a.decision.decline) };
          })()
        : undefined;
      return {
        kind: "ask_person",
        ...(a.step ? { step: stepId(a.step) } : {}),
        ...(a.until ? { until: col(a.until) } : {}),
        ...(a.person ? (personId(world, a.person) ? { person: personId(world, a.person) } : (p.push(`${where}: ${a.person} isn't in People.`), {})) : {}),
        ...(a.column ? { column: col(a.column, linked ?? sheet) } : {}),
        ...(via ? { via: via.id } : {}),
        ...(a.manager_of ? { managerOf: col(a.manager_of) } : {}),
        ...(a.label ? { label: a.label } : {}),
        ...(decision ? { decision } : {}),
      };
    }
    case "ai_step":
      return {
        kind: "ai_step",
        question: a.question ?? "",
        ...(a.answer_column ? { column: col(a.answer_column) } : {}),
        ...(a.person ? (personId(world, a.person) ? { person: personId(world, a.person) } : (p.push(`${where}: ${a.person} isn't in People.`), {})) : {}),
      };
  }
}

// A repeating rule's schedule (M32), from the draft's words: a weekday by name, a day and month by number.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function repeatOf(t: DraftRule["trigger"], p: Problems, where: string): Pick<Rule["trigger"], "every" | "starts" | "ends"> {
  const e = t.every;
  const date = (d: string | null | undefined) => {
    if (!d) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) p.push(`${where}: “${d}” isn't a date written as 2026-12-01.`);
    return d;
  };
  const starts = date(t.starts);
  const ends = date(t.ends);
  return {
    ...(e
      ? {
          every: {
            unit: e.unit,
            ...(e.weekday ? { weekday: WEEKDAYS.indexOf(e.weekday) + 1 } : {}),
            ...(e.day != null ? { day: e.day } : {}),
            ...(e.month != null ? { month: e.month } : {}),
          },
        }
      : {}),
    ...(starts ? { starts } : {}),
    ...(ends ? { ends } : {}),
  };
}

// One rule, for the capability its trigger sheet is in.
export function compileRule(d: DraftRule, world: World, taken: Set<string>, p: Problems): { capId: string; rule: Rule } | null {
  const where = `Rule “${d.text}”`;
  const capId = capabilityId(world, d.capability, world.newId);
  const sheet = capId ? byName(world.files.get(capId)?.sheets, d.sheet) : undefined;
  if (!capId || !sheet) {
    p.push(`${where}: starts on a sheet “${d.sheet}” that doesn't exist.`);
    return null;
  }
  const t = d.trigger;
  const named = (list: { id: string; name: string }[] | undefined, n: string | null, what: string) => {
    if (!n) return undefined;
    const x = byName(list, n);
    if (!x) p.push(`${where}: ${sheet.name} has no ${what} “${n}”.`);
    return x?.id ?? n;
  };
  const actions = d.actions.map((a) => action(world, capId, sheet, a, p, where)).filter((a): a is Action => !!a);
  return {
    capId,
    rule: {
      id: newId(d.when, taken),
      text: d.text.trim(),
      reading: { when: d.when.trim(), then: d.then.trim() },
      trigger: {
        kind: t.kind,
        sheet: sheet.id,
        ...(t.step ? { step: named(sheet.steps, t.step, "step") } : {}),
        ...(t.field ? { field: named(sheet.columns, t.field, "column") } : {}),
        ...(t.from_added ? { from: "added" as const } : t.date ? { date: named(sheet.columns, t.date, "column") } : {}),
        ...(t.offset_days != null ? { offsetDays: t.offset_days } : {}),
        ...(t.kind === "repeats" ? repeatOf(t, p, where) : {}),
      },
      ...(d.condition ? { condition: resolveExpr(d.condition, { world, capId, sheet, problems: p, where }) } : {}),
      actions,
      enabled: true,
    },
  };
}

// Applies one Also change's edits to a copy of an existing file. A restructure with no edits (a move Bike can't do
// yet) changes nothing here.
export function applyEdits(file: CapabilityFile, change: DraftAlsoChange, world: World, capId: string, p: Problems): CapabilityFile {
  if (!change.edits.length) return file;
  const out: CapabilityFile = structuredClone(file);
  for (const e of change.edits) applyEdit(out, e, world, capId, p, change.capability);
  return out;
}

function applyEdit(file: CapabilityFile, e: DraftEdit, world: World, capId: string, p: Problems, capName: string) {
  const sheet = byName(file.sheets, e.sheet ?? file.sheets[0]?.name);
  const where = `${capName}${sheet ? ` › ${sheet.name}` : ""}`;
  if (e.kind === "add_role_member") {
    const r = byName(file.roles, e.role);
    const id = personId(world, e.person);
    if (!r || r.members.kind !== "people") p.push(`${where}: there is no role “${e.role ?? ""}” to add someone to.`);
    else if (!id) p.push(`${where}: ${e.person ?? ""} isn't in People.`);
    else if (!r.members.people.includes(id)) r.members.people.push(id);
    return;
  }
  if (!sheet) {
    p.push(`${capName}: there is no sheet “${e.sheet ?? ""}”.`);
    return;
  }
  if (e.kind === "link_column") {
    const col = byName(sheet.columns, e.link?.column);
    const toCap = capabilityId(world, e.link?.to_capability, capId);
    const toFile = toCap === capId ? file : toCap ? world.files.get(toCap) : undefined;
    const toSheet = byName(toFile?.sheets, e.link?.to_sheet);
    if (!e.link || !col) return p.push(`${where}: there is no column “${e.link?.column ?? ""}” to turn into a link.`), undefined;
    if (!toSheet) return p.push(`${where}: there is no sheet “${e.link.to_sheet}” to link ${col.name} to.`), undefined;
    try {
      const after = linkInstead(file, { sheet: sheet.id, column: col.id, to: { ...(toCap !== capId ? { capability: toCap! } : {}), sheet: toSheet.id } });
      file.sheets = after.sheets;
      file.roles = after.roles;
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      p.push(`${where}: ${err.message}`);
    }
    return;
  }
  if (e.kind === "add_column" && e.column) {
    if (byName(sheet.columns, e.column.name)) return p.push(`${where}: already has a column “${e.column.name}”.`), undefined;
    const col = column(e.column, newId(e.column.name, new Set(sheet.columns.map((c) => c.id))));
    sheet.columns.push(col);
    finishColumn({ ...world, files: new Map([...world.files, [capId, file]]) }, capId, sheet, col, e.column, p);
    return;
  }
  if (e.kind === "add_step" && e.step) {
    if (byName(sheet.steps, e.step.name)) return p.push(`${where}: already has a step “${e.step.name}”.`), undefined;
    const steps = sheet.steps ?? [];
    const after = byName(steps, e.after);
    if (!after) return p.push(`${where}: there is no step “${e.after ?? ""}” to add it after.`), undefined;
    const st = step({ ...e.step, start: false }, newId(e.step.name, new Set(steps.map((s) => s.id))));
    // A step after the last one becomes the last one, and rows already there stay where they are.
    if (after.end === "final") {
      st.end = "final";
      delete after.end;
      delete after.tone;
    }
    steps.splice(steps.indexOf(after) + 1, 0, st);
    sheet.steps = steps;
  }
}

// A ledger's own columns (M29): its account and amount, named in the plan, both required; the balance after each entry
// and the link to the entry a reversal reverses, which the kernel fills, added here when the plan left them out.
function ledgerFor(sheet: Sheet, d: { name: string; ledger_account?: string | null; ledger_amount?: string | null; ledger_min?: number | null }, p: Problems) {
  const account = d.ledger_account ? byName(sheet.columns, d.ledger_account) : undefined;
  const amount = d.ledger_amount ? byName(sheet.columns, d.ledger_amount) : undefined;
  if (!account) return void p.push(`${d.name}: a ledger names the column whose balance each entry counts toward.`);
  if (!amount) return void p.push(`${d.name}: a ledger names its amount column.`);
  account.required = true;
  amount.required = true;
  const ids = new Set(sheet.columns.map((c) => c.id));
  const balance: Column = { id: newId("balance after", ids), name: "Balance after", type: amount.type === "computed" ? "number" : amount.type };
  ids.add(balance.id);
  const reverses: Column = { id: newId("reverses", ids), name: "Reverses", type: "link", link: { sheet: sheet.id } };
  // A name the plan already used keeps its column, as the kernel's own.
  const named = (c: Column) => byName(sheet.columns, c.name);
  const b = named(balance) ?? (sheet.columns.push(balance), balance);
  const r = named(reverses) ?? (sheet.columns.push(reverses), reverses);
  sheet.ledger = { account: account.id, amount: amount.id, balance: b.id, reverses: r.id, ...(typeof d.ledger_min === "number" ? { min: d.ledger_min } : {}) };
}

// A dated sheet's own columns (M30): what each row is for, if anything, and the date it starts, both required; Until,
// which the kernel keeps, added here when the plan left it out.
function datedFor(sheet: Sheet, d: { name: string; dated_key?: string | null; dated_from?: string | null }, p: Problems) {
  const key = d.dated_key ? byName(sheet.columns, d.dated_key) : undefined;
  const from = d.dated_from ? byName(sheet.columns, d.dated_from) : undefined;
  if (d.dated_key && !key) return void p.push(`${d.name}: it has no column “${d.dated_key}” saying what each row's value is for.`);
  if (!from) return void p.push(`${d.name}: a dated sheet names the date column each row starts on.`);
  if (key) key.required = true;
  from.required = true;
  const ids = new Set(sheet.columns.map((c) => c.id));
  const until = byName(sheet.columns, "Until") ?? (sheet.columns.push({ id: newId("until", ids), name: "Until", type: "date" }), sheet.columns.at(-1)!);
  // The kernel fills it: not asked, not required, no default.
  delete until.required;
  delete until.default;
  sheet.dated = { ...(key ? { key: key.id } : {}), from: from.id, until: until.id };
}

// Only adds: every sheet, column, step, role and rule there before is still there, of the same kind, a link
// pointing where it did and a kept column kept. A typed column a link takes the place of (M27) stays, of the same
// kind; the move that fills the link is the kernel's (customize/move.ts).
// The one change allowed to an existing step: it stops being the last one when a step is added after it.
// Customize may also change a rule it keeps (rulesMayChange): a rule moves no data.
export function notAdditive(before: CapabilityFile, after: CapabilityFile, opts: { rulesMayChange?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const s of before.sheets) {
    const a = after.sheets.find((x) => x.id === s.id);
    // A list may become a tree through a new column naming the row above: no row sits under another yet (M28).
    const becomesTree = s.kind === "list" && a?.kind === "tree" && !!a.tree && !s.columns.some((c) => c.id === a.tree!.parent);
    if (!a || (a.kind !== s.kind && !becomesTree)) {
      out.push(
        a && s.kind === "tree"
          ? `${s.name} would stop being a tree, which moves data.`
          : a && a.kind === "tree"
            ? `${s.name} can become a tree only through a new column naming the row each one sits under.`
            : a && (a.kind === "ledger" || s.kind === "ledger")
              ? `${s.name} can't ${s.kind === "ledger" ? "stop being a ledger" : "become a ledger"}: a ledger's entries are only added, so it starts as a new sheet.`
              : a && (a.kind === "dated" || s.kind === "dated")
                ? `${s.name} can't ${s.kind === "dated" ? "stop being kept by date" : "become kept by date"}: a sheet kept by date starts as a new sheet.`
                : `${before.name} would lose its ${s.name} sheet.`,
      );
      continue;
    }
    if (s.tree && a.tree?.parent !== s.tree.parent) out.push(`${s.name} would sit under each other through another column, which moves data.`);
    if (s.ledger && JSON.stringify(a.ledger) !== JSON.stringify(s.ledger)) out.push(`${s.name} would keep its balance another way, which moves data.`);
    if (s.dated && JSON.stringify(a.dated) !== JSON.stringify(s.dated)) out.push(`${s.name} would be kept by date another way, which moves data.`);
    for (const c of s.columns) {
      const ac = a.columns.find((x) => x.id === c.id);
      if (!ac) out.push(`${s.name} would lose its ${c.name} column.`);
      else if (ac.type !== c.type) out.push(`${s.name} › ${c.name} would change from ${c.type} to ${ac.type}, which moves data.`);
      else if (c.link && (ac.link?.sheet !== c.link.sheet || (ac.link.capability ?? null) !== (c.link.capability ?? null))) out.push(`${s.name} › ${c.name} would point somewhere else, which moves data.`);
      else if (c.replacedBy && ac.replacedBy !== c.replacedBy) out.push(`${s.name} › ${c.name} is kept from before and stays as it is.`);
    }
    for (const st of s.steps ?? []) {
      const as = a.steps?.find((x) => x.id === st.id);
      if (!as) out.push(`${s.name} would lose its ${st.name} step.`);
      else if (as.end !== st.end && !(st.end === "final" && !as.end)) out.push(`${s.name} › ${st.name} would end differently.`);
    }
  }
  for (const r of before.roles) if (!after.roles.some((x) => x.id === r.id)) out.push(`${before.name} would lose its ${r.name} role.`);
  for (const r of before.rules) {
    const kept = after.rules.find((x) => x.id === r.id);
    if (!kept) out.push(`${before.name} would lose its rule “${r.text}”.`);
    else if (!opts.rulesMayChange && !sameJson(kept, r)) out.push(`${before.name} would change its rule “${r.text}”.`);
  }
  return out;
}

