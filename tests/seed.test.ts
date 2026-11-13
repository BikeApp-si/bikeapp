// The Fernwood seed: valid files, the versions and rows the Step 6–8 screens show, and safe to run twice.
import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";
import { capabilities, capabilityVersions, people, rows } from "@/db/schema";
import { seed } from "@/seed";
import { doItYourself } from "@/server/kernel/actions";
import { rolesOf } from "@/server/kernel/directory";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import { getSettings } from "@/server/kernel/settings";
import { capabilityView } from "@/server/kernel/views";
import type { KernelCtx } from "@/server/kernel/context";
import { load } from "@/server/kernel/context";
import { listRows, movesFor } from "@/server/kernel/rows";
import { validateFile } from "@/server/kernel/schema/validate";
import { withWorkspace } from "@/server/kernel/tx";
import { auditEntries, outbox } from "@/db/schema";
import { queueMorningEmails } from "@/server/kernel/morning";
import { systemCtx } from "@/server/kernel/date-rules";
import { reasonFor, waitingCounts, waitingFor, waitingRowIds } from "@/server/kernel/waiting";
import { proposalsFor } from "@/server/kernel/proposals";
import { dateLine, roleViewFor } from "@/server/kernel/views";
import { morningEmail, itemLine } from "@/server/email/templates/morning";

let ws: string;
const ids = new Map<string, string>();
const caps = new Map<string, string>();

const ctx = (name: string): KernelCtx => ({ workspaceId: ws, actor: { id: ids.get(name)!, email: `${name}@fernwood.dev` }, now: new Date("2026-10-27T15:00:00Z") });
const as = <T>(name: string, fn: (tx: Parameters<Parameters<typeof withWorkspace>[1]>[0], c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(name) }, (tx) => fn(tx, ctx(name)));
const list = (name: string, cap: string, sheet: string) => as(name, (tx, c) => listRows(tx, c, caps.get(cap)!, sheet));

beforeAll(async () => {
  ws = (await seed()).fernwood.workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
    for (const c of await tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities)) caps.set(c.name, c.id);
  });
});

