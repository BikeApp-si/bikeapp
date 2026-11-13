import { AiError, ask, NoModel, TRY_AGAIN } from "@/server/ai/gateway";
import { dayIn, formatDay } from "@/lib/format";
import { reportSentence } from "@/server/ai/prompts/report-sentence@1";
import { reportWriter } from "@/server/ai/prompts/report-writer@3";
import { readChat, touchChat, updateMessage, type Message, type Part } from "@/server/kernel/chats";
import { load, todayIn, type KernelCtx } from "@/server/kernel/context";
import { planContext } from "@/server/kernel/plans/context";
import { toDraft, toQuery } from "@/server/kernel/report/draft";
import { reportFacts } from "@/server/kernel/report/facts";
import { checkQuery, outputNames, runReport, visibleFiles } from "@/server/kernel/report/run";
import type { ReportQuery, ReportResult } from "@/server/kernel/report/schema";
import { capabilitiesOf, getReport, reportsIn, saveReport, type StoredReport } from "@/server/kernel/report/store";
import { allowedNumbers, checkSentence, tidyBold } from "@/server/kernel/report/view";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { currentTime } from "@/server/kernel/clock";

// A question about data on Home (11a–11g): prompt 7 writes the query, the kernel checks it and runs it with
// the admin's access, prompt 7's sentence reads the result table, and the run is kept with the chat. The
// Step / Status list moves as it goes (11b). A reply in a report chat changes the report (11e). Run again
// runs the same query now and sets it beside the first run (12d).

export type ReportJob = {
  workspaceId: string;
  person: { id: string; email: string };
  chatId: string;
  replyId: string;
  text: string;
  again: { reportId: string } | null;
};

type K = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => Promise<T>;

const rowWordsOf = async (tx: Tx) => {
  const loaded = await load(tx);
  return (sheet: string) => {
    for (const f of loaded.files.values()) {
      const s = f.file.sheets.find((x) => x.name === sheet);
      if (s) return s.row ?? { one: "row", many: "rows" };
    }
    return { one: "row", many: "rows" };
  };
};

const readLabel = (r: ReportResult, words: (sheet: string) => { one: string; many: string }) => {
  const s = r.sources[0];
  if (!s) return "";
  const w = words(s.sheet);
  return `${s.read.toLocaleString("en-US")} ${s.read === 1 ? w.one : w.many}`;
};

const table = (r: ReportResult) => ({
  columns: r.columns.map((c) => c.name),
  rows: r.rows.slice(0, Math.max(1, Math.floor(50 / Math.max(1, r.columns.length)))),
  totals: Object.fromEntries(r.columns.flatMap((c, i) => (c.format === "money" || c.format === "number" ? [[c.name, r.rows.reduce((n, row) => n + (typeof row[i] === "number" ? (row[i] as number) : 0), 0)]] : []))),
});

// Earlier report replies shrink to their first sentence once a newer one follows (11e, 12d).
async function shrinkEarlier(k: K, chatId: string, replyId: string) {
  const { messages } = await k((tx, c) => readChat(tx, c, chatId));
  for (const m of messages) {
    if (m.id === replyId || m.from !== "bike" || !m.parts.some((p) => p.kind === "report") || m.parts.some((p) => p.kind === "collapsed")) continue;
    const first = /^.*?[.!?](\s|$)/.exec(m.text)?.[0]?.trim() ?? m.text;
    await k((tx, c) => updateMessage(tx, c, m.id, { parts: [...m.parts, { kind: "collapsed", text: `${first.replace(/\*\*/g, "")} …` }] }));
  }
}

