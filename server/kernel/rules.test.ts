import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { aiSteps, auditEntries, outbox, rows, waits } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { saveVersion } from "./capabilities";
import type { CapabilityFile, Rule } from "./schema/file";
import { createRow, getRow, importRows, moveStep, updateRow } from "./rows";
import type { Tx } from "./tx";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let hiring: string;
let onboarding: string;
const NOW = new Date("2026-10-27T15:00:00Z");

const rule = (id: string, r: Omit<Rule, "id" | "text" | "reading" | "enabled">): Rule => ({ id, text: id, reading: { when: "w", then: "t" }, enabled: true, ...r });

function onboardingFile(): CapabilityFile {
  return {
    name: "Onboarding",
    icon: "user-check",
    sheets: [
      {
        id: "plans",
        name: "Plans",
        kind: "list",
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "manager", name: "Manager", type: "person" },
        ],
      },
    ],
    roles: [],
    rules: [],
    later: [],
  };
}

// Candidates with a referrer, an interview score, an approval decision and steps; Maya may add and move only
// out of Applied (her own referrals).
function hiringFile(rules: Rule[]): CapabilityFile {
  return {
    name: "Hiring",
    icon: "briefcase",
    sheets: [
      {
        id: "candidates",
        name: "Candidates",
        kind: "list",
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "referrer", name: "Referred by", type: "person", default: { kind: "creator" } },
          { id: "score", name: "Score", type: "number" },
          { id: "offer", name: "Offer", type: "money" },
          { id: "approval", name: "Offer approval", type: "choice", options: [{ id: "approved", name: "Approved" }, { id: "declined", name: "Declined" }] },
          { id: "stage", name: "Stage", type: "step" },
        ],
        steps: [
          { id: "applied", name: "Applied", start: true },
          { id: "screen", name: "Screen" },
          { id: "offer", name: "Offer" },
          { id: "hired", name: "Hired", end: "final" },
          { id: "rejected", name: "Rejected", end: "exit" },
        ],
      },
    ],
    roles: [
      { id: "recruiting", name: "Recruiting", members: { kind: "people", people: [k.id.ada, k.id.priya] }, can: ["see", "add", "edit", "move_steps"], scope: "all" },
      { id: "referrers", name: "Referrers", members: { kind: "people", people: [k.id.maya] }, can: ["see", "add", "move_steps"], moveFrom: ["applied"], scope: "own", scopeColumns: { candidates: { column: "referrer" } } },
    ],
    rules,
    later: [],
  };
}

const RULES = (): Rule[] => [
  rule("screen_new", { trigger: { kind: "row_created", sheet: "candidates" }, actions: [{ kind: "move_to_step", step: "screen" }] }),
  rule("ask_manager", { trigger: { kind: "enters_step", sheet: "candidates", step: "screen" }, actions: [{ kind: "ask_person", managerOf: "referrer", step: "screen", label: "Screen them" }] }),
  rule("onboard", {
    trigger: { kind: "enters_step", sheet: "candidates", step: "hired" },
    actions: [{ kind: "create_row_in", target: { capability: "ONBOARDING", sheet: "plans" }, map: { name: { col: "name" }, manager: { col: "referrer" } } }],
  }),
  rule("scored", { trigger: { kind: "field_changed", sheet: "candidates", field: "score" }, condition: { op: "gte", args: [{ col: "score" }, 3] }, actions: [{ kind: "notify", columns: ["referrer"], message: "Good score." }] }),
  rule("big_offer", {
    trigger: { kind: "enters_step", sheet: "candidates", step: "offer" },
    condition: { op: "gt", args: [{ col: "offer" }, 15_000_000] },
    actions: [{ kind: "ask_person", person: k.id.ada, label: "Approve the offer", decision: { column: "approval", approve: "approved", decline: "declined" } }, { kind: "ai_step", question: "Is the offer fair?" }],
  }),
];

