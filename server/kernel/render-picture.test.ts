import { beforeAll, describe, expect, it } from "vitest";
import { people } from "@/db/schema";
import { seed } from "@/seed";
import { load } from "./context";
import { renderCapabilityPicture, splitChange } from "./render-picture";
import { renderCapabilityText, type TextCtx } from "./render-text";
import type { CapabilityFile } from "./schema/file";
import { withWorkspace } from "./tx";

// Customize, pictured (V1): the same file gives the same picture, in the plain text's own words.

let files: Map<string, CapabilityFile>;
let ids: Map<string, string>; // capability name → id
let names: Map<string, string>;
let lena: string;

beforeAll(async () => {
  const ws = (await seed()).fernwood.workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    const loaded = await load(tx);
    files = new Map([...loaded.files].map(([id, f]) => [id, f.file]));
    ids = new Map([...loaded.files].map(([id, f]) => [f.file.name, id]));
    const all = await tx.select({ id: people.id, email: people.email, name: people.name }).from(people);
    names = new Map(all.map((p) => [p.id, p.name]));
    lena = all.find((p) => p.email === "lena@fernwood.dev")!.id;
  });
});

const ctx = (name: string): TextCtx => ({ capId: ids.get(name)!, files, personName: (id) => names.get(id), viewerId: null });
const fileOf = (name: string) => files.get(ids.get(name)!)!;

// 6c's change, by hand: Legal review after Signed for contracts over $50,000, waiting on Lena with a decision column;
// Lena added to Contract managers; the owner's reminder moved from 60 to 90 days.
function legalReview(before: CapabilityFile): CapabilityFile {
  const f = structuredClone(before);
  const sheet = f.sheets[0]!;
  sheet.steps!.splice(2, 0, { id: "legal", name: "Legal review", tone: "violet", onlyWhen: { op: "gt", args: [{ col: "value" }, 5_000_000] } });
  sheet.columns.push({ id: "legal_decision", name: "Legal decision", type: "choice", options: [{ id: "approved", name: "Approved" }, { id: "declined", name: "Declined" }] });
  const managers = f.roles.find((r) => r.id === "managers")!;
  if (managers.members.kind === "people") managers.members.people.push(lena);
  f.rules.push({
    id: "ask_lena",
    text: "When a contract enters Legal review, ask Lena to approve or decline it in Legal decision; once approved, move it to Active.",
    reading: { when: "A contract reaches Legal review", then: "It waits on Lena to approve or decline it" },
    trigger: { kind: "enters_step", sheet: "contracts", step: "legal" },
    actions: [{ kind: "ask_person", person: lena, decision: { column: "legal_decision", approve: "approved", decline: "declined" } }],
    enabled: true,
  });
  const remind = f.rules.find((r) => r.id === "remind_owner")!;
  remind.text = remind.text.replace("60 days", "90 days");
  remind.reading = { ...remind.reading, when: remind.reading.when.replace("60 days", "90 days") };
  remind.trigger = { ...remind.trigger, offsetDays: -90 };
  return f;
}

