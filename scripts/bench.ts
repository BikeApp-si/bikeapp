// The kernel study's bench (M11): times what each screen asks the kernel for, on the bench company
// (pnpm bench:seed), as an admin (Wade), a manager (Priya, her team) and an employee (Maya, her own rows).
// Writes happen inside a transaction that is rolled back, so the company is the same for every run.
// Usage: pnpm bench [--runs 10] [--only table]
// Prints a table and writes tmp/bench/<date>-<rows>.json, for M12 to compare before and after.
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import postgres from "postgres";

try { process.loadEnvFile(); } catch {}
const { BENCH_DATABASE_URL, BENCH_DATABASE_ADMIN_URL, mustBeLocal } = await import("./bench-seed");
process.env.DATABASE_URL = BENCH_DATABASE_URL();
mustBeLocal(process.env.DATABASE_URL);
process.env.BIKE_BENCH = "1";
const { TODAY } = await import("@/seed/capabilities/seeder");
process.env.BIKE_TODAY ??= TODAY;

const { benchQueries, closeDb } = await import("@/db/client");
const { withWorkspace } = await import("@/server/kernel/tx");
const { listRows, sheetTotals, updateRow, moveStep } = await import("@/server/kernel/rows");
const { namesFor } = await import("@/server/kernel/views");
const { waitsOnRows, waitingFor, waitingCounts } = await import("@/server/kernel/waiting");
const { queueMorningEmails } = await import("@/server/kernel/morning");
const { updatesFor, waitingOnOthers } = await import("@/server/kernel/inbox");
const { runDateRules, systemCtx } = await import("@/server/kernel/date-rules");
const { previewRule } = await import("@/server/kernel/preview");
const { runReport } = await import("@/server/kernel/report/run");
const { exportCapability } = await import("@/server/kernel/export");
const { panelRow } = await import("@/app/ws/[ws]/(app)/c/[cap]/panel");
const { currentTime } = await import("@/server/kernel/clock");
const { load } = await import("@/server/kernel/context");
type Tx = import("@/server/kernel/tx").Tx;
type KernelCtx = import("@/server/kernel/context").KernelCtx;
type Filter = import("@/server/kernel/query").Filter;
type Sort = import("@/server/kernel/query").Sort;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const RUNS = Number(arg("runs") ?? 10);
const only = arg("only");

// What the bench needs from the bench company, read as its owner.
const admin = postgres(BENCH_DATABASE_ADMIN_URL(), { max: 1, onnotice: () => {} });
const [fw] = await admin`select id from workspaces where subdomain = 'fernwood'`;
const ws = fw!.id as string;
const person = async (email: string) => (await admin`select id, email from people where workspace_id = ${ws} and email = ${email}`)[0]!;
const cap = async (name: string) => (await admin`select id from capabilities where workspace_id = ${ws} and name = ${name} and deleted_at is null`)[0]!.id as string;
const who = { wade: await person("wade@fernwood.dev"), priya: await person("priya@fernwood.dev"), maya: await person("maya@fernwood.dev"), lena: await person("lena@fernwood.dev") };
const ids = { spend: await cap("Spend"), contracts: await cap("Customer contracts"), hiring: await cap("Hiring"), timeOff: await cap("Time off"), wide: await cap("Admissions") };
const anyRow = async (capId: string, sheet: string, where = admin``) =>
  (await admin`select id from rows where capability_id = ${capId} and sheet_id = ${sheet} and deleted_at is null ${where} order by seq desc limit 1`)[0]!.id as string;
