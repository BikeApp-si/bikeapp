import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { auditEntries, capabilities, changeSets, people, rows } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import { createCapability, getFile } from "../capabilities";
import { salesLeadsFile } from "../fixtures";
import type { KernelCtx } from "../context";
import { previewRule } from "../preview";
import { createRow, listRows, moveStep } from "../rows";
import type { CapabilityFile, Rule } from "../schema/file";
import { withWorkspace, type Tx } from "../tx";
import { applyChanges, type Change } from "./changes";
import { applyCustomize, previewCustomize, type Edits } from "./apply";
import { compileCustomize } from "./compile";
import { usesOf } from "./deps";
import { impactText } from "./impact";

// Customize on the seeded Fernwood, today Oct 27: 6c → 6e (Customer contracts v4 → v5), 6f (v6), 6h → 6j
// (Hiring v3 → v4). The kernel previews and applies; prompt 3's part is in server/chat/customize.test.ts.

const NOW = new Date("2026-10-27T15:00:00Z");
let ws: string;
const ids = new Map<string, string>();
const ctx = (n: string): KernelCtx => ({ workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` }, now: NOW });
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, ctx(n)));
const capNamed = (name: string) => as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, name))).then((r) => r[0]!.id);
const fileOf = (id: string) => as("wade", (tx) => getFile(tx, id)).then((f) => f!);
const edits = (capId: string, before: CapabilityFile, changes: Change[], words: string[]): Edits => new Map([[capId, { before, after: applyChanges(before, changes), changes: words }]]);

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `cz${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
});

describe("6c → 6e: Legal review, Lena, and the reminder at 90 days", () => {
  const chatId = crypto.randomUUID();
  let contracts: string;
  let six: Edits;

  beforeAll(async () => {
    contracts = await capNamed("Customer contracts");
    const v4 = await fileOf(contracts);
    const remind = v4.file.rules.find((r) => r.id === "remind_owner")!;
    six = edits(
      contracts,
      v4.file,
      [
        { kind: "add_step", sheet: "contracts", after: "signed", step: { id: "legal_review", name: "Legal review", onlyWhen: { op: "gt", args: [{ col: "value" }, 5_000_000] } } },
        { kind: "add_person_to_role", role: "managers", person: ids.get("lena")! },
        { kind: "set_rule", rule: { ...remind, text: "90 days before a contract’s notice date, move it to Renewal due and remind its owner.", trigger: { ...remind.trigger, offsetDays: -90 } } },
      ],
      ["A Legal review step between Signed and Active, for contracts over $50,000", "Lena Ortiz sees every contract and moves them through Legal review", "The renewal reminder moves from 60 to 90 days before the notice date"],
    );
  });

  it("previews the text as it will read (6c), with what it does to today's rows from the kernel", async () => {
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, contracts, six, chatId));
    expect(p.problems).toEqual([]);
    expect(p.version).toBe(5);
    const lines = Object.fromEntries(p.text.map((s) => [s.heading, s.lines]));
    expect(lines["Steps"]).toEqual(["Draft → Signed → Legal review, for contracts over $50,000 → Active → Renewal due → Renewed or Ended"]);
    expect(lines["What happens by itself"]![0]).toBe("90 days before a contract’s notice date, move it to Renewal due and remind its owner.");
    expect(lines["Who can see and do what"]![0]).toBe("Wade Wilson, Krishna and Lena Ortiz see every contract, add, edit and move them, and change how it works.");
    // The seed has no Signed contract over $50,000 (Brightline is at Renewal due), and every contract whose
    // 90-day date has passed since Aug 12 was already reminded for that notice date (Orbit Health).
    expect(p.impact).toEqual({ waits: [], fires: [], renamed: [], access: [] });
    expect(impactText(p.impact!)).toBe("");
    const [entry] = await as("wade", (tx) => tx.select().from(auditEntries).where(and(eq(auditEntries.chatId, chatId), eq(auditEntries.event, "customize.preview"))));
    expect(entry!.details).toMatchObject({ version: 5 });
  });

  it("is for admins only, in the kernel", async () => {
    await expect(as("maya", (tx, c) => previewCustomize(tx, c, contracts, six, chatId))).rejects.toThrow(/Only admins/);
    await expect(as("maya", (tx, c) => applyCustomize(tx, c, contracts, six, chatId))).rejects.toThrow(/Only admins/);
  });

  it("applies as one change set at version 5 (6e), with customize.saved and rule.saved pointing to the chat", async () => {
    const out = await as("wade", (tx, c) => applyCustomize(tx, c, contracts, six, chatId));
    expect(out.versions.get(contracts)).toBe(5);
    const v5 = await fileOf(contracts);
    expect(v5.version).toBe(5);
    expect(v5.file.sheets[0]!.steps!.map((s) => s.id)).toEqual(["draft", "signed", "legal_review", "active", "renewal_due", "renewed", "ended"]);
    const [cs] = await as("wade", (tx) => tx.select().from(changeSets).where(eq(changeSets.id, out.changeSetId)));
    expect(cs).toMatchObject({ source: "customize", chatId, items: [{ capabilityId: contracts, fromVersion: 4, toVersion: 5 }] });
    const entries = await as("wade", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.changeSetId, out.changeSetId)).orderBy(asc(auditEntries.seq)));
    expect(entries.map((e) => [e.event, e.chatId])).toEqual([
      ["customize.saved", chatId],
      ["rule.saved", chatId],
    ]);
    expect(entries[0]!.details).toMatchObject({ from: 4, to: 5 });
  });

  it("refuses a preview made against a file that has changed since", async () => {
    await expect(as("wade", (tx, c) => applyCustomize(tx, c, contracts, six, chatId))).rejects.toThrow(/has changed since this preview/);
  });

  it("6f: a rule from the day a contract was added, previewed on the last 90 days, then added at version 6", async () => {
    const stale: Rule = {
      id: "draft_reminder",
      text: "If a contract is still in Draft 14 days after it was added, remind its owner.",
      reading: { when: "A contract has been in Draft for 14 days", then: "Its owner gets an email reminder" },
      trigger: { kind: "date_reached", sheet: "contracts", from: "added", offsetDays: 14 },
      condition: { op: "eq", args: [{ col: "status" }, "draft"] },
      actions: [{ kind: "notify", columns: ["owner"], message: "This contract is still in Draft." }],
      enabled: true,
    };
    // Quill Media was added on Oct 21, so its 14 days end on Nov 4: nothing in the window.
    expect((await as("wade", (tx, c) => previewRule(tx, c, contracts, stale))).summary).toBe("On your last 90 days, this rule wouldn't have run.");
    const v5 = await fileOf(contracts);
    const out = await as("wade", (tx, c) => applyCustomize(tx, c, contracts, edits(contracts, v5.file, [{ kind: "set_rule", rule: stale }], [stale.text]), crypto.randomUUID()));
    expect(out.versions.get(contracts)).toBe(6);
  });
});