describe("Customize, pictured (V1)", () => {
  it("draws Customer contracts' steps as a flow: what brings a row there, and who it waits on", () => {
    const [flow] = renderCapabilityPicture(fileOf("Customer contracts"), ctx("Customer contracts")).flows;
    expect(flow!.steps.map((s) => [s.n, s.name])).toEqual([[1, "Draft"], [2, "Signed"], [3, "Active"], [4, "Renewal due"]]);
    expect(flow!.ends.map((s) => s.name)).toEqual(["Renewed", "Ended"]);
    const due = flow!.steps.find((s) => s.name === "Renewal due")!;
    expect(due.brings.map((b) => b.text)).toEqual(["60 days before a contract’s notice date"]);
    expect(due.waitsOn).toBe("the owner");
    expect(flow!.steps.every((s) => !s.mark)).toBe(true);
    // The caption is the plain text's own line.
    const text = renderCapabilityText(fileOf("Customer contracts"), ctx("Customer contracts"));
    expect(text.find((s) => s.heading === "Steps")!.lines[0]).toBe(flow!.caption);
  });

  it("draws who can see and do what as a grid, with the plain text's sentences as its caption", () => {
    const { grid } = renderCapabilityPicture(fileOf("Customer contracts"), ctx("Customer contracts"));
    expect(grid.rows.map((r) => [r.role, r.who, r.sees.kind, r.adds.kind, r.edits.kind, r.moves.kind, r.changes.kind])).toEqual([
      ["Contract managers", "Wade Wilson, Krishna", "every", "yes", "yes", "yes", "yes"],
      ["Contract owners", "named in Owner", "own", "no", "own", "own", "no"],
      ["Everyone else", null, "no", "no", "no", "no", "no"],
    ]);
    const text = renderCapabilityText(fileOf("Customer contracts"), ctx("Customer contracts"));
    expect(grid.caption).toEqual(text.find((s) => s.heading === "Who can see and do what")!.lines);
  });

  it("names the step a role moves rows on from, even when it's on another of its sheets (Spend's Requesters)", () => {
    const { grid } = renderCapabilityPicture(fileOf("Spend"), ctx("Spend"));
    // Requesters cover everyone, so their row reads "Everyone"; it is drawn for Purchases, the step is on Expenses.
    const requesters = grid.rows.find((r) => r.moves.kind === "from")!;
    expect(requesters.role).toBe("Everyone");
    expect(requesters.moves).toMatchObject({ kind: "from", steps: ["Needs a receipt"] });
  });

  it.each(["Hiring", "Spend", "Time off", "Onboarding", "Tools and budgets"])("%s: one grid row per role the text names, and its sentences", (name) => {
    const { grid } = renderCapabilityPicture(fileOf(name), ctx(name));
    const text = renderCapabilityText(fileOf(name), ctx(name)).find((s) => s.heading === "Who can see and do what")!.lines;
    expect(grid.caption).toEqual(text);
    expect(grid.rows.length).toBeGreaterThanOrEqual(text.length);
  });

  it("6c's preview: 4 new and 1 changed, each marked where it is", () => {
    const before = fileOf("Customer contracts");
    const p = renderCapabilityPicture(legalReview(before), ctx("Customer contracts"), before);
    expect(p.summary).toEqual({ added: 4, changed: 1 });
    const steps = p.flows[0]!.steps;
    const legal = steps.find((s) => s.name === "Legal review")!;
    expect(legal).toMatchObject({ n: 3, mark: "new", only: "for contracts over $50,000", waitsOn: "Lena Ortiz" });
    expect(legal.brings).toEqual([]);
    expect(steps.find((s) => s.name === "Renewal due")!.brings).toEqual([{ text: "90 days before a contract’s notice date", mark: "changed", change: { before: "", was: "60", now: "90", after: "days before a contract’s notice date" } }]);
    expect(p.grid.rows[0]).toMatchObject({ role: "Contract managers", newMembers: ["Lena Ortiz"] });
    expect(p.grid.rows.some((r) => r.mark)).toBe(false);
    expect(p.marks.added).toEqual(["Legal decision (Approved or Declined)", "When a contract enters Legal review, ask Lena to approve or decline it in Legal decision; once approved, move it to Active."]);
    expect(p.marks.changed).toEqual([{ before: "", was: "60", now: "90", after: "days before a contract’s notice date, move it to Renewal due and remind its owner." }]);
  });

  it("Hiring's two flows: each caption is its sheet's own line in the text", () => {
    const p = renderCapabilityPicture(fileOf("Hiring"), ctx("Hiring"));
    const lines = renderCapabilityText(fileOf("Hiring"), ctx("Hiring")).flatMap((s) => s.lines);
    expect(p.flows.length).toBe(2);
    for (const f of p.flows) expect(lines).toContain(f.caption);
  });

  it("marks nothing while no change waits, and gives the same picture every time", () => {
    const f = fileOf("Hiring");
    const a = renderCapabilityPicture(f, ctx("Hiring"));
    expect(a.summary).toBeNull();
    expect(a.marks).toEqual({ added: [], changed: [] });
    expect(renderCapabilityPicture(structuredClone(f), ctx("Hiring"))).toEqual(a);
  });

  it("splits a changed sentence where it differs", () => {
    expect(splitChange("Remind at 60 days.", "Remind at 90 days.")).toEqual({ before: "Remind at", was: "60", now: "90", after: "days." });
    expect(splitChange("A b", "A b c")).toEqual({ before: "A b", was: "", now: "c", after: "" });
  });
});

describe("a role's sentence names every sheet it sees by a person on it (small thing 2, Nov 5)", () => {
  const sees = (name: string) => renderCapabilityText(fileOf(name), ctx(name)).find((s) => s.heading === "Who can see and do what")!.lines;

  it("Spend: everyone sees their own purchases and expenses", () => {
    expect(sees("Spend").some((l) => /their own purchases and expenses/.test(l))).toBe(true);
  });

  it("Customer contracts: owners see their own contracts; renewals and contacts, seen through a contract, stay out", () => {
    expect(sees("Customer contracts")).toContain("Contract owners see their own contracts and can edit and move them.");
  });
});
