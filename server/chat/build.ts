import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { capabilityDesigner, type DesignOutput } from "@/server/ai/prompts/capability-designer@11";
import { importMapping } from "@/server/ai/prompts/import-mapping@1";
import { importQuestion, type QuestionOutput } from "@/server/ai/prompts/import-question@2";
import { record } from "@/server/kernel/audit";
import { applyPlan } from "@/server/kernel/changesets";
import { addMessage, getPlan, markCreated, readChat, saveBuildState, touchChat, updateMessage, waitingPlan, type Part } from "@/server/kernel/chats";
import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { saveHolidays } from "@/server/kernel/holidays";
import { checkCoherenceNow, writeOntology } from "@/server/ontology/write";
import { importPeople } from "@/server/kernel/people";
import { planContext, type PlanContext } from "@/server/kernel/plans/context";
import type { DraftRule } from "@/server/kernel/plans/draft";
import { checkImport, foundChoices, type ImportCheck, type Mapping } from "@/server/kernel/plans/import-check";
import { capabilityId } from "@/server/kernel/plans/names";
import { checkPlan, type PlanInput } from "@/server/kernel/plans/plan";
import type { ReadTable, ReadText } from "@/server/kernel/plans/build";
import { applyAnswer, bestSheet, buildingParts, checkQuestion, collapsedLead, doneParts, editorsOf, importTargets, pagesOf, stepsLabel, type Built } from "@/server/kernel/plans/build-run";
import type { Sheet } from "@/server/kernel/schema/file";
import { enqueue } from "@/server/jobs/queue";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { checkTeamFile } from "@/server/setup/team-file";
import type { BuildDraft } from "./build-read";
import { readFiles } from "./build-read";
import { designProblems, writeRules } from "./design";
import { peopleOf } from "./import";

// Build all (4c–4d): People from the export, then each capability in the plan's order. For each: prompt 2
// designs it from its own policy pages, prompt 4 writes its rules, the kernel checks the whole plan, prompt 2b
// maps its tables and the kernel reads every row; then one change set creates it with its rows. Rows a
// capability can't take (required columns empty) are the one question (4c): the build stops on it, keeping
// the design, and goes on once the admin answers. Each capability is live as soon as its change set is.

export type BuildJob = { workspaceId: string; person: { id: string; email: string }; chatId: string; replyId: string; planId: string };

// A capability designed and checked, waiting on the question about its rows.
type Pending = {
  name: string;
  newId: string;
  design: DesignOutput;
  rules: DraftRule[];
  imports: { file: string; sheetId: string; using: Mapping[] }[];
  question: QuestionOutput | null; // asked once the rows are read
  answer: number | null;
  added?: { item: string; why: string }[]; // choices the kernel added from the files (M25), for 4d's list
};

export type BuildState = {
  people: { rows: number; of: number } | null;
  built: Built[];
  pending: Pending | null;
  outcomes: { item: string; why: string }[];
  lastChangeSet: string | null;
};

type Draft = BuildDraft & { build?: BuildState };
type K = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => Promise<T>;

const INTRO_PARTS = (d: Draft, s: BuildState, totals: Map<string, number>, waitingOn?: string) => buildingParts(d.plan, { ...s, waitingOn }, totals);

async function buildPlanOf(tx: Tx, ctx: KernelCtx, chatId: string) {
  const plan = await waitingPlan(tx, ctx, chatId);
  const draft = plan?.draft as Draft | undefined;
  if (!plan || draft?.kind !== "build") throw new KernelError("There is no plan to build in this chat.");
  return { plan, draft };
}

// Build all (4b): the click is the admin's message; the plan's reply shrinks to its first line.
export async function startBuild(tx: Tx, ctx: KernelCtx, chatId: string, label: string) {
  const { plan, draft } = await buildPlanOf(tx, ctx, chatId);
  if (draft.build) throw new KernelError("This plan is already being built.");
  const state: BuildState = { people: null, built: [], pending: null, outcomes: [], lastChangeSet: null };
  await saveBuildState(tx, ctx, plan.id, { ...draft, build: state });
  await shrink(tx, ctx, chatId, plan.messageId, collapsedLead(draft.plan.lead));
  await addMessage(tx, ctx, chatId, { from: "person", text: label });
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", parts: INTRO_PARTS(draft, state, new Map()), status: "working" });
  await enqueue(tx, ctx, "build", { workspaceId: ctx.workspaceId, person: ctx.actor, chatId, replyId, planId: plan.id } satisfies BuildJob, replyId);
}