beforeAll(async () => {
  k = await kernelWorkspace();
  onboarding = await k.create(onboardingFile());
  hiring = await k.create(JSON.parse(JSON.stringify(hiringFile(RULES())).replaceAll("ONBOARDING", onboarding)));
});

const add = (who: "ada" | "maya" | "priya", values: Record<string, unknown>) => k.as(who, (tx, c) => createRow(tx, c, hiring, "candidates", { values }), NOW);
const openWaits = (tx: Tx, rowId: string) => tx.select().from(waits).where(and(eq(waits.rowId, rowId), isNull(waits.clearedAt))).orderBy(asc(waits.createdAt));
const entriesSince = (tx: Tx, seq: number) => tx.select().from(auditEntries).where(gt(auditEntries.seq, seq)).orderBy(asc(auditEntries.seq));
const lastSeq = (tx: Tx) => tx.select({ seq: auditEntries.seq }).from(auditEntries).orderBy(asc(auditEntries.seq)).then((r) => r.at(-1)?.seq ?? 0);

describe("rules in the write", () => {
  it("row_created and enters_step run in file order, as the rule, even past the person's own role", async () => {
    // Maya may only move her referrals out of Applied, yet the rule moves hers to Screen and asks her manager.
    const { id } = await add("maya", { name: "Hannah Cole" });
    await k.as("ada", async (tx) => {
      const row = (await tx.select().from(rows).where(eq(rows.id, id)))[0]!;
      expect(row.stepId).toBe("screen");
      const [w] = await openWaits(tx, id);
      expect(w).toMatchObject({ personId: k.id.priya, ruleId: "ask_manager", stepId: "screen", label: "Screen them", why: "you are Maya’s manager" });
    });
  });

  it("writes the person's entry first, then one rule.ran per rule, as rule:<id>", async () => {
    const seq = await k.as("ada", lastSeq);
    await add("maya", { name: "Eli Brooks" });
    const entries = await k.as("ada", (tx) => entriesSince(tx, seq));
    expect(entries.map((e) => [e.who, e.event])).toEqual([
      [k.email("maya"), "row.created"],
      ["rule:screen_new", "rule.ran"],
      ["rule:ask_manager", "rule.ran"],
    ]);
    expect(entries[1]!.details).toMatchObject({ sheet: "Candidates", row: "Eli Brooks", did: "moved Applied → Screen" });
    expect(entries[2]!.details).toMatchObject({ did: "asked Priya Nair" });
  });

  it("field_changed runs on an edit, with its condition, and notify goes to the outbox", async () => {
    const { id } = await add("priya", { name: "Ravi Menon", referrer: k.id.maya });
    await k.as("priya", (tx, c) => updateRow(tx, c, id, { score: 2 }), NOW);
    await k.as("priya", (tx, c) => updateRow(tx, c, id, { score: 4 }), NOW);
    const mail = await k.as("ada", (tx) => tx.select().from(outbox).where(eq(outbox.personId, k.id.maya)));
    expect(mail.map((m) => (m.payload as { row: string }).row)).toEqual(["Ravi Menon"]);
  });

  it("leaving a step ends the waits at it", async () => {
    const { id } = await add("maya", { name: "Lucy Ward" });
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "offer"), NOW);
    expect(await k.as("ada", (tx) => openWaits(tx, id))).toEqual([]);
  });

  it("starts a row in another capability: connection.created there, and the write's entry says so", async () => {
    const { id } = await add("priya", { name: "Leo Grant", referrer: k.id.priya });
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "offer"), NOW);
    const seq = await k.as("ada", lastSeq);
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "hired"), NOW);
    const entries = await k.as("ada", (tx) => entriesSince(tx, seq));
    expect(entries.map((e) => e.event)).toEqual(["row.step", "rule.ran", "connection.created"]);
    expect(entries[0]!.details).toMatchObject({ then: "started 1 row in Onboarding" });
    expect(entries[2]).toMatchObject({ who: "rule:onboard", capabilityId: onboarding });
    expect(entries[2]!.details).toMatchObject({ from: "Hiring/Candidates/Leo Grant", to: "Plans/Leo Grant", copied: "copied Name, Manager" });
    const plans = await k.as("ada", (tx) => tx.select().from(rows).where(eq(rows.capabilityId, onboarding)));
    expect(plans.map((p) => p.data)).toEqual([{ name: "Leo Grant", manager: k.id.priya }]);
  });

  it("asks for a decision and queues an AI step; nobody else moves the row on until the person decides", async () => {
    const { id } = await add("priya", { name: "Sam Okafor", offer: 16_800_000 });
    await k.as("priya", (tx, c) => moveStep(tx, c, id, "offer"), NOW);
    await k.as("ada", async (tx) => {
      const ws = await openWaits(tx, id);
      expect(ws.map((w) => [w.personId, w.ruleId, w.stepId])).toEqual([[k.id.ada, "big_offer", "offer"]]);
      expect(await tx.select().from(aiSteps).where(eq(aiSteps.rowId, id))).toHaveLength(1);
    });
    await expect(k.as("priya", (tx, c) => moveStep(tx, c, id, "hired"), NOW)).rejects.toThrow("Sam Okafor is waiting on Ada Admin to decide.");
  });

  it("an import runs rules but notify sends no email", async () => {
    const before = await k.as("ada", (tx) => tx.$count(outbox));
    const [id] = await k.as("ada", (tx, c) => importRows(tx, c, hiring, "candidates", [{ values: { name: "Nina Park", referrer: k.id.maya, score: 4, stage: "applied" } }], { source: "c.csv" }), NOW);
    await k.as("ada", (tx, c) => updateRow(tx, c, id!, { score: 3 }), NOW);
    // The edit after the import does email (score ≥ 3); the import itself sent nothing.
    expect(await k.as("ada", (tx) => tx.$count(outbox))).toBe(before + 1);
    expect((await k.as("ada", (tx, c) => getRow(tx, c, id!))).stepId).toBe("screen");
  });
});

