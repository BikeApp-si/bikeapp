import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { bulkUpdate, createRow, deletePreview, deleteRows, getRow, listRows, previewAdd, updateRow } from "./rows";
import { KernelError } from "./context";
import type { CapabilityFile, Sheet } from "./schema/file";
import { validateFile } from "./schema/validate";
import { renderCapabilityText } from "./render-text";
import { summedColumns } from "./query";
import { accessSummary } from "./access-summary";
import { checkTutorial } from "./tutorial";

// Dated sheets (M30): values kept by the date each starts. The kernel keeps each row's Until, one row per key and
// From, and a row in force as it is; inForce reads the value in force on a row's date, or today.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;
let prices: string;

// The seed's today, as Playwright's clock has it: Oct 27, 2026.
const NOW = new Date("2026-10-27T15:00:00Z");
const LIMIT = { inForce: { sheet: "limits", is: "category", on: "date", value: "limit" } };
const CATEGORIES = [{ id: "meals", name: "Meals" }, { id: "travel", name: "Travel" }];

const limits = (over: Partial<Sheet> = {}): Sheet => ({
  id: "limits",
  name: "Spending limits",
  kind: "dated",
  dated: { key: "category", from: "from", until: "until" },
  titleColumn: "category",
  row: { one: "limit", many: "limits" },
  columns: [
    { id: "category", name: "Category", type: "choice", options: CATEGORIES, required: true },
    { id: "from", name: "From", type: "date", required: true },
    { id: "limit", name: "Limit", type: "money", required: true },
    { id: "until", name: "Until", type: "date" },
  ],
  ...over,
});

const spendFile = (sheet: Sheet = limits(), extra: Partial<CapabilityFile> = {}): CapabilityFile => ({
  name: "Spend",
  icon: "wallet",
  sheets: [
    {
      id: "expenses",
      name: "Expenses",
      kind: "list",
      titleColumn: "what",
      row: { one: "expense", many: "expenses" },
      columns: [
        { id: "what", name: "What for", type: "text", required: true },
        { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
        { id: "date", name: "Date", type: "date", required: true },
        { id: "amount", name: "Amount", type: "money", required: true },
        { id: "category", name: "Category", type: "choice", options: CATEGORIES },
        { id: "limit_then", name: "Limit then", type: "computed", result: "money", expr: LIMIT },
        { id: "limit_row", name: "Limit row", type: "link", link: { sheet: "limits" } },
      ],
      checks: [{ id: "within", name: "Within the limit", condition: { op: "or", args: [{ op: "empty", args: [LIMIT] }, { op: "lte", args: [{ col: "amount" }, LIMIT] }] } }],
    },
    sheet,
  ],
  roles: [
    { id: "finance", name: "Finance", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "delete"], scope: "all" },
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], sheets: ["expenses"], scope: "own", scopeColumns: { expenses: { column: "who" } } },
    { id: "everyone_limits", name: "Everyone on limits", members: { kind: "everyone" }, can: ["see"], sheets: ["limits"], scope: "all" },
  ],
  rules: [],
  later: [],
  ...extra,
});

