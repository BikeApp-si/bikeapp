import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { createRow, deletePreview, deleteRows, getRow, listRows, sheetTotals, updateRow } from "./rows";
import { treeOrder } from "./tree";
import { notAdditive } from "./plans/compile";
import { KernelError } from "./context";
import type { CapabilityFile, Sheet } from "./schema/file";
import { LIMITS, validateFile } from "./schema/validate";

// Trees (M28): cost centres sit under each other; a cost centre's Total spent is its own expenses plus the totals of
// the ones under it, at any depth, in the same save. The kernel refuses a loop, too many levels, and deleting a
// cost centre with others under it.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let cap: string;

const centres = (over: Partial<Sheet> = {}): Sheet => ({
  id: "centres",
  name: "Cost centres",
  kind: "tree",
  tree: { parent: "under" },
  titleColumn: "name",
  row: { one: "cost centre", many: "cost centres" },
  columns: [
    { id: "name", name: "Cost centre", type: "text", required: true },
    { id: "under", name: "Under", type: "link", link: { sheet: "centres" } },
    { id: "owner", name: "Owner", type: "person" },
    { id: "spent", name: "Spent", type: "computed", result: "money", expr: { sumOf: { sheet: "expenses", column: "amount", by: "centre" } } },
    {
      id: "total",
      name: "Total spent",
      type: "computed",
      result: "money",
      expr: { op: "add", args: [{ col: "spent" }, { sumOf: { sheet: "centres", column: "total", by: "under" } }] },
    },
  ],
  ...over,
});

const spend = (sheet: Sheet = centres()): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    sheet,
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "centre", name: "Cost centre", type: "link", link: { sheet: "centres" } },
      ],
    },
  ],
  roles: [
    { id: "finance", name: "Finance", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "delete"], scope: "all" },
    // Owners see only the cost centres they own.
    { id: "owners", name: "Owners", members: { kind: "column", sheet: "centres", column: "owner" }, can: ["see"], sheets: ["centres"], scope: "own", scopeColumns: { centres: { column: "owner" } } },
  ],
  rules: [],
  later: [],
});

const centre = (name: string, under?: string, owner?: string) =>
  k.as("ada", (tx, c) => createRow(tx, c, cap, "centres", { values: { name, ...(under ? { under } : {}), ...(owner ? { owner } : {}) } })).then((r) => r.id);
const expense = (what: string, amount: number, centre: string) =>
  k.as("ada", (tx, c) => createRow(tx, c, cap, "expenses", { values: { what, amount, centre } })).then((r) => r.id);
const totals = (...ids: string[]) => Promise.all(ids.map((id) => k.as("ada", (tx, c) => getRow(tx, c, id)).then((r) => r.data.total)));
const refused = (p: Promise<unknown>) =>
  p.then(
    () => "saved",
    (e: unknown) => (e instanceof KernelError ? e.message : Promise.reject(e)),
  );

beforeAll(async () => {
  k = await kernelWorkspace();
  cap = await k.create(spend());
});