describe("6h → 6j: Hired becomes Offer accepted", () => {
  it("renames the step with its 5 candidates; the connection and the Filled rule keep working", async () => {
    const hiring = await capNamed("Hiring");
    const v3 = await fileOf(hiring);
    const world = new Map(await as("wade", async (tx) => (await tx.select({ id: capabilities.id }).from(capabilities)).map((c) => c.id)).then((list) => Promise.all(list.map(async (id) => [id, (await fileOf(id)).file] as const))));
    expect(usesOf(world, { capabilityId: hiring, sheetId: "candidates", step: "hired" }).map((u) => [u.kind, u.ruleId])).toEqual([
      ["connection", "start_onboarding"],
      ["rule", "fill_opening"],
    ]);
    const six = edits(hiring, v3.file, [{ kind: "rename", sheet: "candidates", step: "hired", name: "Offer accepted" }], ["Candidates: the Hired step becomes Offer accepted"]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, hiring, six, crypto.randomUUID()));
    expect(p.problems).toEqual([]);
    expect(impactText(p.impact!)).toBe("The 5 candidates already Hired stay as they are and become Offer accepted.");
    expect(p.text.find((s) => s.heading === "Candidates sheet")!.lines[2]).toBe("Steps: Applied → Screen → Interview → Offer → Offer accepted or Rejected.");
    await as("wade", (tx, c) => applyCustomize(tx, c, hiring, six, crypto.randomUUID()));
    expect((await fileOf(hiring)).version).toBe(4);

    // Sam Okafor reaches Offer accepted: his plan starts in Onboarding and the opening is Filled, as before.
    const [sam] = await as("wade", (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, hiring), eq(rows.sheetId, "candidates"))).then((r) => r.filter((x) => (x.data as { name: string }).name === "Sam Okafor")));
    await as("priya", (tx, c) => moveStep(tx, c, sam!.id, "hired"));
    const onboarding = await capNamed("Onboarding");
    const plans = await as("wade", (tx) => tx.select().from(rows).where(and(eq(rows.capabilityId, onboarding), eq(rows.sheetId, "plans"))));
    expect(plans.map((r) => (r.data as { name: string }).name)).toContain("Sam Okafor");
    const opening = await as("wade", (tx) => tx.select().from(rows).where(eq(rows.id, (sam!.data as { opening: string }).opening)));
    expect((opening[0]!.data as { status: string }).status).toBe("filled");
  });
});