// A price list kept for products, read today on each product, and a series with no key.
const pricesFile = (): CapabilityFile => ({
  name: "Prices",
  icon: "tag",
  sheets: [
    {
      id: "products",
      name: "Products",
      kind: "list",
      titleColumn: "name",
      columns: [
        { id: "name", name: "Product", type: "text", required: true },
        { id: "now", name: "Price now", type: "computed", result: "money", expr: { inForce: { sheet: "prices", is: "self", value: "price" } } },
        { id: "self", name: "Self", type: "link", link: { sheet: "products" } },
        { id: "rate", name: "Mileage rate", type: "computed", result: "money", expr: { inForce: { sheet: "rates", value: "rate" } } },
      ],
    },
    {
      id: "prices",
      name: "Prices",
      kind: "dated",
      dated: { key: "product", from: "from", until: "until" },
      titleColumn: "product",
      row: { one: "price", many: "prices" },
      columns: [
        { id: "product", name: "Product", type: "link", link: { sheet: "products" }, required: true },
        { id: "from", name: "From", type: "date", required: true },
        { id: "price", name: "Price", type: "money", required: true },
        { id: "until", name: "Until", type: "date" },
      ],
    },
    {
      id: "rates",
      name: "Mileage rates",
      kind: "dated",
      dated: { from: "from", until: "until" },
      titleColumn: "from",
      row: { one: "rate", many: "rates" },
      columns: [
        { id: "from", name: "From", type: "date", required: true },
        { id: "rate", name: "Rate", type: "money", required: true },
        { id: "until", name: "Until", type: "date" },
      ],
    },
  ],
  roles: [{ id: "office", name: "Office", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "delete"], scope: "all" }],
  rules: [],
  later: [],
});

const refused = (p: Promise<unknown>) =>
  p.then(
    () => "saved",
    (e: unknown) => (e instanceof KernelError ? e.message : Promise.reject(e)),
  );
type Who = "ada" | "maya";
const add = (cap: string, sheet: string, values: Record<string, unknown>, who: Who = "ada") =>
  k.as(who, (tx, c) => createRow(tx, c, cap, sheet, { values }), NOW).then((r) => r.id);
const change = (id: string, values: Record<string, unknown>) => k.as("ada", (tx, c) => updateRow(tx, c, id, values), NOW);
const row = (id: string) => k.as("ada", (tx, c) => getRow(tx, c, id), NOW);
const list = (cap: string, sheet: string, who: Who = "ada") => k.as(who, (tx, c) => listRows(tx, c, cap, sheet), NOW);

const errors = (file: CapabilityFile) => {
  const r = validateFile(file);
  return r.ok ? [] : r.errors;
};

beforeAll(async () => {
  k = await kernelWorkspace();
  spend = await k.create(spendFile());
  prices = await k.create(pricesFile());
});

describe("the file", () => {
  it("accepts a dated sheet kept by a choice, by a link, and as one series", () => {
    expect(errors(spendFile())).toEqual([]);
    expect(errors(pricesFile())).toEqual([]);
  });

  it("refuses a dated sheet without its columns, or with them of the wrong kind", () => {
    expect(errors(spendFile(limits({ dated: undefined })))).toContain("Spending limits sheet: a dated sheet names the date each row starts, and what each row is for.");
    expect(errors(spendFile(limits({ dated: { key: "category", from: "limit", until: "until" } }))).join(" ")).toContain("the day each row starts");
    expect(errors(spendFile(limits({ dated: { key: "category", from: "from", until: "from" } }))).join(" ")).toContain("which the kernel keeps");
    expect(errors(spendFile(limits({ dated: { key: "limit", from: "from", until: "until" } }))).join(" ")).toContain("what each row's value is for");
    expect(errors(spendFile({ ...limits(), kind: "list" }))).toContain("Spending limits sheet: only a dated sheet keeps values by the date each starts.");
  });

  it("refuses steps on a dated sheet", () => {
    const stepped = limits();
    stepped.columns.push({ id: "status", name: "Status", type: "step" });
    stepped.steps = [{ id: "a", name: "A", start: true }, { id: "b", name: "B", end: "final" }];
    expect(errors(spendFile(stepped))).toContain("Spending limits sheet: a dated sheet keeps values by date, so it has no steps.");
  });

  it("reads a value in force only from a dated sheet, matched by the same kind of key", () => {
    const notDated = spendFile();
    notDated.sheets[0]!.columns[5] = { id: "limit_then", name: "Limit then", type: "computed", result: "money", expr: { inForce: { sheet: "expenses", value: "amount" } } };
    expect(errors(notDated).join(" ")).toContain("There is no dated sheet “expenses”");
    const wrongKey = spendFile();
    wrongKey.sheets[0]!.columns[5] = { id: "limit_then", name: "Limit then", type: "computed", result: "money", expr: { inForce: { sheet: "limits", is: "what", on: "date", value: "limit" } } };
    expect(errors(wrongKey).join(" ")).toContain("Spending limits can't be matched to Expenses by “what”");
    const otherChoices = spendFile();
    otherChoices.sheets[0]!.columns[4] = { id: "category", name: "Category", type: "choice", options: [{ id: "cloud", name: "Cloud" }] };
    expect(errors(otherChoices).join(" ")).toContain("can't be matched");
    const notADate = spendFile();
    notADate.sheets[0]!.columns[5] = { id: "limit_then", name: "Limit then", type: "computed", result: "money", expr: { inForce: { sheet: "limits", is: "category", on: "what", value: "limit" } } };
    expect(errors(notADate).join(" ")).toContain("“what” isn't a date on Expenses");
  });

  it("refuses a rule that fills Until", () => {
    const file = spendFile(limits(), {
      rules: [
        {
          id: "r",
          text: "Set until",
          reading: { when: "w", then: "t" },
          trigger: { kind: "row_created", sheet: "expenses" },
          actions: [{ kind: "update_row_in", target: { sheet: "limits" }, via: "limit_row", map: { until: "2026-12-31" } }],
          enabled: true,
        },
      ],
    });
    expect(errors(file).join(" ")).toContain("fills Until, which Bike keeps itself in Spending limits.");
  });
});