describe("levels", () => {
  it("stops after 3 rules in a row and says so", async () => {
    // a → b → c → d: each move triggers the next; d would be level 4.
    const chain: CapabilityFile = {
      name: "Chain",
      icon: "link",
      sheets: [
        {
          id: "s",
          name: "S",
          kind: "list",
          titleColumn: "t",
          columns: [{ id: "t", name: "T", type: "text" }, { id: "st", name: "St", type: "step" }],
          steps: ["a", "b", "c", "d", "e"].map((id, i) => ({ id, name: id.toUpperCase(), ...(i === 0 ? { start: true as const } : {}), ...(i === 4 ? { end: "final" as const } : {}) })),
        },
      ],
      roles: [{ id: "all", name: "All", members: { kind: "everyone" }, can: ["see", "add"], scope: "all" }],
      rules: [
        rule("to_b", { trigger: { kind: "row_created", sheet: "s" }, actions: [{ kind: "move_to_step", step: "b" }] }),
        rule("to_c", { trigger: { kind: "enters_step", sheet: "s", step: "b" }, actions: [{ kind: "move_to_step", step: "c" }] }),
        rule("to_d", { trigger: { kind: "enters_step", sheet: "s", step: "c" }, actions: [{ kind: "move_to_step", step: "d" }] }),
        rule("to_e", { trigger: { kind: "enters_step", sheet: "s", step: "d" }, actions: [{ kind: "move_to_step", step: "e" }] }),
      ],
      later: [],
    };
    const cap = await k.create(chain);
    const seq = await k.as("ada", lastSeq);
    const { id } = await k.as("maya", (tx, c) => createRow(tx, c, cap, "s", { values: { t: "x" } }), NOW);
    expect((await k.as("maya", (tx, c) => getRow(tx, c, id))).stepId).toBe("d");
    const stopped = (await k.as("ada", (tx) => entriesSince(tx, seq))).find((e) => e.who === "rule:to_e");
    expect(stopped?.details).toMatchObject({ stopped: "not run: more than 3 rules in a row" });
  });
});