describe("prompt 3's answer, by name, compiled against the workspace", () => {
  const base = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null };
  const worldNow = async () => {
    const list = await as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities));
    return new Map(await Promise.all(list.map(async (c) => [c.id, (await fileOf(c.id)).file] as const)));
  };
  const emails = () => new Map([...ids].map(([n, id]) => [`${n}@fernwood.dev`, id]));

  it("6h: removing Hired with its candidates becomes a rename, and the rules that name Hired are reworded", async () => {
    const hiring = await capNamed("Hiring");
    const files = await worldNow();
    const w = { capId: hiring, files, people: emails() };
    const compiled = compileCustomize(
      [{ ...base, kind: "rename", sheet: "Candidates", rename: { what: "step", from: "Offer accepted", to: "Offer accepted", instead_of_removal: true }, explain: "x", part: "x" }],
      w,
    );
    // Hiring is at v4 already (the test above), where the step is called Offer accepted.
    expect(compiled.problems).toEqual([]);
    expect(compiled.renames[0]!.uses.map((u) => u.ruleId)).toEqual(["start_onboarding", "fill_opening"]);
  });

  it("6c: a step after Signed with its condition in dollars, Lena by email, and the reminder as a sentence that replaces the 60-day rule", async () => {
    const contracts = await capNamed("Customer contracts");
    const files = await worldNow();
    const w = { capId: contracts, files, people: emails() };
    const compiled = compileCustomize(
      [
        {
          ...base,
          kind: "add_step",
          sheet: "Contracts",
          after: "Active",
          step: { name: "Review", start: false, end: null, button: null, only_when: '{"op":"gt","args":[{"col":"Value a year"},50000]}', move_out: "anyone", move_in: "anyone" },
          explain: "A Review step after Active, for contracts over $50,000",
          part: "Steps: Review after Active",
        },
        { ...base, kind: "add_person_to_role", role: "Contract managers", person: "nina@fernwood.dev", explain: "Nina sees every contract", part: "Nina can see every contract" },
        { ...base, kind: "rule", rule: { sentence: "100 days before a contract’s notice date, move it to Renewal due and remind its owner.", replaces: "90 days before a contract’s notice date, move it to Renewal due and remind its owner." }, explain: "x", part: "x" },
      ],
      w,
    );
    expect(compiled.problems).toEqual([]);
    expect(compiled.changes[0]).toMatchObject({ kind: "add_step", sheet: "contracts", after: "active", step: { id: "review", onlyWhen: { op: "gt", args: [{ col: "value" }, 5_000_000] } } });
    expect(compiled.changes[1]).toEqual({ kind: "add_person_to_role", role: "managers", person: ids.get("nina") });
    expect(compiled.rules).toEqual([{ sentence: "100 days before a contract’s notice date, move it to Renewal due and remind its owner.", replaces: "remind_owner" }]);
    expect(compiled.words.map((x) => x.where)).toEqual(["Steps", "Who can see and do what", "What happens by itself"]);
  });

  it("names that don't exist come back as problems in plain words, for the one retry", async () => {
    const contracts = await capNamed("Customer contracts");
    const w = { capId: contracts, files: await worldNow(), people: emails() };
    const compiled = compileCustomize(
      [
        { ...base, kind: "add_step", sheet: "Contracts", after: "Approved", step: { name: "Review", start: false, end: null, button: null, only_when: null, move_out: "anyone", move_in: "anyone" }, explain: "x", part: "x" },
        { ...base, kind: "add_person_to_role", role: "Contract managers", person: "zed@fernwood.dev", explain: "x", part: "x" },
      ],
      w,
    );
    expect(compiled.problems).toEqual(["Customer contracts › Contracts: there is no step “Approved” to add it after.", "zed@fernwood.dev isn't in People."]);
  });
});