describe("spending limits", () => {
  let older: string; // Meals $60 from Jan 1, 2025
  let meals: string; // Meals $75 from Jan 1, 2026: in force
  let later: string; // Meals $90 from Nov 1, 2026: still to come

  beforeAll(async () => {
    meals = await add(spend, "limits", { category: "meals", from: "2026-01-01", limit: 7500 });
    later = await add(spend, "limits", { category: "meals", from: "2026-11-01", limit: 9000 });
    // History entered afterwards still finds its place.
    older = await add(spend, "limits", { category: "meals", from: "2025-01-01", limit: 6000 });
  });

  it("keeps each row's Until: the day before the next one for the same key starts", async () => {
    expect((await row(older)).data.until).toBe("2025-12-31");
    expect((await row(meals)).data.until).toBe("2026-10-31");
    expect((await row(later)).data.until).toBeUndefined();
  });

  it("says which row is in force today, which is still to come and which is over", async () => {
    expect((await row(older)).dated).toBe("past");
    expect((await row(meals)).dated).toBe("now");
    expect((await row(later)).dated).toBe("later");
  });

  it("refuses a second row for the same key from the same day", async () => {
    expect(await refused(add(spend, "limits", { category: "meals", from: "2026-11-01", limit: 9500 }))).toBe("Meals already has a limit from Nov 1, 2026.");
    // Another key may start that day.
    expect(await refused(add(spend, "limits", { category: "travel", from: "2026-11-01", limit: 50000 }).then(async (id) => {
      await k.as("ada", (tx, c) => deleteRows(tx, c, [id]), NOW);
    }))).toBe("saved");
  });

  it("keeps a row in force as it is: change, bulk change, delete and the delete preview are refused", async () => {
    const reason = "Limits already in force can't be changed. Add a new one from the date it changes.";
    expect(await refused(change(meals, { limit: 8000 }))).toBe(reason);
    expect(await refused(change(older, { limit: 1 }))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => bulkUpdate(tx, c, [later, meals], { values: { limit: 1 } }), NOW))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [meals]), NOW))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => deletePreview(tx, c, [meals]), NOW))).toBe(reason);
    expect((await row(meals)).data.limit).toBe(7500);
    expect((await row(later)).data.limit).toBe(9000);
  });

  it("lets a row still to come be changed, but not to start today or before", async () => {
    await change(later, { limit: 9500 });
    expect((await row(later)).data.limit).toBe(9500);
    expect(await refused(change(later, { from: "2026-10-27" }))).toBe("A limit can be changed only to start after today.");
    await change(later, { from: "2026-12-01" });
    expect((await row(meals)).data.until).toBe("2026-11-30");
    await change(later, { from: "2026-11-01", limit: 9000 });
    expect((await row(meals)).data.until).toBe("2026-10-31");
  });

  it("lets a row still to come be deleted, and the one before it lasts again", async () => {
    const extra = await add(spend, "limits", { category: "meals", from: "2027-01-01", limit: 10000 });
    expect((await row(later)).data.until).toBe("2026-12-31");
    await k.as("ada", (tx, c) => deleteRows(tx, c, [extra]), NOW);
    expect((await row(later)).data.until).toBeUndefined();
  });

  it("reads the limit in force on each expense's date", async () => {
    const oct = await add(spend, "expenses", { what: "Lunch, Oct 1", date: "2026-10-01", amount: 5000, category: "meals" });
    const nov = await add(spend, "expenses", { what: "Lunch, Nov 3", date: "2026-11-03", amount: 5000, category: "meals" });
    const old = await add(spend, "expenses", { what: "Lunch, 2025", date: "2025-06-01", amount: 5000, category: "meals" });
    const travel = await add(spend, "expenses", { what: "Taxi", date: "2026-10-01", amount: 5000, category: "travel" });
    expect((await row(oct)).data.limit_then).toBe(7500);
    expect((await row(nov)).data.limit_then).toBe(9000);
    expect((await row(old)).data.limit_then).toBe(6000);
    expect((await row(travel)).data.limit_then).toBeUndefined();
    // The same read, the same answer.
    expect((await list(spend, "expenses")).map((r) => r.data.limit_then)).toEqual((await list(spend, "expenses")).map((r) => r.data.limit_then));
  });

  it("refuses an $85 meal on Oct 20 by the check, and lets it through on Nov 3", async () => {
    const reason = await refused(add(spend, "expenses", { what: "Client dinner", date: "2026-10-20", amount: 8500, category: "meals" }, "maya"));
    expect(reason).toBe("Within the limit: it needs the Limit in Spending limits for the same Category, in force on Date is empty or Amount at most the Limit in Spending limits for the same Category, in force on Date.");
    const preview = await k.as("maya", (tx, c) => previewAdd(tx, c, spend, "expenses", { what: "Client dinner", date: "2026-10-20", amount: 8500, category: "meals" }), NOW);
    expect(JSON.stringify(preview)).toContain("Within the limit");
    expect(await refused(add(spend, "expenses", { what: "Client dinner", date: "2026-11-03", amount: 8500, category: "meals" }, "maya"))).toBe("saved");
  });

  it("lets everyone see the limits but only Finance add one", async () => {
    expect((await list(spend, "limits", "maya")).length).toBe(3);
    await expect(add(spend, "limits", { category: "travel", from: "2027-01-01", limit: 1 }, "maya")).rejects.toThrow("You can't do that here.");
  });
});