// The answer to 4c's question: the admin's message, and the build goes on from the capability it stopped at.
export async function answerBuild(tx: Tx, ctx: KernelCtx, chatId: string, choice: number) {
  const { plan, draft } = await buildPlanOf(tx, ctx, chatId);
  const pending = draft.build?.pending;
  if (!pending?.question || pending.answer !== null) throw new KernelError("There is no question waiting.");
  const option = pending.question.options[choice];
  if (!option) throw new KernelError("Choose one of the two answers.");
  const state: BuildState = { ...draft.build!, pending: { ...pending, answer: choice } };
  await saveBuildState(tx, ctx, plan.id, { ...draft, build: state });
  const { messages } = await readChat(tx, ctx, chatId);
  await shrink(tx, ctx, chatId, messages.at(-1)?.id ?? null, `Building. … One question on ${pending.name} …`);
  await addMessage(tx, ctx, chatId, { from: "person", text: option.label });
  const replyId = await addMessage(tx, ctx, chatId, { from: "bike", text: "", parts: INTRO_PARTS(draft, state, new Map()), status: "working" });
  await enqueue(tx, ctx, "build", { workspaceId: ctx.workspaceId, person: ctx.actor, chatId, replyId, planId: plan.id } satisfies BuildJob, replyId);
}

async function shrink(tx: Tx, ctx: KernelCtx, chatId: string, messageId: string | null, text: string) {
  if (!messageId) return;
  const m = (await readChat(tx, ctx, chatId)).messages.find((x) => x.id === messageId);
  if (m?.from === "bike") await updateMessage(tx, ctx, messageId, { parts: [...m.parts.filter((p) => p.kind !== "collapsed"), { kind: "collapsed", text }] });
}

