import { eq } from "drizzle-orm";
import { people, workspaces } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { AiError, ask, TRY_AGAIN } from "@/server/ai/gateway";
import { asDocument } from "@/server/ai/prompt";
import { setupOrganization, setupTeam } from "@/server/ai/prompts/setup-reader@1";
import { readPdf } from "@/server/files/read";
import { readSpreadsheet, SheetError } from "@/server/files/sheet-reader";
import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { checkOrganization, saveOrganization, type OrgReading } from "@/server/kernel/setup/organization";
import { lastReading, openSetup, readSetup, writeSetup, type SetupFile, type SetupMessage, type SetupState } from "@/server/kernel/setup/state";
import { draftFromFile, draftFromReading, finishTeam, leadsTable, type TeamDraft, type TeamPerson } from "@/server/kernel/setup/team";
import { openUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { currentTime } from "@/server/kernel/clock";
import { checkTeamFile } from "./team-file";

// Setup's organization and team steps (2b–2e). A message is written now, in the caller's transaction; prompt
// 8 reads it after the response, so the page shows Bike working as it polls. Continue to your team and
// Finish setup are the only saves.

export type Work = () => Promise<void>;
type Job = { workspaceId: string; person: { id: string; email: string } };

const working = (now = currentTime()): SetupMessage => ({ from: "bike", status: "working", since: now.toISOString() });
const said = (s: SetupState) => s.messages.flatMap((m) => (m.from === "admin" ? [m.text] : []));
const conversation = (s: SetupState): { from: "admin" | "bike"; text: string }[] =>
  s.messages.flatMap((m) => (m.from === "admin" || m.status === "done" ? [{ from: m.from, text: m.text }] : []));

// The work after the response: whatever it returns replaces the working reply.
async function finishReply(job: Job, fn: (state: SetupState) => Promise<SetupMessage>) {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k = <T>(f: (tx: Tx) => Promise<T>) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, f);
  const { state } = await k((tx) => readSetup(tx, ctx));
  let reply: SetupMessage;
  try {
    reply = await fn(state);
  } catch (e) {
    if (!(e instanceof AiError || e instanceof KernelError || e instanceof SheetError)) console.error(e);
    reply = { from: "bike", status: "failed", text: e instanceof AiError || e instanceof KernelError || e instanceof SheetError ? e.message : TRY_AGAIN };
  }
  await k(async (tx) => {
    const now = (await readSetup(tx, ctx)).state;
    const at = now.messages.findLastIndex((m) => m.from === "bike" && m.status === "working");
    if (at >= 0) now.messages[at] = reply;
    await writeSetup(tx, ctx, now);
  });
}

async function company(tx: Tx) {
  const [ws] = await tx.select({ name: workspaces.name, ownerId: workspaces.ownerId }).from(workspaces);
  const [owner] = await tx.select({ name: people.name, email: people.email, title: people.title }).from(people).where(eq(people.id, ws!.ownerId!));
  return { name: ws!.name, owner: owner! };
}

async function openFiles(tx: Tx, ctx: KernelCtx, uploadIds: string[]) {
  const out = [];
  for (const id of uploadIds.slice(0, 3)) out.push(await openUpload(tx, ctx, id));
  return out;
}

// ── Organization (2b → 2c) ──

export async function sendOrganization(tx: Tx, ctx: KernelCtx, text: string, uploadIds: string[]): Promise<Work> {
  const state = await openSetup(tx, ctx, "organization");
  if (!text.trim() && !uploadIds.length) throw new KernelError("Type a message first.");
  const files = await openFiles(tx, ctx, uploadIds);
  if (files.some((f) => !/\.pdf$/i.test(f.name))) throw new KernelError("On this step Bike reads PDFs.");
  const documents: string[] = [];
  const shown: SetupFile[] = [];
  for (const f of files) {
    const { pages, text: body } = await readPdf(f.body);
    documents.push(asDocument(f.name, body, pages));
    shown.push({ name: f.name, detail: `PDF · ${pages} ${pages === 1 ? "page" : "pages"}` });
  }
  const before = structuredClone(state);
  state.messages.push({ from: "admin", text: text.trim(), files: shown }, working(ctx.now));
  await writeSetup(tx, ctx, state);
  const { name } = await company(tx);
  const job = { workspaceId: ctx.workspaceId, person: ctx.actor };

  return () =>
    finishReply(job, async () => {
      const current = lastReading(before)?.organization ?? null;
      const everything = [...said(before), text, ...documents].join("\n");
      const reading = await ask(
        setupOrganization,
        { company: name, conversation: conversation(before), current, documents, message: text.trim() },
        { workspaceId: job.workspaceId, personId: job.person.id },
        { check: (o) => checkOrganization(o, everything), building: false },
      );
      const organization: OrgReading = { ...reading, missing: [...reading.missing, ...reading.flags] };
      return { from: "bike", status: "done", text: "Here’s what I collected. Reply to correct anything.", organization };
    });
}