describe("a rule's change", () => {
  it("is refused on a row in force, like a person's", async () => {
    const file = spendFile(limits(), {
      rules: [
        {
          id: "r",
          text: "Raise the limit",
          reading: { when: "an expense names a limit", then: "its limit is raised" },
          trigger: { kind: "row_created", sheet: "expenses" },
          actions: [{ kind: "update_row_in", target: { sheet: "limits" }, via: "limit_row", map: { limit: 1 } }],
          enabled: true,
        },
      ],
    });
    const cap = await k.create(file);
    const inForce = await add(cap, "limits", { category: "meals", from: "2026-01-01", limit: 7500 });
    // All or nothing: the expense that ran the rule isn't added either.
    expect(await refused(add(cap, "expenses", { what: "Lunch", date: "2026-10-01", amount: 100, category: "meals", limit_row: inForce }))).toBe(
      "Limits already in force can't be changed. Add a new one from the date it changes.",
    );
    expect((await row(inForce)).data.limit).toBe(7500);
    expect((await list(cap, "expenses")).length).toBe(0);
  });
});

describe("prices kept for products, and one series", () => {
  it("reads today's price on each product and today's rate with no key", async () => {
    const laptop = await add(prices, "products", { name: "Laptop" });
    await change(laptop, { self: laptop });
    await add(prices, "prices", { product: laptop, from: "2026-01-01", price: 120000 });
    await add(prices, "prices", { product: laptop, from: "2026-12-01", price: 110000 });
    await add(prices, "rates", { from: "2026-01-01", rate: 67 });
    await add(prices, "rates", { from: "2026-07-01", rate: 70 });
    expect(await refused(add(prices, "rates", { from: "2026-07-01", rate: 71 }))).toBe("There is already a rate from Jul 1, 2026.");
    const r = await row(laptop);
    expect(r.data.now).toBe(120000);
    expect(r.data.rate).toBe(70);
  });

  it("refuses deleting a product whose prices are in force", async () => {
    const [laptop] = (await list(prices, "products")).filter((r) => r.data.name === "Laptop");
    expect(await refused(k.as("ada", (tx, c) => deletePreview(tx, c, [laptop!.id]), NOW))).toBe("Laptop has prices already in force, so it can't be deleted.");
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [laptop!.id]), NOW))).toBe("Laptop has prices already in force, so it can't be deleted.");
  });
});