export async function runBuild(job: BuildJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k: K = (fn) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const who = { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId };
  const stored = await k((tx, c) => getPlan(tx, c, job.planId));
  let draft = stored.draft as Draft;
  let state = draft.build!;
  const totals = new Map<string, number>();
  const show = (parts: Part[], status: "working" | "done" | "failed" = "working", text = "") => k((tx, c) => updateMessage(tx, c, job.replyId, { text, parts, status }));
  const save = async (s: BuildState) => {
    state = s;
    draft = { ...draft, build: s };
    await k((tx, c) => saveBuildState(tx, c, job.planId, draft));
  };

  try {
    const { texts, tables } = await readFiles(k, draft.files);
    for (const t of tables) totals.set(t.file, Math.max(0, t.table.length - 1));
    await show(INTRO_PARTS(draft, state, totals));

    if (!state.people) await save({ ...state, people: await buildPeople(k, draft, tables, who) });
    await show(INTRO_PARTS(draft, state, totals));

    for (const cap of draft.plan.capabilities) {
      if (state.built.some((b) => b.name === cap.name)) continue;
      const pc = await k(planContext);
      const ready = state.pending?.name === cap.name ? state.pending : await design(cap, pc, texts, tables, draft, who);
      const out = await importsFor(k, ready, pc, tables, totals);

      // Rows the capability can't take: the one question, unless it has been answered.
      if (out.gaps.length && ready.answer === null) {
        const question = await askQuestion(cap.name, out, pc, pagesOf(texts, cap.pages), tables, who);
        await save({ ...state, pending: { ...ready, question } });
        await show([...INTRO_PARTS(draft, state, totals, cap.name), { kind: "text", text: question.text }, { kind: "buttons", buttons: question.options.map((o, i) => ({ action: `answer:${i}`, label: o.label, primary: i === 0 })) }], "done");
        return;
      }
      const answered = out.gaps.length && ready.question ? applyAnswer(ready.question, ready.answer!, { sheet: out.sheet, gaps: out.gaps, people: pc.people.map((p) => ({ id: pc.peopleByEmail.get(p.email.toLowerCase())!, name: p.name, email: p.email })), capability: cap.name }) : null;
      const built = await k(async (tx, c) => {
        const checked = checkPlan({ capability: ready.design.capability!, rules: ready.rules, alsoChanges: ready.design.also_changes.filter((a) => a.kind === "add") }, { newId: ready.newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
        if (checked.problems.length) throw new KernelError(`${cap.name} can’t be created as planned: ${checked.problems[0]}`, checked.problems);
        // The answer's rows go with the table they came from.
        const imports = out.files.map((f) => ({
          sheetId: f.sheetId,
          fileName: f.file,
          rows: [...f.rows, ...(f.file === out.gapsFile && answered ? answered.rows : [])],
          gaps: f.file === out.gapsFile && answered?.gaps ? answered.gaps : undefined,
        }));
        const res = await applyPlan(tx, c, { plan: checked, newId: ready.newId, chatId: job.chatId, changes: changesOf(ready, pc), imports, source: "build", email: false });
        await touchChat(tx, c, job.chatId, { capabilityIds: [res.capabilityId] });
        const rows = imports.reduce((n, im) => n + im.rows.length + (im.gaps?.rows.length ?? 0), 0);
        const b: Built = { name: cap.name, capabilityId: res.capabilityId, rows, of: cap.data.reduce((n, f) => n + (totals.get(f) ?? 0), 0), sheets: checked.file.sheets.length, steps: stepsLabel(checked.file), rules: checked.file.rules.length };
        return { b, changeSet: res.changeSetId };
      });
      await save({ ...state, built: [...state.built, built.b], pending: null, outcomes: [...state.outcomes, ...(ready.added ?? []), ...(answered ? [answered.outcome] : []), ...out.leftOut], lastChangeSet: built.changeSet });
      await show(INTRO_PARTS(draft, state, totals));
    }

    // Done (4d): text a document tried to direct Bike with is recorded, and the plan is marked built.
    const pc = await k(planContext);
    const holidays = await k((tx, c) => saveHolidays(tx, c, draft.plan.holidays, { chatId: job.chatId }));
    // The Ontology page, written from what was just built (4d says so only when it was).
    const asAdmin = { workspaceId: job.workspaceId, person: job.person };
    await checkCoherenceNow(asAdmin).catch((e: unknown) => console.error(e));
    const ontology = await writeOntology(asAdmin).catch((e: unknown) => (console.error(e), false));
    await k(async (tx, c) => {
      for (const f of draft.flags) await record(tx, c, { who: c.actor.email, event: "document.flagged", details: { file: f.file, page: f.page, excerpt: f.excerpt }, chatId: job.chatId });
      const last = state.built.at(-1);
      if (last && state.lastChangeSet) await markCreated(tx, job.planId, last.capabilityId, state.lastChangeSet);
    });
    await show(doneParts(draft.plan, { company: pc.company.name, people: state.people!, built: state.built, outcomes: state.outcomes, flags: draft.flags, holidays, ontology }), "done");
  } catch (e) {
    const known = e instanceof AiError || e instanceof KernelError;
    if (!known) console.error(e);
    const parts = INTRO_PARTS(draft, state, totals).map((p) => (p.kind === "status" ? { ...p, rows: p.rows.map((r) => (r.state === "doing" ? { ...r, state: "failed" as const } : r)) } : p));
    await show(parts, "failed", known ? e.message : TRY_AGAIN);
  }
}

// People from the export's people table, through the team file rules (2b maps other headers).
async function buildPeople(k: K, draft: Draft, tables: ReadTable[], who: { workspaceId: string; personId: string; chatId: string }) {
  const file = draft.plan.people.file;
  const table = file ? tables.find((t) => t.file === file) : undefined;
  if (!file || !table) return { rows: 0, of: 0 };
  const check = await checkTeamFile(file, table.table, who);
  await k((tx, c) => importPeople(tx, c, c.actor.email, check.rows, `build:${file}`));
  return { rows: check.rows.length, of: Math.max(0, table.table.length - 1) };
}

// Prompt 2 for one capability of the plan, from its own pages, tables, rules and connections; then prompt 4
// for its rules. The kernel checks the design, its name and its rules against the workspace as it is now.
async function design(
  cap: Draft["plan"]["capabilities"][number],
  pc: PlanContext,
  texts: ReadText[],
  tables: ReadTable[],
  draft: Draft,
  who: { workspaceId: string; personId: string; chatId: string },
): Promise<Pending> {
  const newId = crypto.randomUUID();
  const checkWith = (input: PlanInput) => checkPlan(input, { newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
  const builtNames = new Set(pc.order.map((id) => pc.files.get(id)!.name.toLowerCase()));
  const links = draft.plan.connections.filter((c) => (c.from === cap.name && builtNames.has(c.to.toLowerCase())) || (c.to === cap.name && builtNames.has(c.from.toLowerCase())));
  const request = [
    `Set up ${cap.name}: ${cap.what_it_runs}. ${cap.purpose}`,
    cap.rules.length ? `Its rules, from the policies:\n${cap.rules.map((r) => `- ${r}`).join("\n")}` : "",
    links.length ? `Where it connects to what is already built:\n${links.map((l) => `- ${l.says}`).join("\n")}` : "",
    cap.data.length
      ? `Its rows come from ${cap.data.join(", ")}, imported into its first sheet. The file's columns fill plain columns of that sheet (text, dates, amounts, people, choices, steps); a link can't be filled from a file, so a link column there stays empty for imported rows.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const own = tables.filter((t) => cap.data.includes(t.file));
  const out = await ask(
    capabilityDesigner,
    {
      user: pc.user,
      company: pc.company,
      existing: pc.existing,
      people: pc.people,
      conversation: [],
      currentPlan: null,
      latestMessage: request,
      documents: pagesOf(texts, cap.pages),
      tables: own.map((t) => ({ file: t.file, from: t.from, rows: Math.max(0, t.table.length - 1), header: t.table[0] ?? [] })),
    },
    who,
    {
      check: (d) => [
        ...(d.type !== "new_capability" ? [`This is one app of a build: answer type "new_capability" for ${cap.name}.`] : []),
        ...(d.capability && d.capability.name.trim().toLowerCase() !== cap.name.toLowerCase() ? [`Name it ${cap.name}, as the plan does.`] : []),
        ...designProblems(d, checkWith, false),
      ],
    },
  );
  const { rules, couldNot } = await writeRules(out, pc, newId, checkWith, who);
  const capability = { ...out.capability!, name: cap.name, later: [...out.capability!.later, ...couldNot.map((c) => c.sentence)] };
  const checked = checkWith({ capability, rules, alsoChanges: out.also_changes.filter((a) => a.kind === "add") });
  if (checked.problems.length) {
    // Said in the log, as the gateway says a failed answer: the chat only says to try again.
    console.warn(`Build: ${cap.name} refused by the kernel: ${checked.problems.join(" | ").slice(0, 1000)}`);
    throw new AiError(TRY_AGAIN);
  }

  // Prompt 2b maps each of its tables onto each sheet that can take it; the kernel picks the sheet where most
  // of the table's columns land.
  const people = await withWorkspace({ workspaceId: who.workspaceId, personId: who.personId }, (tx) => peopleOf(tx));
  const imports = [];
  for (const t of own) {
    const [header = [], ...lines] = t.table;
    const options = [];
    for (const sheet of importTargets(checked.file)) {
      const columns = sheet.columns
        .filter((c) => !["computed", "link", "file"].includes(c.type))
        .map((c) => ({ name: c.name, type: c.type, ...(c.type === "step" ? { choices: sheet.steps?.map((s) => s.name) } : c.options ? { choices: c.options.map((o) => o.name) } : {}) }));
      // A sheet the table doesn't fit may get no usable mapping; it just isn't an option.
      const mapped = await ask(
        importMapping,
        { target: { capability: cap.name, sheet: sheet.name, columns }, file: { name: t.file, header, sample: lines.slice(0, 20) } },
        who,
        { check: (o) => checkImport(sheet, t.table, o.mapping, people).problems, building: false },
      ).catch((e: unknown) => {
        if (e instanceof AiError) return null;
        throw e;
      });
      if (mapped) options.push({ sheetId: sheet.id, using: mapped.mapping, mapped: checkImport(sheet, t.table, mapped.mapping, people).mapping.length });
    }
    const best = bestSheet(options);
    if (!best) throw new AiError(`I couldn't match ${t.file} to any sheet of ${cap.name}.`);
    imports.push({ file: t.file, sheetId: best.sheetId, using: best.using });
  }
  // Choice values the files use that the design missed become choices, so their rows come in (M25).
  const added: { item: string; why: string }[] = [];
  for (const im of imports) {
    const t = own.find((x) => x.file === im.file)!;
    const into = checked.file.sheets.find((s) => s.id === im.sheetId)!;
    for (const f of foundChoices(into, t.table, im.using)) {
      const column = capability.sheets.find((s) => s.name === into.name)?.columns.find((c) => c.name === f.column);
      if (!column) continue;
      column.options = [...column.options, ...f.values];
      added.push({ item: `${f.values.map((v) => `“${v}”`).join(", ")} in ${f.column}`, why: `Used in ${im.file} but not among the choices. Added as ${f.values.length === 1 ? "a choice" : "choices"}.` });
    }
  }
  const withChoices = added.length ? checkWith({ capability, rules, alsoChanges: out.also_changes.filter((a) => a.kind === "add") }).problems : [];
  if (withChoices.length) {
    console.warn(`Build: ${cap.name} with its added choices refused by the kernel: ${withChoices.join(" | ").slice(0, 1000)}`);
    throw new AiError(TRY_AGAIN);
  }
  return { name: cap.name, newId, design: { ...out, capability }, rules, imports, question: null, answer: null, added };
}

// Every row of the capability's tables, read by the kernel with the checked mapping, against its file as it
// would be created now.
async function importsFor(k: K, p: Pending, pc: PlanContext, tables: ReadTable[], totals: Map<string, number>) {
  const checked = checkPlan({ capability: p.design.capability!, rules: p.rules, alsoChanges: p.design.also_changes.filter((a) => a.kind === "add") }, { newId: p.newId, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules });
  const people = await k(peopleOf);
  const files: { file: string; sheetId: string; rows: ImportCheck["rows"] }[] = [];
  let gaps: ImportCheck["gaps"] = [];
  let gapsFile = "";
  let sheet: Sheet = checked.file.sheets[0]!; // the sheet with the rows the question is about
  const leftOut: { item: string; why: string }[] = [];
  for (const im of p.imports) {
    const t = tables.find((x) => x.file === im.file);
    if (!t) continue;
    const into = checked.file.sheets.find((s) => s.id === im.sheetId)!;
    const c = checkImport(into, t.table, im.using, people);
    files.push({ file: im.file, sheetId: into.id, rows: c.rows });
    if (c.gaps.length && !gaps.length) {
      gaps = c.gaps;
      gapsFile = im.file;
      sheet = into;
    }
    const unread = (totals.get(im.file) ?? 0) - c.rows.length - (gapsFile === im.file ? c.gaps.length : 0);
    const first = c.checks.find((x) => x.action === "Leave this row out" && !c.gaps.some((g) => g.row === x.row));
    if (unread > 0) leftOut.push({ item: `${unread.toLocaleString("en-US")} ${into.row?.one ?? "row"} ${unread === 1 ? "row" : "rows"} in ${im.file}`, why: `${first?.issue ?? "Bike couldn't read them"}. Left out.` });
  }
  return { sheet, files, gaps, gapsFile, leftOut, file: checked.file };
}

// Prompt 2's question about the rows, checked: the person can edit every row, a value is one the column takes.
async function askQuestion(
  name: string,
  out: Awaited<ReturnType<typeof importsFor>>,
  pc: PlanContext,
  pages: ReadText[],
  tables: ReadTable[],
  who: { workspaceId: string; personId: string; chatId: string },
) {
  const everyone = pc.people.map((x) => ({ id: pc.peopleByEmail.get(x.email.toLowerCase())!, name: x.name, email: x.email, title: x.title }));
  const editors = editorsOf(out.file, out.sheet.id, everyone);
  const missing = [...new Set(out.gaps.flatMap((g) => g.missing))].map((id) => out.sheet.columns.find((c) => c.id === id)!);
  return ask(
    importQuestion,
    {
      capability: name,
      file: out.gapsFile,
      from: tables.find((t) => t.file === out.gapsFile)?.from ?? null,
      rows: out.sheet.row ?? { one: "row", many: "rows" },
      count: out.gaps.length,
      missing: missing.map((c) => ({ name: c.name, type: c.type, ...(c.options ? { choices: c.options.map((o) => o.name) } : {}) })),
      examples: out.gaps.slice(0, 5).map((g) => g.row),
      people: editors.map((e) => ({ name: e.name, email: e.email, title: e.title })),
      documents: pages,
    },
    who,
    { check: (q) => checkQuestion(q, { sheet: out.sheet, gaps: out.gaps, editors }), building: false },
  );
}

// What each Also change says, per capability, for its Audit entry.
function changesOf(p: Pending, pc: PlanContext) {
  const changes = new Map<string, string[]>();
  const world = { newId: p.newId, newName: p.name, files: pc.files, people: pc.peopleByEmail, companyRules: pc.companyRules };
  for (const a of p.design.also_changes.filter((x) => x.kind === "add")) {
    const id = capabilityId(world, a.capability, p.newId);
    if (id) changes.set(id, [...(changes.get(id) ?? []), a.change]);
  }
  return changes;
}