describe("the file", () => {
  const errors = (sheet: Sheet) => {
    const r = validateFile(spend(sheet));
    return r.ok ? [] : r.errors;
  };

  it("accepts a tree whose parent is a link to its own sheet", () => {
    expect(errors(centres())).toEqual([]);
  });

  it("refuses a tree without a parent column, a parent that isn't a link to itself, a required or title parent", () => {
    expect(errors(centres({ tree: undefined }))[0]).toMatch(/names the column that says which row/);
    const elsewhere = centres();
    elsewhere.columns[1] = { id: "under", name: "Under", type: "link", link: { sheet: "expenses" } };
    expect(errors(elsewhere)[0]).toMatch(/must be a link to Cost centres itself/);
    const required = centres();
    required.columns[1] = { ...required.columns[1]!, required: true };
    expect(errors(required)[0]).toMatch(/isn't required/);
  });

  it("refuses rows under each other on a sheet that isn't a tree, and a sum over its own rows outside a tree", () => {
    expect(errors(centres({ kind: "list" })).join(" ")).toMatch(/only a tree sheet has rows that sit under each other/);
    const list = centres({ kind: "list", tree: undefined });
    expect(errors(list).join(" ")).toMatch(/adds up its own rows only when they sit under each other/);
  });
});

describe("changing a capability", () => {
  const asList = (): Sheet => {
    const t = centres({ kind: "list", tree: undefined });
    return { ...t, columns: t.columns.filter((c) => c.id !== "under" && c.id !== "total") };
  };

  it("a list becomes a tree through a new column naming the row above, as an addition", () => {
    expect(notAdditive(spend(asList()), spend())).toEqual([]);
  });

  it("refuses a tree turned back into a list, a tree through a column that already holds data, and another parent", () => {
    expect(notAdditive(spend(), spend(centres({ kind: "list", tree: undefined })))).toEqual(["Cost centres would stop being a tree, which moves data."]);
    const withLink = centres({ kind: "list", tree: undefined });
    expect(notAdditive(spend(withLink), spend())).toEqual(["Cost centres can become a tree only through a new column naming the row each one sits under."]);
    const other = centres({ tree: { parent: "above" } });
    other.columns.push({ id: "above", name: "Above", type: "link", link: { sheet: "centres" } });
    expect(notAdditive(spend(), spend(other))).toEqual(["Cost centres would sit under each other through another column, which moves data."]);
  });
});

describe("totals", () => {
  it("include every cost centre under it, at any depth, in the same save", async () => {
    // Five levels: Company › Engineering › Platform › Cloud › Hosting.
    const company = await centre("Company");
    const eng = await centre("Engineering", company);
    const platform = await centre("Platform", eng);
    const cloud = await centre("Cloud", platform);
    const hosting = await centre("Hosting", cloud);
    await expense("Conference", 450_00, eng);
    await expense("AWS", 1_240_00, hosting);
    expect(await totals(company, eng, platform, cloud, hosting)).toEqual([1_690_00, 1_690_00, 1_240_00, 1_240_00, 1_240_00]);
  });

  it("move with a branch: both the old chain and the new one are worked out again", async () => {
    const top = await centre("Top");
    const a = await centre("A", top);
    const b = await centre("B", top);
    const a1 = await centre("A1", a);
    const a2 = await centre("A2", a1);
    await expense("Laptop", 2_000_00, a2);
    expect(await totals(top, a, b, a1)).toEqual([2_000_00, 2_000_00, 0, 2_000_00]);
    // A1 (with A2 under it) moves under B.
    await k.as("ada", (tx, c) => updateRow(tx, c, a1, { under: b }));
    expect(await totals(top, a, b, a1, a2)).toEqual([2_000_00, 0, 2_000_00, 2_000_00, 2_000_00]);
    // An expense changed far down shows at the top.
    const e = await expense("Mouse", 50_00, a2);
    expect(await totals(top, b)).toEqual([2_050_00, 2_050_00]);
    await k.as("ada", (tx, c) => deleteRows(tx, c, [e]));
    expect(await totals(top, b)).toEqual([2_000_00, 2_000_00]);
  });

  it("are the same when the same writes run again", async () => {
    const run = async (name: string) => {
      const root = await centre(name);
      let at = root;
      for (const [i, n] of [300, 700, 1_100].entries()) {
        at = await centre(`${name} ${i}`, at);
        await expense(`${name} spend ${i}`, n, at);
      }
      return totals(root);
    };
    expect(await run("One")).toEqual([2_100]);
    expect(await run("Two")).toEqual([2_100]);
  });
});

describe("the kernel keeps it a tree", () => {
  it("refuses a cost centre under itself or under one below it", async () => {
    const eng = await centre("Engineering two");
    const platform = await centre("Platform two", eng);
    const web = await centre("Web two", platform);
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, eng, { under: eng })))).toBe("A cost centre can't sit under itself.");
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, eng, { under: platform })))).toBe(
      "Platform two sits under Engineering two, so Engineering two can't go under it.",
    );
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, eng, { under: web })))).toBe(
      "Web two sits under Engineering two, so Engineering two can't go under it.",
    );
    // Nothing was written.
    expect((await k.as("ada", (tx, c) => getRow(tx, c, eng))).data.under).toBeUndefined();
  });

  it(`refuses a level below the ${LIMITS.treeDepth}th, for a new row and for a branch moved down`, async () => {
    let at = await centre("Deep 1");
    const chain = [at];
    for (let i = 2; i <= LIMITS.treeDepth; i++) chain.push((at = await centre(`Deep ${i}`, at)));
    expect(await refused(centre("Deep 9", at))).toBe(`Cost centres go at most ${LIMITS.treeDepth} levels deep.`);
    // A two-level branch can go under level 6 but not under level 7.
    const branch = await centre("Branch");
    await centre("Branch child", branch);
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, branch, { under: chain[6]! })))).toMatch(/at most 8 levels/);
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, branch, { under: chain[5]! })))).toBe("saved");
  });

  it("refuses deleting a cost centre with others under it, and allows it once they go too", async () => {
    const ops = await centre("Operations");
    const office = await centre("Office", ops);
    await centre("Facilities", ops);
    const msg = "2 cost centres sit under Operations. Move them first.";
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [ops])))).toBe(msg);
    expect(await refused(k.as("ada", (tx, c) => deletePreview(tx, c, [ops])))).toBe(msg);
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [ops, office])))).toBe("1 cost centre sits under Operations. Move it first.");
    // A cost centre with nothing under it goes, and nothing else goes with it.
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [office])))).toBe("saved");
  });
});