describe("determinism", () => {
  it("the same writes give the same rows, waits and entries", async () => {
    const run = async () => {
      const w = await kernelWorkspace();
      const onb = await w.create(onboardingFile());
      const file = JSON.parse(JSON.stringify(hiringFile(RULES())).replaceAll("ONBOARDING", onb).replaceAll(k.id.ada, w.id.ada).replaceAll(k.id.priya, w.id.priya).replaceAll(k.id.maya, w.id.maya));
      const cap = await w.create(file);
      const { id } = await w.as("maya", (tx, c) => createRow(tx, c, cap, "candidates", { values: { name: "A" } }), NOW);
      await w.as("priya", (tx, c) => moveStep(tx, c, id, "offer"), NOW);
      await w.as("priya", (tx, c) => moveStep(tx, c, id, "hired"), NOW);
      return w.as("ada", async (tx) => {
        const names = new Map(Object.entries(w.id).map(([n, pid]) => [pid, n]));
        const all = await tx.select().from(auditEntries).where(gt(auditEntries.seq, 0)).orderBy(asc(auditEntries.seq));
        const ws = await tx.select().from(waits).orderBy(asc(waits.createdAt));
        return {
          audit: all.filter((e) => e.event !== "capability.created" && !e.event.startsWith("people") && !e.event.startsWith("workspace")).map((e) => [e.who.replace(/@.*/, ""), e.event, JSON.stringify(e.details)]),
          waits: ws.map((x) => [names.get(x.personId), x.ruleId, x.stepId, !!x.clearedAt]),
        };
      });
    };
    expect(await run()).toEqual(await run());
  });
});

describe("saving a rule change", () => {
  it("keeps running the current file's rules", async () => {
    const file = JSON.parse(JSON.stringify(hiringFile([]))) as CapabilityFile;
    await k.as("ada", (tx, c) => saveVersion(tx, c, hiring, file, { source: "customize", event: "customize.saved" }), NOW);
    const { id } = await add("maya", { name: "No rules now" });
    expect((await k.as("maya", (tx, c) => getRow(tx, c, id))).stepId).toBe("applied");
  });
});

describe("a field map that names the row itself", () => {
  it("adds three interviews linked to the candidate who moved to Interview (6g)", async () => {
    const file: CapabilityFile = {
      name: "Interviewing",
      icon: "briefcase",
      sheets: [
        {
          id: "candidates",
          name: "Candidates",
          kind: "list",
          titleColumn: "name",
          columns: [
            { id: "name", name: "Name", type: "text", required: true },
            { id: "stage", name: "Stage", type: "step" },
          ],
          steps: [{ id: "applied", name: "Applied", start: true }, { id: "interview", name: "Interview" }, { id: "hired", name: "Hired", end: "final" }],
        },
        {
          id: "interviews",
          name: "Interviews",
          kind: "list",
          titleColumn: "candidate",
          columns: [
            { id: "candidate", name: "Candidate", type: "link", link: { sheet: "candidates" }, required: true },
            { id: "score", name: "Score", type: "number" },
          ],
        },
      ],
      roles: [{ id: "all", name: "All", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "move_steps"], scope: "all" }],
      rules: [
        rule("add_interviews", {
          trigger: { kind: "enters_step", sheet: "candidates", step: "interview" },
          actions: [1, 2, 3].map(() => ({ kind: "create_row_in" as const, target: { sheet: "interviews" }, map: { candidate: { ref: "row" as const } } })),
        }),
      ],
      later: [],
    };
    const capId = await k.create(file);
    const tom = await k.as("ada", (tx, c) => createRow(tx, c, capId, "candidates", { values: { name: "Tom Weiss" } }), NOW).then((r) => r.id);
    await k.as("ada", (tx, c) => moveStep(tx, c, tom, "interview"), NOW);
    const added = await k.as("ada", (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, capId), eq(rows.sheetId, "interviews"))));
    expect(added.map((r) => (r.data as { candidate: string }).candidate)).toEqual([tom, tom, tom]);
  });
});