describe("the Fernwood seed", () => {
  it("has the six capabilities, each file valid, at the versions the screens show", async () => {
    await withWorkspace({ workspaceId: ws }, async (tx) => {
      const loaded = await load(tx);
      const versions = Object.fromEntries([...loaded.files.values()].map((f) => [f.file.name, f.version]));
      expect(versions).toEqual({ Hiring: 3, Onboarding: 1, "Time off": 1, Spend: 1, "Tools and budgets": 1, "Customer contracts": 4 });
      for (const f of loaded.files.values()) {
        const others = new Map([...loaded.files].filter(([id]) => id !== f.id).map(([id, o]) => [id, o.file]));
        expect(validateFile(f.file, { selfId: f.id, others, people: new Set(loaded.people.keys()) })).toMatchObject({ ok: true });
      }
      // 9a: v1 of Customer contracts had 1 sheet.
      const [v1] = await tx.select({ file: capabilityVersions.file }).from(capabilityVersions).where(eq(capabilityVersions.capabilityId, caps.get("Customer contracts")!)).orderBy(capabilityVersions.version).limit(1);
      expect((v1!.file as { sheets: unknown[] }).sheets).toHaveLength(1);
      // 6a: "Created Aug 12 from your message".
      const [cc] = await tx.select({ at: capabilities.createdAt }).from(capabilities).where(eq(capabilities.name, "Customer contracts"));
      expect(cc!.at.toISOString().slice(0, 10)).toBe("2026-08-12");
    });
  });

  it("has 8h's 18 suggested categories waiting on Lena, from the recorded AI step answers", async () => {
    const list = await as("lena", (tx, c) => proposalsFor(tx, c, caps.get("Spend")!));
    expect(list).toHaveLength(18);
    expect(list.every((p) => p.column === "Category" && p.reason.length > 0)).toBe(true);
    expect(await as("wade", (tx, c) => proposalsFor(tx, c, caps.get("Spend")!))).toEqual([]);
    // Lena still waits on the same 18 rows (Waiting on me counts rows).
    expect((await as("lena", (tx, c) => waitingRowIds(tx, c, caps.get("Spend")!, "expenses"))).length).toBe(18);
  });

  it("is safe to run again", async () => {
    const count = () => withWorkspace({ workspaceId: ws }, (tx) => Promise.all([tx.$count(capabilities), tx.$count(rows), tx.$count(people)]));
    const before = await count();
    const again = await seed();
    expect(again.fernwood).toMatchObject({ created: false, capabilitiesSeeded: false });
    expect(await count()).toEqual(before);
  });

  it("Customer contracts: 12 contracts, 4 renewals, 18 contacts; Rita owns 6 (8c)", async () => {
    const contracts = await list("wade", "Customer contracts", "contracts");
    expect(contracts).toHaveLength(12);
    expect(contracts.reduce((n, r) => n + Number(r.data.value), 0)).toBe(29_640_000); // 6a: Sum $296,400
    // Northwind came in at Renewal due; the 60-day rule moved Acme Health, Orbit Health and Brightline on Oct 22.
    expect(contracts.filter((r) => r.stepId === "renewal_due").map((r) => r.data.customer)).toEqual(["Northwind", "Acme Health", "Orbit Health", "Brightline"]);
    expect(await list("wade", "Customer contracts", "renewals")).toHaveLength(4);
    expect(await list("wade", "Customer contracts", "contacts")).toHaveLength(18);
    const rita = (await list("rita", "Customer contracts", "contracts")).map((r) => r.data.customer);
    expect(rita.sort()).toEqual(["Fieldstone", "Kova", "Orbit Health", "Pinecone Labs", "Quill Media", "Sable Analytics"]);
    const northwind = contracts.find((r) => r.data.customer === "Northwind")!;
    expect(northwind.data).toMatchObject({ notice_date: "2026-10-15" }); // 7a: notice date Oct 15
  });

  it("Hiring: Priya sees her 9 candidates (8d), Sam Okafor at Offer, 5 already Hired", async () => {
    const priya = await list("priya", "Hiring", "candidates");
    expect(priya.map((r) => r.data.name).sort()).toEqual(
      ["Eli Brooks", "Grace Kim", "Hannah Cole", "Jordan Lee", "Lucy Ward", "Ravi Menon", "Sam Okafor", "Sofia Park", "Tom Weiss"],
    );
    expect(priya.find((r) => r.data.name === "Sam Okafor")).toMatchObject({ stepId: "offer", data: { offer: 16_800_000 } });
    expect(priya.find((r) => r.data.name === "Hannah Cole")).toMatchObject({ stepId: "screen", data: { referred_by: ids.get("maya") } });
    const all = await list("wade", "Hiring", "candidates");
    // 6h's 5 Hired, plus Ana Ruiz, hired before Bike, from the report history (11f; M8 decisions). Step 6's
    // Playwright copy of Fernwood has no report history, so 6h still shows 5 there.
    expect(all.filter((r) => r.stepId === "hired").map((r) => r.data.name)).toEqual(["Leo Grant", "Mei Chen", "Nina Park", "Aisha Khan", "Jon Bell", "Ana Ruiz"]);
  });

  it("Time off: Maya's 4 requests (8a), Priya's team's 7 (X1)", async () => {
    const maya = await list("maya", "Time off", "requests");
    // 8a's order: by step, newest first.
    expect(maya.map((r) => [r.data.from, r.data.days, r.stepId])).toEqual([
      ["2026-12-28", 4, "submitted"],
      ["2026-10-15", 2, "approved"],
      ["2026-08-04", 5, "taken"],
      ["2026-06-02", 1, "taken"],
    ]);
    expect(await list("priya", "Time off", "requests")).toHaveLength(7);
    expect((await list("maya", "Time off", "balances"))[0]!.data).toMatchObject({ allowance: 20, used: 8, left: 12 });
  });

  it("Spend: Maya sees her 5 expenses (8b); Lena sees all, with 18 that have no category (8h)", async () => {
    // 8b's rows, in its order: by step, newest first.
    expect((await list("maya", "Spend", "expenses")).map((r) => r.data.what)).toEqual(["Taxi to SFO", "Seattle trip", "Keyboard", "Conference books", "Team lunch"]);
    const lena = await list("lena", "Spend", "expenses");
    expect(lena.filter((r) => !r.data.category)).toHaveLength(18);
    // 8b: the taxi needs a receipt, which only Maya can move on; Lena's 18 (8h) are the ones at Submitted.
    expect(lena.find((r) => r.data.what === "Taxi to SFO")!.stepId).toBe("needs_receipt");
    expect(lena.filter((r) => r.stepId === "submitted")).toHaveLength(18);
    const taxi = lena.find((r) => r.data.what === "Taxi to SFO")!.id;
    expect(await as("lena", (tx, c) => movesFor(tx, c, taxi))).toEqual([]);
    expect((await as("maya", (tx, c) => movesFor(tx, c, taxi))).map((m) => m.id)).toEqual(["submitted"]); // not Rejected: that's a decision on her own expense
  });

  it("Onboarding: Ana Ruiz's plan, 4 of 6 tasks done, Maya her buddy", async () => {
    const tasks = await list("maya", "Onboarding", "tasks");
    expect(tasks).toHaveLength(6);
    expect(tasks.filter((r) => r.stepId === "done")).toHaveLength(4);
  });

  it("each person sees the capabilities in their sidebar on the screens", async () => {
    const sidebar = (name: string) => as(name, (tx, c) => capabilitiesFor(tx, c)).then((cs) => cs.map((c) => c.name));
    expect(await sidebar("wade")).toEqual(["Hiring", "Onboarding", "Time off", "Spend", "Tools and budgets", "Customer contracts"]); // 6b
    expect(await sidebar("maya")).toEqual(["Hiring", "Onboarding", "Time off", "Spend"]); // 8a
    expect(await sidebar("priya")).toEqual(["Hiring", "Onboarding", "Time off", "Spend"]); // 8d
    expect(await sidebar("rita")).toEqual(["Time off", "Spend", "Customer contracts"]); // 8c
  });
});