const purchase = await anyRow(ids.spend, "purchases");
const line = await anyRow(ids.spend, "purchase_lines");
const expense = await anyRow(ids.spend, "expenses", admin`and data->>'who' = ${who.maya.id}`);
const contract = await anyRow(ids.contracts, "contracts", admin`and step_id = 'active'`);
const { rows: [file] } = { rows: await admin`select v.file from capabilities c join capability_versions v on v.capability_id = c.id and v.version = c.current_version where c.id = ${ids.contracts}` };
const remindRule = (file!.file as { rules: { id: string }[] }).rules.find((r) => r.id === "remind_owner")!;
// A step rule: its preview reads the Audit log for the moves (Spend: "when an expense is submitted, ask Lena").
const [spendFile] = await admin`select v.file from capabilities c join capability_versions v on v.capability_id = c.id and v.version = c.current_version where c.id = ${ids.spend}`;
const stepRule = (spendFile!.file as { rules: { id: string }[] }).rules.find((r) => r.id === "to_lena")!;
// M25: Admissions, a capability at every limit (bench:seed's addWide). An application at Interaction moves to
// Offer: a notify, a note added and a wait start there. Its fee changing runs the fee rule.
const application = await anyRow(ids.wide, "applications", admin`and step_id = 'interaction'`);
const [wideFile] = await admin`select v.file from capabilities c join capability_versions v on v.capability_id = c.id and v.version = c.current_version where c.id = ${ids.wide}`;
const chaseRule = (wideFile!.file as { rules: { id: string }[] }).rules.find((r) => r.id === "chase_30")!;
const [report] = await admin`select query from reports where workspace_id = ${ws} order by ran_at limit 1`;
const counts = await admin`select count(*)::int as rows, (select count(*)::int from people where workspace_id = ${ws}) as people from rows where workspace_id = ${ws} and deleted_at is null`;
await admin.end();

const as = (p: { id: string; email: string }): { personId: string; ctx: KernelCtx } => ({ personId: p.id, ctx: { workspaceId: ws, actor: { id: p.id, email: p.email } } });
class Rollback extends Error {}