// C1: a Companies sheet added to Sales leads, where Lead owners see only their own leads. Seen through access.ts,
// as the Data tab reads it: each lead owner their own companies, the sales managers every one.
describe("C1: a sheet added under a role that sees its own rows", () => {
  const chatId = crypto.randomUUID();
  let cap: string;
  const names = async (who: string) => (await as(who, (tx, c) => listRows(tx, c, cap, "companies"))).map((r) => r.data.name).sort();

  beforeAll(async () => {
    cap = (await as("wade", (tx, c) => createCapability(tx, c, salesLeadsFile([ids.get("wade")!, ids.get("dev")!]), { source: "build" }))).id;
    for (const [who, company] of [["rita", "Northwind"], ["leo", "Kova"]] as const)
      await as("wade", (tx, c) => createRow(tx, c, cap, "leads", { values: { company, owner: ids.get(who) } }));
  });

  it("applies with Companies seen by its Owner, and says so in the preview", async () => {
    const before = (await fileOf(cap)).file;
    const owner = { id: "owner", name: "Owner", type: "person" as const, default: { kind: "creator" as const } };
    const add: Change = { kind: "add_sheet", sheet: { id: "companies", name: "Companies", kind: "list", row: { one: "company", many: "companies" }, titleColumn: "name", columns: [{ id: "name", name: "Name", type: "text", required: true }, owner] } };
    const e = edits(cap, before, [add], ["A Companies sheet"]);
    const p = await as("wade", (tx, c) => previewCustomize(tx, c, cap, e, chatId));
    expect(p.problems).toEqual([]);
    expect(impactText(p.impact!)).toBe("Lead owners see their own companies, by Owner.");
    await as("wade", (tx, c) => applyCustomize(tx, c, cap, e, chatId));

    await as("rita", (tx, c) => createRow(tx, c, cap, "companies", { values: { name: "Northwind Ltd" } }));
    await as("leo", (tx, c) => createRow(tx, c, cap, "companies", { values: { name: "Kova AB" } }));
    expect(await names("rita")).toEqual(["Northwind Ltd"]);
    expect(await names("leo")).toEqual(["Kova AB"]);
    expect(await names("dev")).toEqual(["Kova AB", "Northwind Ltd"]);
    expect(await names("maya")).toEqual([]);
  });

  it("then every lead owner sees every company, through a role beside theirs; then none", async () => {
    const all = (await fileOf(cap)).file;
    await as("wade", (tx, c) => applyCustomize(tx, c, cap, edits(cap, all, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }], ["Lead owners see every company"]), chatId));
    expect(await names("rita")).toEqual(["Kova AB", "Northwind Ltd"]);
    // Their own leads stay their own.
    expect((await as("rita", (tx, c) => listRows(tx, c, cap, "leads"))).map((r) => r.data.company)).toEqual(["Northwind"]);

    // Then none: the role beside theirs is switched off, and lead owners see no companies, still their own leads.
    const now = (await fileOf(cap)).file;
    await as("wade", (tx, c) => applyCustomize(tx, c, cap, edits(cap, now, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "none" }], ["Lead owners don't see companies"]), chatId));
    expect(await names("rita")).toEqual([]);
    expect(await names("dev")).toEqual(["Kova AB", "Northwind Ltd"]);
    expect((await as("rita", (tx, c) => listRows(tx, c, cap, "leads"))).map((r) => r.data.company)).toEqual(["Northwind"]);
  });
});
