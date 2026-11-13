import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEntries, capabilities, changeSets, jobs } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { addFromGallery } from "@/server/gallery/add";
import { getFile } from "../capabilities";
import { companyRules } from "../company-rules";
import { createRow } from "../rows";
import type { CapabilityFile } from "../schema/file";
import { addSet, previewSet, suggestSlots } from "./add";
import { checkSet } from "./check";
import { loadSet, type AppSet } from "./format";

const SAMPLE = path.join(process.cwd(), "tests/gallery/sample");
const sample = () => loadSet(SAMPLE);
const ALL = ["categories", "requests", "allowances"];

type K = Awaited<ReturnType<typeof kernelWorkspace>>;
const choice = (k: K, apps = ALL) => ({ apps, slots: { approver: [k.id.priya], team_leads: [k.id.rita, k.id.priya] } });
const problems = (r: ReturnType<typeof checkSet>) => (r.ok ? [] : r.problems);
const capCount = (k: K) => k.as("ada", (tx) => tx.$count(capabilities));

describe("the set's check", () => {
  it("passes every set in gallery/ and the sample", () => {
    const dir = path.join(process.cwd(), "gallery");
    const sets = existsSync(dir) ? readdirSync(dir).map((d) => path.join(dir, d)) : [];
    for (const d of [...sets, SAMPLE]) expect(problems(checkSet(loadSet(d))), d).toEqual([]);
  });

  it("names an app or a slot the set doesn't have", () => {
    const set = sample();
    (set.files.requests as CapabilityFile).sheets[0]!.columns[2]!.link!.capability = "@app:suppliers";
    (set.files.categories as CapabilityFile).roles[0]!.members = { kind: "people", people: ["@slot:principal"] };
    expect(problems(checkSet(set))).toEqual([
      "Categories: names a role slot “principal” that the set doesn't have.",
      "Requests: names an app “suppliers” that isn't in the set.",
    ]);
  });

  it("runs the kernel's file check on each app: over the limits is refused", () => {
    const set = sample();
    const cols = (set.files.categories as CapabilityFile).sheets[0]!.columns;
    for (let i = 0; i < 40; i++) cols.push({ id: `extra_${i}`, name: `Extra ${i}`, type: "text" });
    expect(problems(checkSet(set))[0]).toMatch(/^Categories: .*40/);
  });

  it("refuses a rule that sets itself off again through another app", () => {
    const set = sample();
    const part = (id: string, app: string, sheet: string, to: string, toSheet: string, map: Record<string, unknown>) => ({
      id,
      capabilityId: `@app:${app}`,
      trigger: { kind: "row_created", sheet },
      actions: [{ kind: "create_row_in", target: { capability: `@app:${to}`, sheet: toSheet }, map }],
    });
    set.companyRules = [
      {
        id: "again",
        text: "Each request adds a category, and each category a request.",
        reading: { when: "A request or category is added", then: "One of the other is added" },
        enabled: true,
        applications: [
          part("requests", "requests", "requests", "categories", "categories", { name: "From a request" }),
          part("categories", "categories", "categories", "requests", "requests", { what: "From a category", amount: 1 }),
        ],
      },
    ];
    expect(problems(checkSet(set))).toHaveLength(1);
    expect(problems(checkSet(set))[0]).toMatch(/Categories|Requests/);
  });

  it("refuses two apps with the same name", () => {
    const set = sample();
    (set.files.allowances as CapabilityFile).name = "requests";
    expect(problems(checkSet(set))).toContain("Two apps are called “requests”.");
  });
});

