import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, outbox, reportSends, savedReports } from "@/db/schema";
import { outbox as sent } from "@/server/email/send";
import { sendOutbox, tick } from "@/server/jobs/tick";
import { kernelWorkspace } from "@/tests/kernel";
import { addMessage, readChat, startChat } from "../chats";
import { createRow, moveStep } from "../rows";
import type { CapabilityFile } from "../schema/file";
import { addAdmin, removeAdmin } from "../settings";
import { runReport } from "./run";
import { saveForLater, setSchedule } from "./saved";
import type { ReportQuery } from "./schema";
import { saveReport } from "./store";

// M33 · Scheduled reports, through the hourly job: from 07:00 in the company's time zone a saved report runs again as
// its author, with today's rows; the run is kept in its chat with a short reply; the email with its PDF goes to the
// author alone, once per date. A missed date is sent late, once. A query that can't run sends the reason; an author
// who is no longer an admin gets nothing and the schedule stops.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;
const at = (iso: string) => new Date(iso);
const ASKED = at("2026-11-02T16:00:00Z"); // Mon Nov 2, 10:00 in Chicago
const TEAMS = [{ id: "eng", name: "Engineering" }, { id: "sales", name: "Sales" }];

const file = (): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "purchases",
      name: "Purchases",
      kind: "list",
      titleColumn: "what",
      row: { one: "purchase", many: "purchases" },
      columns: [
        { id: "what", name: "What", type: "text", required: true },
        { id: "team", name: "Team", type: "choice", options: TEAMS },
        { id: "amount", name: "Amount", type: "money" },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "approved", name: "Approved", end: "final" }],
    },
  ],
  roles: [{ id: "admins", name: "Admins", members: { kind: "people", people: [k.id.ada, k.id.priya] }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
  rules: [],
  later: [],
});

const BY_TEAM: ReportQuery = {
  from: [{ capability: "Spend", sheet: "Purchases", as: null }],
  join: [],
  where: null,
  groupBy: [{ column: "Purchases.Team" }],
  measures: [{ fn: "sum", source: "Purchases", column: "Purchases.Amount", where: null, as: "Spent", hidden: false }],
  computed: [],
  orderBy: [{ column: "Spent", dir: "desc" }],
  limit: null,
};

const buy = (what: string, team: string, dollars: number, when = ASKED) =>
  k.as("ada", (tx, c) => createRow(tx, c, spend, "purchases", { values: { what, team, amount: dollars * 100 } }), when).then((r) => k.as("ada", (tx, c) => moveStep(tx, c, r.id, "approved"), when));

// A report asked in chat, as the report job keeps it, then saved and scheduled.
async function asked(who: "ada" | "priya", title: string, query: ReportQuery, every: unknown) {
  const { chatId } = await k.as(who, (tx, c) => startChat(tx, c, "report", { text: `${title}?` }), ASKED);
  const messageId = await k.as(who, (tx, c) => addMessage(tx, c, chatId, { from: "bike", text: "" }), ASKED);
  const result = query === BY_TEAM ? await k.as(who, (tx, c) => runReport(tx, c, query), ASKED) : { columns: [], rows: [], sources: [{ capability: "Spend", sheet: "Purchases", name: "Purchases", read: 0, leftOut: 0 }] };
  const first = await k.as(who, (tx, c) => saveReport(tx, c, { chatId, messageId, title, query, chart: "bar", series: [{ column: "Spent", role: "measure" }], how: ["Spent: approved purchases, added up by team."], missing: null, sentence: "Done.", result, ranAt: ASKED }), ASKED);
  await k.as(who, (tx, c) => saveForLater(tx, c, first.id), ASKED);
  await k.as(who, (tx, c) => setSchedule(tx, c, first.id, every), ASKED);
  return { chatId, first: first.id };
}

const only = () => ({ workspaceId: k.workspaceId });
const queued = () => k.as("ada", (tx) => tx.select().from(outbox).where(eq(outbox.kind, "report")));
const emailsTo = (who: "ada" | "priya") => sent().filter((e) => e.to === k.email(who));

let byTeam: { chatId: string; first: string };

beforeAll(async () => {
  k = await kernelWorkspace();
  await k.as("ada", (tx, c) => addAdmin(tx, c, k.id.priya));
  spend = await k.create(file());
  await buy("Laptop", "eng", 2000);
  await buy("Ads", "sales", 500);
  byTeam = await asked("ada", "Spend by team", BY_TEAM, { unit: "week", weekday: 1 });
});