describe("reading a tree", () => {
  it("puts each row under its row above, depth first, siblings in the order they came", () => {
    const r = (id: string, under?: string) => ({ id, data: under ? { under } : {} });
    const out = treeOrder([r("c", "a"), r("a"), r("b"), r("d", "c"), r("e", "a")], "under");
    expect(out.map((x) => [x.id, x.level, x.branch])).toEqual([
      ["a", 0, true],
      ["c", 1, true],
      ["d", 2, false],
      ["e", 1, false],
      ["b", 0, false],
    ]);
    // A loop in stored data still shows every row once.
    expect(treeOrder([r("x", "y"), r("y", "x")], "under").map((x) => x.id).sort()).toEqual(["x", "y"]);
  });

  it("reads in tree order with its levels, flat when sorted, and the footer leaves out the total that includes the rows under it", async () => {
    const k2 = await kernelWorkspace();
    const [prev, prevCap] = [k, cap];
    k = k2;
    try {
      cap = await k.create(spend());
      const root = await centre("Root");
      const later = await centre("Later top");
      const child = await centre("Child", root);
      await centre("Grandchild", child);
      await expense("Rent", 100_00, child);
      const read = (opts = {}) => k.as("ada", (tx, c) => listRows(tx, c, cap, "centres", opts));
      expect((await read()).map((x) => [x.data.name, x.level, x.branch])).toEqual([
        ["Root", 0, true],
        ["Child", 1, true],
        ["Grandchild", 2, false],
        ["Later top", 0, false],
      ]);
      expect((await read({ offset: 1, limit: 2 })).map((x) => x.data.name)).toEqual(["Child", "Grandchild"]);
      const sorted = await read({ sort: { column: "name", dir: "asc" } });
      expect(sorted.map((x) => x.data.name)).toEqual(["Child", "Grandchild", "Later top", "Root"]);
      expect(sorted[0]!.level).toBeUndefined();
      const sums = await k.as("ada", (tx, c) => sheetTotals(tx, c, cap, "centres"));
      expect(JSON.stringify(sums)).toContain("spent");
      expect(JSON.stringify(sums)).not.toContain("total");
      void later;
    } finally {
      [k, cap] = [prev, prevCap];
    }
  });

  it("shows someone the rows they may see, a row whose row above they can't see at the top", async () => {
    const eng = await centre("Eng (Ada)");
    const platform = await centre("Platform (Priya)", eng, k.id.priya);
    await centre("Cloud (Priya)", platform, k.id.priya);
    await centre("Web (Omar)", eng, k.id.omar);
    const seen = await k.as("priya", (tx, c) => listRows(tx, c, cap, "centres"));
    expect(seen.map((x) => [x.data.name, x.level])).toEqual([
      ["Platform (Priya)", 0],
      ["Cloud (Priya)", 1],
    ]);
  });
});