describe("adding a set", () => {
  let k: K;
  let added: Awaited<ReturnType<typeof addSet>>;
  beforeAll(async () => {
    k = await kernelWorkspace();
    added = await k.as("ada", (tx, c) => addFromGallery(tx, c, sample(), choice(k)));
  });
  const id = (key: string) => added.apps.find((a) => a.key === key)!.id;

  it("adds every app in one change set, from the gallery, with the set's name and version", async () => {
    expect(added.apps.map((a) => a.name)).toEqual(["Categories", "Requests", "Allowances"]);
    await k.as("ada", async (tx) => {
      const [cs] = await tx.select().from(changeSets).where(eq(changeSets.id, added.changeSetId));
      expect(cs).toMatchObject({ source: "gallery", kind: "add", setName: "Sample office", setVersion: 1 });
      expect(cs!.items).toEqual(ALL.map((a) => ({ capabilityId: id(a), fromVersion: 0, toVersion: 1 })));
      const entries = await tx.select().from(auditEntries).where(eq(auditEntries.changeSetId, added.changeSetId));
      expect(entries.filter((e) => e.event === "capability.created").map((e) => e.capabilityId)).toEqual(ALL.map(id));
      expect(entries.find((e) => e.event === "set.added")?.details).toEqual({
        set: "Sample office",
        version: 1,
        apps: ["Categories", "Requests", "Allowances"],
        roles: ["Approver: Priya Nair", "Team leads: Rita Gomez and Priya Nair"],
        companyRules: 1,
      });
      expect(entries.some((e) => e.event === "rule.saved" && (e.details as { company?: boolean }).company)).toBe(true);
    });
  });

  it("fills the slots with the people picked and the links with the new apps", async () => {
    await k.as("ada", async (tx) => {
      const requests = (await getFile(tx, id("requests")))!.file;
      expect(requests.roles.find((r) => r.id === "approver")!.members).toEqual({ kind: "people", people: [k.id.priya] });
      expect(requests.rules[0]!.actions[0]).toMatchObject({ kind: "ask_person", person: k.id.priya });
      expect(requests.sheets[0]!.columns.find((c) => c.id === "category")!.link).toEqual({ capability: id("categories"), sheet: "categories", pick: true });
      const categories = (await getFile(tx, id("categories")))!.file;
      expect(categories.roles[0]!.members).toEqual({ kind: "people", people: [k.id.rita, k.id.priya] });
    });
  });

  it("adds the set's company rules to the company's, applied to its apps", async () => {
    const { rules } = await k.as("ada", (tx, c) => companyRules(tx, c));
    expect(rules.map((r) => r.id)).toEqual(["big_requests"]);
    expect(rules[0]!.applications[0]).toMatchObject({ capabilityId: id("requests"), actions: [{ kind: "notify", people: [k.id.rita, k.id.priya] }] });
  });

  it("works at once: a request waits on the approver", async () => {
    const r = await k.as("maya", (tx, c) => createRow(tx, c, id("requests"), "requests", { values: { what: "Monitor", amount: 25000 } }));
    expect(r.data.status).toBe("submitted");
  });

  it("queues the Ontology's writer, as after a build", async () => {
    await k.as("ada", async (tx) => {
      expect(await tx.$count(jobs, and(eq(jobs.kind, "ontology"), eq(jobs.status, "queued")))).toBe(1);
    });
  });

  it("is refused a second time, naming the apps it already has, and writes nothing", async () => {
    const before = await capCount(k);
    await expect(k.as("ada", (tx, c) => addSet(tx, c, sample(), choice(k)))).rejects.toThrow("You already have an app called Categories.");
    const preview = await k.as("ada", (tx, c) => previewSet(tx, c, sample(), choice(k)));
    expect(preview.problems).toEqual([
      "You already have an app called Categories.",
      "You already have an app called Requests.",
      "You already have an app called Allowances.",
    ]);
    expect(await capCount(k)).toBe(before);
  });
});

describe("what's refused before anything is added", () => {
  let k: K;
  beforeAll(async () => {
    k = await kernelWorkspace();
  });
  const refused = async (set: AppSet, c: ReturnType<typeof choice>, as: "ada" | "maya" = "ada") => {
    const before = await capCount(k);
    const err = await k.as(as, (tx, ctx) => addSet(tx, ctx, set, c)).then(() => null, (e: Error) => e.message);
    expect(await capCount(k)).toBe(before);
    return err;
  };

  it("an employee adding a set", async () => {
    expect(await refused(sample(), choice(k), "maya")).toBe("Only admins can do that.");
  });

  it("a slot nobody fills, and a one-person slot filled with two", async () => {
    expect(await refused(sample(), { ...choice(k), slots: { approver: [], team_leads: [k.id.rita] } })).toBe("Pick who is Approver.");
    expect(await refused(sample(), { ...choice(k), slots: { approver: [k.id.priya, k.id.rita], team_leads: [k.id.rita] } })).toBe("Approver is one person: pick one.");
  });

  it("an app picked without one it links to", async () => {
    expect(await refused(sample(), choice(k, ["categories", "allowances"]))).toBe("Allowances needs Requests, so add them together.");
  });

  it("a set whose files don't pass, with every app left out", async () => {
    const set = sample();
    (set.files.requests as CapabilityFile).sheets[0]!.titleColumn = "nothing";
    expect(await refused(set, choice(k))).toMatch(/^Requests: /);
  });

  it("some of the apps: those picked, and the company rules whose apps all came", async () => {
    const only = await k.as("ada", (tx, c) => addSet(tx, c, sample(), { apps: ["categories"], slots: { team_leads: [k.id.rita] } }));
    expect(only.apps.map((a) => a.name)).toEqual(["Categories"]);
    expect((await k.as("ada", (tx, c) => companyRules(tx, c))).rules).toEqual([]);
  });
});

describe("the same set gives the same result", () => {
  it("two companies get the same files, apart from their own ids and people", async () => {
    const files = async () => {
      const k = await kernelWorkspace();
      const added = await k.as("ada", (tx, c) => addSet(tx, c, sample(), choice(k)));
      const names = new Map<string, string>([...added.apps.map((a) => [a.id, `@app:${a.key}`] as [string, string]), [k.id.priya, "priya"], [k.id.rita, "rita"]]);
      const out = await k.as("ada", async (tx) => Promise.all(added.apps.map(async (a) => (await getFile(tx, a.id))!.file)));
      return JSON.parse(JSON.stringify(out).replace(/[0-9a-f-]{36}/g, (m) => names.get(m) ?? m));
    };
    expect(await files()).toEqual(await files());
  });
});

describe("suggestSlots", () => {
  it("suggests people by their job title", () => {
    const people = [
      { id: "a", title: "Office manager" },
      { id: "b", title: "team lead" },
      { id: "c", title: "Designer" },
      { id: "d", title: null },
    ];
    expect(suggestSlots(sample(), people)).toEqual({ approver: ["a"], team_leads: ["b"] });
  });
});