export async function continueToTeam(tx: Tx, ctx: KernelCtx) {
  const state = await openSetup(tx, ctx, "organization");
  const reading = lastReading(state)?.organization;
  if (!reading) throw new KernelError("Tell us about your organization first.");
  await saveOrganization(tx, ctx, reading);
  await writeSetup(tx, ctx, { step: "team", messages: [] });
}

export async function skipOrganization(tx: Tx, ctx: KernelCtx) {
  await openSetup(tx, ctx, "organization");
  await writeSetup(tx, ctx, { step: "team", messages: [] });
}

// ── Team (2d → 2e) ──

// The people the reading starts from: the current team, or the admin alone.
async function knownPeople(tx: Tx, state: SetupState): Promise<TeamPerson[]> {
  const draft = lastReading(state)?.team;
  if (draft) return draft.people;
  const { owner } = await company(tx);
  return [{ key: owner.email, name: owner.name, email: owner.email, title: owner.title, team: null, manager: null, role: "Founder" }];
}

const forPrompt = (list: TeamPerson[]) => {
  const byKey = new Map(list.map((p) => [p.key, p]));
  return list.map((p) => ({ name: p.name, email: p.email, title: p.title, manager: p.manager ? (byKey.get(p.manager)?.email ?? byKey.get(p.manager)?.name ?? null) : (p.managerOutside ?? null), team: p.team }));
};

// More people than this can't be read with a message by the small model; a file alone is read by the kernel.
export const TEAM_READ_LIMIT = 150;

// "I found 14 people in team.xlsx. These are the leads; the other 9 report to them."
export function teamText(d: TeamDraft): string {
  const where = d.file ?? "your message";
  const n = d.people.length;
  const { others } = leadsTable(d);
  const found = `I found ${n} ${n === 1 ? "person" : "people"} in ${where}.`;
  return others ? `${found} These are the leads; the other ${others} report to them.` : `${found} These are the leads.`;
}

export async function sendTeam(tx: Tx, ctx: KernelCtx, text: string, uploadIds: string[]): Promise<Work> {
  const state = await openSetup(tx, ctx, "team");
  if (!text.trim() && !uploadIds.length) throw new KernelError("Type a message first.");
  if (uploadIds.length > 1) throw new KernelError("Attach one team file.");
  const [file] = await openFiles(tx, ctx, uploadIds);
  const table = file ? await readSpreadsheet(file.name, file.body).catch((e) => Promise.reject(e instanceof SheetError ? new KernelError(e.message) : e)) : null;
  const shown: SetupFile[] = file && table ? [{ name: file.name, detail: `${table.length - 1} rows` }] : [];
  const before = structuredClone(state);
  state.messages.push({ from: "admin", text: text.trim(), files: shown }, working(ctx.now));
  await writeSetup(tx, ctx, state);
  const known = await knownPeople(tx, before);
  const { name } = await company(tx);
  const job = { workspaceId: ctx.workspaceId, person: ctx.actor };
  const who = { workspaceId: job.workspaceId, personId: job.person.id };

  return () =>
    finishReply(job, async () => {
      let fromFile: TeamDraft | null = null;
      if (file && table) {
        fromFile = await readTeamFile(file.name, table, who);
        if (!text.trim()) return { from: "bike", status: "done", text: teamText(fromFile), team: fromFile };
      }
      const start = fromFile?.people ?? known;
      if (start.length > TEAM_READ_LIMIT)
        throw new KernelError(`Bike reads corrections for up to ${TEAM_READ_LIMIT} people. Fix the file and send it again on its own.`);
      const everything = [...said(before), text, table ? toCsv(table) : "", ...start.map((p) => p.email ?? "")].join("\n");
      const reading = await ask(setupTeam, { company: name, conversation: conversation(before), known: forPrompt(start), message: text.trim() }, who, { building: false });
      const draft = draftFromReading(reading, everything, start, fromFile?.file ?? lastReading(before)?.team?.file ?? null);
      return { from: "bike", status: "done", text: teamText(draft), team: draft };
    });
}

// A team file by the CSV rules, as a draft for 2e.
async function readTeamFile(name: string, table: string[][], who: { workspaceId: string; personId: string }): Promise<TeamDraft> {
  const check = await checkTeamFile(name, table, who);
  if (!check.rows.length) throw new KernelError(check.problems[0] ?? "I found nobody in that file.");
  return draftFromFile(check, name);
}

export async function finishSetup(tx: Tx, ctx: KernelCtx) {
  const state = await openSetup(tx, ctx, "team");
  const draft = lastReading(state)?.team;
  if (!draft) throw new KernelError("Tell us about your team first.");
  const r = await finishTeam(tx, ctx, draft);
  await writeSetup(tx, ctx, { step: "done", messages: [], done: { leftOut: r.leftOut, noManager: r.noManager } }, { finish: true });
}

// "Skip this step, I'll add people later": setup ends with the admin alone in People.
export async function skipTeam(tx: Tx, ctx: KernelCtx) {
  await openSetup(tx, ctx, "team");
  await writeSetup(tx, ctx, { step: "done", messages: [], done: { leftOut: [], noManager: [] } }, { finish: true });
}