describe("how a dated sheet reads", () => {
  const sheetText = (file: CapabilityFile, heading: string) =>
    renderCapabilityText(file, { capId: "x", files: new Map([["x", file]]), personName: () => undefined, viewerId: null }).find((t) => t.heading === heading)!.lines;

  it("says how its rows are kept by date, what Until is, and the check that reads it", () => {
    expect(sheetText(spendFile(), "Spending limits sheet")).toEqual([
      "Category (Meals or Travel, required), From (date, required), Limit (money, required), Until (the day before the next limit for the same category).",
      "Spending limits are kept by date: each category's limit starts on its From date and lasts until the next one. A limit already in force can't be changed or deleted; add a new one from the date it changes.",
    ]);
    expect(sheetText(spendFile(), "Expenses sheet")).toContain(
      "An expense is added only when the Limit in Spending limits for the same Category, in force on Date is empty or Amount at most the Limit in Spending limits for the same Category, in force on Date (Within the limit).",
    );
    expect(sheetText(pricesFile(), "Mileage rates sheet")[1]).toBe(
      "Mileage rates are kept by date: each rate starts on its From date and lasts until the next one. A rate already in force can't be changed or deleted; add a new one from the date it changes.",
    );
  });

  it("adds nothing up under the table", () => {
    expect(summedColumns(limits())).toEqual([]);
  });

  it("lists each key's rows together, the newest first", async () => {
    const rows = await list(spend, "limits");
    expect(rows.map((r) => [r.data.category, r.data.from])).toEqual([
      ["meals", "2026-11-01"],
      ["meals", "2026-01-01"],
      ["meals", "2025-01-01"],
    ]);
  });

  it("tells how-to steps that a change is a new one from the date it changes", async () => {
    const ada = await k.as("ada", (tx, c) => accessSummary(tx, c, spend), NOW);
    expect(ada.sheets.find((x) => x.name === "Spending limits")).toMatchObject({ dated: true, edit: true });
    expect(ada.sheets.find((x) => x.name === "Expenses")).not.toHaveProperty("dated");
    const step = (text: string) => ({ purpose: "x", waits: [], cannot: [], steps: [{ title: "Change a limit", text, does: { kind: "edit" as const, sheet: "Spending limits", step: null } }] });
    expect(checkTutorial(ada, step("Open the limit and change its amount."))).toEqual([
      "Step 1 (“Change a limit”): limits in force aren't changed; a change is a new one from the date it changes.",
    ]);
    expect(checkTutorial(ada, step("Add a new one from the date it changes."))).toEqual([]);
  });
});