// One path: a kernel call in its own transaction, as one person; `write` rolls it back afterwards.
type Path = { name: string; who: string; runs?: number; write?: boolean; system?: boolean; run: (tx: Tx, ctx: KernelCtx) => Promise<unknown> };
const PAGE = 100;
type Opts = { filters?: Filter[]; sort?: Sort };
const table = (capId: string, sheet: string, o: Opts = {}) => async (tx: Tx, ctx: KernelCtx) => {
  // As the capability page does (app/ws/[ws]/(app)/c/[cap]/actions.ts, loadRows).
  const file = (await load(tx)).files.get(capId)!.file;
  const list = await listRows(tx, ctx, capId, sheet, { limit: PAGE, offset: 0, filters: o.filters, sort: o.sort });
  await namesFor(tx, ctx, file.sheets.find((s) => s.id === sheet)!, list);
  await sheetTotals(tx, ctx, capId, sheet, { filters: o.filters });
  await waitsOnRows(tx, ctx, capId, sheet, list.map((r) => r.id));
};
const PATHS: Path[] = [
  { name: "table: Spend purchases (first page)", who: "wade", run: table(ids.spend, "purchases") },
  { name: "table: Spend purchases, filtered", who: "wade", run: table(ids.spend, "purchases", { filters: [{ column: "what", op: "contains", text: "laptop" }] }) },
  { name: "table: Spend purchases, sorted by total", who: "wade", run: table(ids.spend, "purchases", { sort: { column: "total", dir: "desc" } }) },
  { name: "table: Spend expenses (own rows)", who: "maya", run: table(ids.spend, "expenses") },
  { name: "table: Hiring candidates (team)", who: "priya", run: table(ids.hiring, "candidates") },
  { name: "open a row (purchase)", who: "wade", run: (tx, ctx) => panelRow(tx, ctx, purchase) },
  { name: "save a row (expense, rules run)", who: "maya", write: true, run: (tx, ctx) => updateRow(tx, ctx, expense, { note: "Bench edit" }) },
  { name: "edit a purchase line (total recomputed)", who: "wade", write: true, run: (tx, ctx) => updateRow(tx, ctx, line, { quantity: 3 }) },
  { name: "move a step (contract → Renewal due)", who: "wade", write: true, run: (tx, ctx) => moveStep(tx, ctx, contract, "renewal_due") },
  { name: "Waiting on me (list)", who: "priya", run: (tx, ctx) => waitingFor(tx, ctx) },
  { name: "bubbles (counts)", who: "lena", run: (tx, ctx) => waitingCounts(tx, ctx) },
  { name: "Inbox: Waiting on others", who: "maya", run: (tx, ctx) => waitingOnOthers(tx, ctx) },
  { name: "Inbox: Updates (own rows)", who: "maya", run: (tx, ctx) => updatesFor(tx, ctx) },
  { name: "Inbox: Updates (imported every row)", who: "wade", run: (tx, ctx) => updatesFor(tx, ctx) },
  { name: "morning emails (queue)", who: "system", system: true, write: true, runs: 3, run: (tx, ctx) => queueMorningEmails(tx, ctx) },
  { name: "daily date job", who: "system", system: true, write: true, runs: 1, run: (tx, ctx) => runDateRules(tx, ctx) },
  { name: "90-day preview (contract reminder)", who: "wade", runs: 3, run: (tx, ctx) => previewRule(tx, ctx, ids.contracts, remindRule as never) },
  { name: "90-day preview (step rule, Audit log)", who: "wade", runs: 3, run: (tx, ctx) => previewRule(tx, ctx, ids.spend, stepRule as never) },
  { name: "report (first seeded question)", who: "wade", runs: 3, run: (tx, ctx) => runReport(tx, ctx, report!.query as never) },
  { name: "CSV export (Spend)", who: "wade", runs: 3, run: (tx, ctx) => exportCapability(tx, ctx, ids.spend) },
  { name: "wide: table, Admissions applications", who: "wade", run: table(ids.wide, "applications") },
  { name: "wide: table, own applications", who: "maya", run: table(ids.wide, "applications") },
  { name: "wide: open an application", who: "wade", run: (tx, ctx) => panelRow(tx, ctx, application) },
  { name: "wide: save (fee changed, 20 rules)", who: "wade", write: true, run: (tx, ctx) => updateRow(tx, ctx, application, { fee: 1_800_000 }) },
  { name: "wide: move to Offer (3 rules act)", who: "wade", write: true, run: (tx, ctx) => moveStep(tx, ctx, application, "offer") },
  { name: "wide: 90-day preview (date rule)", who: "wade", runs: 3, run: (tx, ctx) => previewRule(tx, ctx, ids.wide, chaseRule as never) },
  { name: "wide: CSV export (6 sheets)", who: "wade", runs: 3, run: (tx, ctx) => exportCapability(tx, ctx, ids.wide) },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
// "select … where id = $1" and "select … where id = $2" are the same shape: numbers and quoted values out.
const shape = (q: string) => q.replace(/\$\d+/g, "?").replace(/'[^']*'/g, "?").replace(/\s+/g, " ").slice(0, 140);

const results = [];
for (const p of PATHS.filter((p) => !only || p.name.includes(only))) {
  const times: number[] = [];
  let queries = 0;
  let shapes = new Map<string, number>();
  let failed: string | null = null;
  for (let i = 0; i < (p.runs ?? RUNS); i++) {
    const { personId, ctx } = p.system ? { personId: null, ctx: systemCtx(ws, currentTime()) } : as(who[p.who as keyof typeof who] as { id: string; email: string });
    benchQueries().length = 0;
    const t = performance.now();
    try {
      await withWorkspace({ workspaceId: ws, personId }, async (tx) => {
        await p.run(tx, ctx);
        if (p.write) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) {
        failed = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    times.push(performance.now() - t);
    queries = benchQueries().length;
    shapes = new Map();
    for (const q of benchQueries()) shapes.set(shape(q), (shapes.get(shape(q)) ?? 0) + 1);
  }
  const top = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([q, n]) => ({ n, q }));
  const r = { path: p.name, who: p.who, runs: times.length, p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), queries, top, failed };
  results.push(r);
  console.log(`${r.path.padEnd(40)} ${r.who.padEnd(7)} p50 ${String(r.p50).padStart(7)} ms   p95 ${String(r.p95).padStart(7)} ms   ${String(r.queries).padStart(6)} queries${failed ? `   FAILED: ${failed}` : ""}`);
}
await closeDb();

mkdirSync("tmp/bench", { recursive: true });
const file2 = `tmp/bench/${new Date().toISOString().slice(0, 10)}-${counts[0]!.rows}.json`;
writeFileSync(file2, JSON.stringify({ at: new Date().toISOString(), rows: counts[0]!.rows, people: counts[0]!.people, results }, null, 2));
console.log(`\n${counts[0]!.rows.toLocaleString("en-US")} rows, ${counts[0]!.people} people. Wrote ${file2}`);
process.exit(0);