describe("a weekly report", () => {
  it("waits for 07:00 on its day, then runs again with today's rows, keeps the run in its chat and queues one email", async () => {
    await buy("Monitor", "eng", 300, at("2026-11-05T16:00:00Z")); // after it was asked
    await tick(at("2026-11-09T12:30:00Z"), only()); // Monday 06:30
    expect(await queued()).toEqual([]);
    await tick(at("2026-11-09T13:30:00Z"), only()); // Monday 07:30
    await tick(at("2026-11-09T14:30:00Z"), only()); // again at 08:30: nothing new
    expect(await queued()).toHaveLength(1);

    const { messages } = await k.as("ada", (tx, c) => readChat(tx, c, byTeam.chatId));
    const reply = messages.at(-1)!;
    expect(reply).toMatchObject({ from: "bike", text: "Emailed to you: as of Mon, Nov 9, 07:30.", parts: [{ kind: "report", brief: true }] });
    const sends = await k.as("ada", (tx) => tx.select().from(reportSends));
    expect(sends).toMatchObject([{ onDate: "2026-11-09", refused: null }]);
    const emailed = await k.as("ada", (tx) => tx.select({ details: auditEntries.details, who: auditEntries.who }).from(auditEntries).where(eq(auditEntries.event, "report.emailed")));
    expect(emailed).toEqual([{ who: k.email("ada"), details: { report: "“Spend by team”", to: k.email("ada") } }]);
  });

  it("emails the author the table and its PDF, with today's numbers", async () => {
    await sendOutbox(only());
    const [mail] = emailsTo("ada").filter((e) => e.subject.startsWith("Spend by team"));
    expect(mail!.subject).toBe("Spend by team · as of Mon, Nov 9");
    expect(mail!.text).toContain("$2,300"); // the Monitor bought after it was asked is in
    expect(mail!.text).toContain("3 purchases");
    expect(mail!.attachments).toHaveLength(1);
    expect(mail!.attachments![0]!.name).toBe("Spend by team.pdf");
    expect(Buffer.from(mail!.attachments![0]!.content.slice(0, 4)).toString()).toBe("%PDF");
    expect((await queued()).every((q) => q.sentAt)).toBe(true);
  }, 30_000);

  it("sends a missed Monday late, once, and nothing more until the next Monday", async () => {
    await tick(at("2026-11-18T13:30:00Z"), only()); // Wednesday: Monday Nov 16 was missed
    await tick(at("2026-11-19T13:30:00Z"), only()); // Thursday
    const sends = await k.as("ada", (tx) => tx.select({ on: reportSends.onDate }).from(reportSends));
    expect(sends.map((s) => s.on).sort()).toEqual(["2026-11-09", "2026-11-16"]);
  });
});

describe("a report that can't be emailed", () => {
  it("sends its plain reason when its query no longer runs", async () => {
    const broken: ReportQuery = { ...BY_TEAM, groupBy: [{ column: "Purchases.Region" }] };
    const r = await asked("ada", "Spend by region", broken, { unit: "day" });
    await tick(at("2026-11-20T13:30:00Z"), only());
    const mine = await k.as("ada", (tx) => tx.select({ refused: reportSends.refused }).from(reportSends).innerJoin(savedReports, eq(savedReports.id, reportSends.savedId)).where(eq(savedReports.firstId, r.first)));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.refused).toBeTruthy();
    await sendOutbox(only());
    const mail = emailsTo("ada").find((e) => e.subject === "Spend by region · couldn't run")!;
    expect(mail.text).toContain(`Bike couldn't run “Spend by region” today: ${mine[0]!.refused}`);
    expect(mail.attachments).toBeUndefined();
  });

  it("stops, with nothing sent, when its author is no longer an admin", async () => {
    const r = await asked("priya", "Priya's spend", BY_TEAM, { unit: "day" });
    await k.as("ada", (tx, c) => removeAdmin(tx, c, k.id.priya));
    const before = emailsTo("priya").length;
    await tick(at("2026-11-21T13:30:00Z"), only());
    await sendOutbox(only());
    expect(emailsTo("priya")).toHaveLength(before);
    const [saved] = await k.as("priya", (tx) => tx.select({ why: savedReports.stoppedWhy }).from(savedReports).where(eq(savedReports.firstId, r.first)));
    expect(saved!.why).toBe("Its author is no longer an admin.");
    const stopped = await k.as("ada", (tx) => tx.select({ who: auditEntries.who, details: auditEntries.details }).from(auditEntries).where(eq(auditEntries.event, "report.unscheduled")));
    expect(stopped).toEqual([{ who: "system", details: { report: "“Priya's spend”", why: "Its author is no longer an admin." } }]);
  });

  it("is never sent from another workspace's job", async () => {
    const other = await kernelWorkspace();
    const count = (await k.as("ada", (tx) => tx.select().from(reportSends))).length;
    await tick(at("2026-11-23T13:30:00Z"), { workspaceId: other.workspaceId });
    expect(await k.as("ada", (tx) => tx.select().from(reportSends))).toHaveLength(count);
  });
});