describe("the Fernwood seed on the M3 screens", () => {
  it("Do it yourself: Maya's three (3a1) and Wade's nine (12a)", async () => {
    const maya = await as("maya", (tx, c) => doItYourself(tx, c));
    expect(maya.map((a) => [a.label, a.capability])).toEqual([
      ["Add an expense", "Spend"],
      ["Request time off", "Time off"],
      ["Request a purchase", "Spend"],
    ]);
    const wade = await as("wade", (tx, c) => doItYourself(tx, c));
    expect(wade).toHaveLength(9);
    expect(wade.map((a) => a.label).sort()).toEqual(
      ["Add a person", "Add a tool", "Add an expense", "New contract", "Open a role", "Plan a starter’s first week", "Request a purchase", "Request time off", "Set a budget"],
    );
  });

  it("6a's header line, and 7a's step buttons for Northwind", async () => {
    const view = await as("wade", (tx, c) => capabilityView(tx, c, caps.get("Customer contracts")!));
    expect(view.line).toBe("Created Aug 12 from your message · owned by Wade Wilson");
    expect(view.sheets.map((s) => [s.name, s.count])).toEqual([["Contracts", 12], ["Renewals", 4], ["Contacts", 18]]);
    expect(Object.keys(view.sheets[0]!.hints)).toEqual(["notice"]);
    const northwind = (await list("wade", "Customer contracts", "contracts")).find((r) => r.data.customer === "Northwind")!;
    expect(await as("wade", (tx, c) => movesFor(tx, c, northwind.id))).toEqual([
      { id: "active", name: "Active" },
      { id: "renewed", name: "Renewed" },
      { id: "ended", name: "Ended" },
    ]);
  });

  it("Wade (Owner) and Lena are the admins (9b)", async () => {
    const s = await as("wade", (tx, c) => getSettings(tx, c));
    expect(s.admins.map((a) => [a.name, a.owner])).toEqual([["Wade Wilson", true], ["Lena Ortiz", false]]);
  });
});