export async function runReportJob(job: ReportJob): Promise<void> {
  const ctx: KernelCtx = { workspaceId: job.workspaceId, actor: job.person };
  const k: K = (fn) => withWorkspace({ workspaceId: job.workspaceId, personId: job.person.id }, (tx) => fn(tx, ctx));
  const who = { workspaceId: job.workspaceId, personId: job.person.id, chatId: job.chatId };
  const labels = ["Understand the question", "Find the data", "Add up the rows", "Draw the chart"];
  const progress = (upTo: number): Part => ({ kind: "status", head: "Step", rows: labels.map((label, i) => ({ label, state: i < upTo ? "done" : i === upTo ? "doing" : "next" })) });
  const say = (parts: Part[], text = "Working on it.") => k((tx, c) => updateMessage(tx, c, job.replyId, { parts, text }));

  try {
    const words = await k((tx) => rowWordsOf(tx));
    if (job.again) return await again(k, job, who, words);
    await say([progress(0)]);
    const pc = await k(planContext);
    const visible = await k((tx, c) => visibleFiles(tx, c));
    const loaded = await k((tx) => load(tx));
    const now = currentTime();
    const today = todayIn(loaded.timeZone, now);
    const facts = await k((tx, c) => reportFacts(tx, c, now));
    const { messages } = await k((tx, c) => readChat(tx, c, job.chatId));
    const before = messages.filter((m) => m.id !== job.replyId && m.status !== "working").slice(0, -1);
    const conversation = before.map((m: Message) => ({ from: m.from, text: m.text })).filter((m) => m.text);
    const runs = await k((tx, c) => reportsIn(tx, c, job.chatId));
    const current = runs.filter((r) => !r.firstId).at(-1) ?? null;

    let query: ReportQuery | null = null;
    const out = await ask(
      reportWriter,
      {
        company: { name: pc.company.name, timeZone: loaded.timeZone },
        today,
        user: pc.user.name,
        capabilities: pc.existing,
        facts,
        people: pc.people.map((p) => p.name),
        conversation,
        currentReport: current ? { title: current.title, query: toDraft(current.query), chart: { kind: current.chart, series: current.series } } : null,
        latestMessage: job.text,
        formats: loaded.formats,
      },
      who,
      {
        check: (o) => {
          const t = toQuery(o.query);
          if (!t.query) return t.problems;
          const problems = checkQuery(t.query, visible);
          const names = new Set(outputNames(t.query).map((n) => n.toLowerCase()));
          for (const s of o.chart.series) if (!names.has(s.column.toLowerCase())) problems.push(`The chart draws “${s.column}”, which isn't a column of the report.`);
          query = t.query;
          return problems;
        },
      },
    );
    const q = query!;
    labels[1] = `Find the data in ${[...new Set(q.from.map((f) => f.capability))].join(" and ")}`;
    await say([progress(2)]);

    const result = await k((tx, c) => runReport(tx, c, q, { asOf: now }));
    const read = readLabel(result, words);
    const group = q.groupBy[0] ? ("month" in q.groupBy[0] ? "month" : q.groupBy[0].column.split(".")[1]!.toLowerCase()) : null;
    labels[2] = `Add up ${read}${group ? ` by ${group}` : ""}`;
    await say([progress(3)]);

    const how = out.how.map((line, i) => (i === 0 && read ? `${line.replace(/\s*$/, "")} ${read}.` : line));
    const sentence = await ask(
      reportSentence,
      { question: job.text, title: out.title, today, how, missing: out.missing, table: table(result), rowsRead: read, previous: null, formats: loaded.formats },
      who,
      { check: (o) => checkSentence(o.sentence, allowedNumbers(result, [job.text, ...how, out.missing ?? "", today])), building: false },
    );
    const saved = await k((tx, c) =>
      saveReport(tx, c, { chatId: job.chatId, messageId: job.replyId, title: out.title, query: q, chart: out.chart.kind, series: out.chart.series, how, missing: out.missing, sentence: tidyBold(sentence.sentence), result, ranAt: now }),
    );
    await k(async (tx, c) => {
      await updateMessage(tx, c, job.replyId, { text: tidyBold(sentence.sentence), parts: [{ kind: "report", reportId: saved.id }], status: "done" });
      await touchChat(tx, c, job.chatId, { title: out.title, capabilityIds: capabilitiesOf(result).flatMap((n) => [...visible.values()].filter((v) => v.file.name === n).map((v) => v.id)) });
    });
    await shrinkEarlier(k, job.chatId, job.replyId);
  } catch (e) {
    if (!(e instanceof AiError)) console.error(e);
    await k((tx, c) => updateMessage(tx, c, job.replyId, { text: e instanceof AiError ? e.message : TRY_AGAIN, parts: [], status: "failed" }));
  }
}

export const RAN_AGAIN = "Today’s numbers, beside the first run.";

// Run again (12d): the first run's query, now, beside the first run.
async function again(k: K, job: ReportJob, who: { workspaceId: string; personId: string; chatId: string }, words: (sheet: string) => { one: string; many: string }) {
  const asked = await k((tx, c) => getReport(tx, c, job.again!.reportId));
  const first: StoredReport = asked.firstId ? await k((tx, c) => getReport(tx, c, asked.firstId!)) : asked;
  const loaded = await k((tx) => load(tx));
  const now = currentTime();
  const today = todayIn(loaded.timeZone, now);
  const result = await k((tx, c) => runReport(tx, c, first.query, { asOf: now }));
  const read = readLabel(result, words);
  const day = (d: Date) => formatDay(dayIn(d, loaded.timeZone), loaded.formats);
  // With no model (O3), the numbers are run again all the same, without the sentence the model writes.
  const sentence = await ask(
    reportSentence,
    { question: first.title, title: first.title, today, how: first.how, missing: first.missing, table: table(result), rowsRead: read, previous: { ranOn: day(first.ranAt), table: table(first.result) }, formats: loaded.formats },
    who,
    { check: (o) => checkSentence(o.sentence, allowedNumbers(result, [first.title, ...first.how, first.missing ?? "", today, day(first.ranAt)], first.result)), building: false },
  ).catch((e) => {
    if (e instanceof NoModel) return { sentence: RAN_AGAIN };
    throw e;
  });
  const saved = await k((tx, c) =>
    saveReport(tx, c, { chatId: job.chatId, messageId: job.replyId, firstId: first.id, title: first.title, query: first.query, chart: first.chart, series: first.series, how: first.how, missing: first.missing, sentence: tidyBold(sentence.sentence), result, ranAt: now }),
  );
  await k((tx, c) => updateMessage(tx, c, job.replyId, { text: tidyBold(sentence.sentence), parts: [{ kind: "report", reportId: saved.id }], status: "done" }));
  await shrinkEarlier(k, job.chatId, job.replyId);
}