describe("7g roles", () => {
  it("lists what Maya holds, without the roles that give her nothing", async () => {
    const asked = (n: string) => ({ workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } });
    const roles = await withWorkspace({ workspaceId: ws }, (tx) => rolesOf(tx, asked("wade"), ids.get("maya")!));
    expect(roles).toContain("Requesters in Spend");
    expect(roles).toContain("Buddies in Onboarding");
    expect(roles).not.toContain("Managers in Time off");
    expect(roles).not.toContain("Everyone (holidays) in Time off");
    // Asked by Maya, Wade's roles leave out Customer contracts, which she can't see.
    const wade = await withWorkspace({ workspaceId: ws }, (tx) => rolesOf(tx, asked("maya"), ids.get("wade")!));
    expect(wade.some((r) => r.endsWith("in Customer contracts"))).toBe(false);
    expect((await withWorkspace({ workspaceId: ws }, (tx) => rolesOf(tx, asked("lena"), ids.get("wade")!))).some((r) => r.endsWith("in Customer contracts"))).toBe(true);
  });
});

describe("the Fernwood rules, replayed to 06:00 on Oct 27 (M4)", () => {
  const waiting = (name: string) => as(name, (tx, c) => waitingFor(tx, c));
  const counts = async (name: string) => {
    const byId = await as(name, (tx, c) => waitingCounts(tx, c));
    return Object.fromEntries([...caps].filter(([, id]) => byId[id]).map(([n, id]) => [n, byId[id]]));
  };

  it("Priya: Hiring 2 and Time off 1 (8d, 8e, X1)", async () => {
    expect(await counts("priya")).toEqual({ Hiring: 2, "Time off": 1 });
    expect((await waiting("priya")).map((i) => [i.capability, i.title, i.step ?? i.rowName, i.label])).toEqual([
      ["Hiring", "Sam Okafor", "Offer", "Send the offer"],
      ["Time off", "Maya Chen", "Submitted", "Approve or decline"],
      ["Hiring", "Tom Weiss", "Interview", "Your scorecard"],
    ]);
  });

  it("everyone else, as plan.md lists them", async () => {
    expect(await counts("maya")).toEqual({ Spend: 1 });
    expect(await counts("lena")).toEqual({ Spend: 18 });
    expect(await counts("rita")).toEqual({ "Customer contracts": 1 });
    expect(await counts("krishna")).toEqual({ "Customer contracts": 3 });
    expect(await counts("omar")).toEqual({ Hiring: 1 });
    expect(await counts("wade")).toEqual({});
    expect((await waiting("rita")).map((i) => i.title)).toEqual(["Orbit Health"]);
    expect((await waiting("krishna")).map((i) => i.title)).toEqual(["Northwind", "Acme Health", "Brightline"]);
  });

  it("Priya's morning email lists the same 3 items (8i)", async () => {
    const at = new Date("2026-10-27T12:00:00Z"); // 07:00 in Chicago
    await withWorkspace({ workspaceId: ws }, async (tx) => {
      // Rolled back afterwards, so the seed stays as it is.
      await tx.transaction(async (t) => {
        await queueMorningEmails(t, systemCtx(ws, at));
        const [mail] = await t.select().from(outbox).where(and(eq(outbox.personId, ids.get("priya")!), eq(outbox.kind, "morning")));
        const payload = mail!.payload as Parameters<typeof morningEmail>[0];
        const email = morningEmail({ ...payload, to: "priya@fernwood.dev", firstName: "Priya", company: "Fernwood Labs", subdomain: "fernwood" });
        expect(email.subject).toBe("3 things wait on you at Fernwood Labs");
        expect(payload.items.map((i) => [i.capability, i.title, itemLine(i, "2026-10-27")])).toEqual([
          ["Hiring", "Sam Okafor", "Offer · send the offer"],
          ["Time off", "Maya Chen", "Submitted · approve or decline"],
          ["Hiring", "Tom Weiss", "Interview · your scorecard, due today"],
        ]);
        t.rollback();
      }).catch((e) => (e?.message === "Rollback" ? undefined : Promise.reject(e)));
    });
  });

  it("dates every rule run when it would really have happened (9a's Acme move is the rule's, Oct 22 06:00)", async () => {
    const acme = await withWorkspace({ workspaceId: ws }, (tx) =>
      tx.select().from(auditEntries).where(and(like(auditEntries.who, "rule:remind_owner"), eq(auditEntries.event, "rule.ran"))).orderBy(asc(auditEntries.seq)),
    );
    expect(acme.map((e) => [e.at.toISOString(), (e.details as { row: string }).row])).toEqual([
      ["2026-10-22T11:00:00.000Z", "Northwind"],
      ["2026-10-22T11:00:00.000Z", "Acme Health"],
      ["2026-10-22T11:00:00.000Z", "Orbit Health"],
      ["2026-10-22T11:00:00.000Z", "Brightline"],
    ]);
  });

  it("Leo Grant's hire started his Onboarding plan with name, start date and manager (9a)", async () => {
    const plans = await list("wade", "Onboarding", "plans");
    expect(plans.find((p) => p.data.name === "Leo Grant")!.data).toMatchObject({ start_date: "2026-11-10", manager: ids.get("dev") });
  });

  it("each person's table: Maya 8a and 8b, Priya 8d and X1, Rita 8c; Krishna and the admins keep the Data tab", async () => {
    const line = async (name: string, cap: string, admin = false) => (await as(name, (tx, c) => roleViewFor(tx, c, caps.get(cap)!, admin)))?.line ?? null;
    expect(await line("maya", "Time off")).toBe("Your requests and balance");
    expect(await line("maya", "Spend")).toBe("Your own expenses");
    expect(await line("priya", "Time off")).toBe("Your team’s requests");
    expect(await line("priya", "Hiring")).toBe("Candidates for your team’s roles");
    expect(await line("rita", "Customer contracts")).toBe("The contracts you own");
    expect(await line("krishna", "Customer contracts")).toBeNull();
    expect(await line("lena", "Spend", true)).toBeNull();
  });

  it("Waiting on me in Priya's Hiring table is Tom (through his interview) and Sam (8e); X1's reason", async () => {
    const ids = await as("priya", (tx, c) => waitingRowIds(tx, c, caps.get("Hiring")!, "candidates"));
    const named = (await list("priya", "Hiring", "candidates")).filter((r) => ids.includes(r.id)).map((r) => r.data.name);
    expect(named.sort()).toEqual(["Sam Okafor", "Tom Weiss"]);
    const [dec] = (await list("priya", "Time off", "requests")).filter((r) => r.stepId === "submitted");
    expect(await as("priya", (tx, c) => reasonFor(tx, c, dec!.id))).toBe(
      "Waiting on you because you are Maya’s manager. Rule: “Requests go to the person’s manager.” Maya and Lena are emailed when you decide.",
    );
  });

  it("7a's line under Northwind's title", async () => {
    await withWorkspace({ workspaceId: ws }, async (tx) => {
      const loaded = await load(tx);
      const cap = loaded.files.get(caps.get("Customer contracts")!)!;
      const northwind = (await list("wade", "Customer contracts", "contracts")).find((r) => r.data.customer === "Northwind")!;
      expect(dateLine(loaded.rules, cap, cap.file.sheets[0]!, northwind.data, "2026-10-27")).toBe("Notice date passed Oct 15");
    });
  });
});

describe("Fernwood before Step 5", () => {
  it("has Fernwood's people and admins and its five capabilities, without Customer contracts", async () => {
    const { fernwoodNew } = await seed();
    await withWorkspace({ workspaceId: fernwoodNew.workspaceId }, async (tx) => {
      const names = (await tx.select({ name: capabilities.name }).from(capabilities).orderBy(asc(capabilities.position))).map((c) => c.name);
      expect(names).toEqual(["Hiring", "Onboarding", "Time off", "Spend", "Tools and budgets"]);
      const team = await tx.select({ email: people.email, isAdmin: people.isAdmin }).from(people);
      expect(team).toHaveLength(14);
      expect(team.filter((p) => p.isAdmin).map((p) => p.email).sort()).toEqual(["lena@fernwood.dev", "wade@fernwood.dev"]);
    });
  });
});
