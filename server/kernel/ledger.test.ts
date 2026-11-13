import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { bulkUpdate, createRow, deletePreview, deleteRows, getRow, importRows, listRows, moveStep, reverseEntry, updateRow } from "./rows";
import { listAudit } from "./audit";
import { KernelError } from "./context";
import type { CapabilityFile, Sheet } from "./schema/file";
import { validateFile } from "./schema/validate";
import { renderCapabilityText } from "./render-text";
import { summedColumns } from "./query";
import { accessSummary } from "./access-summary";
import { checkTutorial } from "./tutorial";

// Ledgers (M29): entries are only added. The kernel works out the balance after each entry and the balance on the row
// it counts toward in the same save, refuses any change or delete, reverses a wrong entry once, and keeps an account
// from going below a ledger's lowest balance on every write.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let stock: string;
let timeOff: string;

const moves = (over: Partial<Sheet> = {}): Sheet => ({
  id: "moves",
  name: "Moves",
  kind: "ledger",
  ledger: { account: "item", amount: "qty", balance: "after", reverses: "reverses", min: 0 },
  titleColumn: "what",
  row: { one: "move", many: "moves" },
  columns: [
    { id: "what", name: "Move", type: "text", required: true },
    { id: "item", name: "Item", type: "link", link: { sheet: "items" }, required: true },
    { id: "qty", name: "Quantity", type: "number", required: true },
    { id: "after", name: "In stock after", type: "number" },
    { id: "reverses", name: "Reverses", type: "link", link: { sheet: "moves" } },
  ],
  ...over,
});

const stockFile = (sheet: Sheet = moves(), extra: Partial<CapabilityFile> = {}): CapabilityFile => ({
  name: "Stock",
  icon: "package",
  sheets: [
    {
      id: "items",
      name: "Items",
      kind: "list",
      titleColumn: "name",
      row: { one: "item", many: "items" },
      columns: [
        { id: "name", name: "Item", type: "text", required: true },
        { id: "stock", name: "In stock", type: "computed", result: "number", expr: { balanceOf: { sheet: "moves" } } },
      ],
    },
    sheet,
  ],
  roles: [
    { id: "office", name: "Office", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "delete"], scope: "all" },
    { id: "staff", name: "Staff", members: { kind: "people", people: [k.id.maya] }, can: ["see"], scope: "all" },
  ],
  rules: [],
  later: [],
  ...extra,
});

const timeOffFile = (): CapabilityFile => ({
  name: "Time off",
  icon: "calendar-days",
  sheets: [
    {
      id: "requests",
      name: "Requests",
      kind: "list",
      titleColumn: "what",
      columns: [
        { id: "what", name: "Request", type: "text", required: true },
        { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
        { id: "days", name: "Days", type: "days", required: true },
        { id: "status", name: "Status", type: "step" },
      ],
      steps: [
        { id: "submitted", name: "Submitted", start: true },
        { id: "approved", name: "Approved", end: "final" },
        { id: "declined", name: "Declined", end: "exit" },
      ],
    },
    {
      id: "balances",
      name: "Balances",
      kind: "list",
      titleColumn: "who",
      columns: [
        { id: "who", name: "Who", type: "person", required: true },
        { id: "allowance", name: "Days a year", type: "days" },
        { id: "used", name: "Used", type: "days" },
        {
          id: "left",
          name: "Left",
          type: "computed",
          result: "days",
          expr: { op: "add", args: [{ op: "sub", args: [{ col: "allowance" }, { col: "used" }] }, { balanceOf: { sheet: "leave", of: "who" } }] },
        },
      ],
    },
    {
      id: "leave",
      name: "Leave entries",
      kind: "ledger",
      ledger: { account: "who", amount: "days", balance: "after", reverses: "reverses" },
      titleColumn: "entry",
      row: { one: "entry", many: "entries" },
      columns: [
        { id: "entry", name: "Entry", type: "text", required: true },
        { id: "who", name: "Who", type: "person", required: true },
        { id: "days", name: "Days", type: "days", required: true },
        { id: "request", name: "Request", type: "link", link: { sheet: "requests" } },
        { id: "after", name: "Balance after", type: "days" },
        { id: "reverses", name: "Reverses", type: "link", link: { sheet: "leave" } },
      ],
    },
  ],
  roles: [
    { id: "admins", name: "Time off admins", members: { kind: "people", people: [k.id.ada] }, can: ["see", "add", "edit", "delete", "move_steps"], scope: "all" },
    { id: "managers", name: "Managers", members: { kind: "people", people: [k.id.priya] }, can: ["see", "move_steps"], scope: "all" },
    { id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], sheets: ["requests"], scope: "own", scopeColumns: { requests: { column: "who" } } },
    // As Customize leaves it (customize/sheet-access.ts): their own entries, only seen.
    { id: "everyone_leave", name: "Everyone on Leave entries", members: { kind: "everyone" }, can: ["see"], sheets: ["leave"], scope: "own", scopeColumns: { leave: { column: "who" } }, beside: { role: "everyone", sheet: "leave" } },
  ],
  rules: [
    {
      id: "takes_days",
      text: "When a request is approved, a leave entry takes its days off.",
      reading: { when: "a request is approved", then: "a leave entry takes its days off" },
      trigger: { kind: "enters_step", sheet: "requests", step: "approved" },
      actions: [
        {
          kind: "create_row_in",
          target: { sheet: "leave" },
          map: { entry: { col: "what" }, who: { col: "who" }, days: { op: "sub", args: [0, { col: "days" }] }, request: { ref: "row" } },
        },
      ],
      enabled: true,
    },
  ],
  later: [],
});

const refused = (p: Promise<unknown>) =>
  p.then(
    () => "saved",
    (e: unknown) => (e instanceof KernelError ? e.message : Promise.reject(e)),
  );
const add = (cap: string, sheet: string, values: Record<string, unknown>) => k.as("ada", (tx, c) => createRow(tx, c, cap, sheet, { values })).then((r) => r.id);
const row = (id: string) => k.as("ada", (tx, c) => getRow(tx, c, id));
const count = (cap: string, sheet: string) => k.as("ada", (tx, c) => listRows(tx, c, cap, sheet)).then((r) => r.length);

beforeAll(async () => {
  k = await kernelWorkspace();
  stock = await k.create(stockFile());
  timeOff = await k.create(timeOffFile());
});

describe("the file", () => {
  const errors = (file: CapabilityFile) => {
    const r = validateFile(file);
    return r.ok ? [] : r.errors;
  };

  it("accepts a ledger kept for a linked row, and one kept for a person", () => {
    expect(errors(stockFile())).toEqual([]);
    expect(errors(timeOffFile())).toEqual([]);
  });

  it("refuses a ledger without its columns, or with them of the wrong kind", () => {
    expect(errors(stockFile(moves({ ledger: undefined })))).toContain("Moves sheet: a ledger names whose balance each entry counts toward, and the amount.");
    const m = moves();
    m.columns[1] = { ...m.columns[1]!, required: false };
    expect(errors(stockFile(m)).join(" ")).toContain("must be a required person or link column");
    expect(errors(stockFile(moves({ ledger: { account: "item", amount: "what", balance: "after", reverses: "reverses" } }))).join(" ")).toContain("the entry's amount");
    expect(errors(stockFile(moves({ ledger: { account: "item", amount: "qty", balance: "what", reverses: "reverses" } }))).join(" ")).toContain("the kernel keeps");
    expect(errors(stockFile(moves({ ledger: { account: "item", amount: "qty", balance: "after", reverses: "item" } }))).join(" ")).toContain("the entry a reversal reverses");
    expect(errors(stockFile({ ...moves(), kind: "list" }))).toContain("Moves sheet: only a ledger sheet keeps a balance.");
  });

  it("refuses steps on a ledger, and a rule that changes an entry", () => {
    const stepped = moves();
    stepped.columns.push({ id: "status", name: "Status", type: "step" });
    stepped.steps = [{ id: "a", name: "A", start: true }, { id: "b", name: "B", end: "final" }];
    expect(errors(stockFile(stepped))).toContain("Moves sheet: entries are only added, so a ledger has no steps.");
    const withRule = stockFile(moves(), {
      rules: [
        {
          id: "r",
          text: "Change the move",
          reading: { when: "w", then: "t" },
          trigger: { kind: "row_created", sheet: "moves" },
          actions: [{ kind: "update_row_in", target: { sheet: "moves" }, via: "reverses", map: { qty: 1 } }],
          enabled: true,
        },
      ],
    });
    expect(errors(withRule).join(" ")).toContain("its entries are only added");
  });

  it("reads a balance only from a ledger kept for the row", () => {
    const file = stockFile();
    file.sheets[0]!.columns[1] = { id: "stock", name: "In stock", type: "computed", result: "number", expr: { balanceOf: { sheet: "items" } } };
    expect(errors(file).join(" ")).toContain("There is no ledger “items”");
  });
});

describe("stock moves", () => {
  let laptops: string;
  let bought: string;
  let given: string;

  beforeAll(async () => {
    laptops = await add(stock, "items", { name: "Laptops" });
    bought = await add(stock, "moves", { what: "Bought from the supplier", item: laptops, qty: 5 });
    given = await add(stock, "moves", { what: "Given to new starters", item: laptops, qty: -3 });
  });

  it("keeps the balance after each entry, and the item's balance, in the same save", async () => {
    expect((await row(bought)).data.after).toBe(5);
    expect((await row(given)).data.after).toBe(2);
    expect((await row(laptops)).data.stock).toBe(2);
  });

  it("refuses a move below zero with a plain reason, writing nothing", async () => {
    const before = await count(stock, "moves");
    expect(await refused(add(stock, "moves", { what: "Too many", item: laptops, qty: -3 }))).toBe("Laptops has 2, so 3 can't be taken.");
    expect(await count(stock, "moves")).toBe(before);
    expect((await row(laptops)).data.stock).toBe(2);
  });

  it("refuses it from an import too", async () => {
    expect(await refused(k.as("ada", (tx, c) => importRows(tx, c, stock, "moves", [{ values: { what: "Old", item: laptops, qty: -9 } }], { source: "test.csv" })))).toBe(
      "Row 1: Laptops has 2, so 9 can't be taken.",
    );
  });

  it("never lets two moves at once take the same stock twice", async () => {
    const results = await Promise.all([1, 2].map(() => refused(add(stock, "moves", { what: "At once", item: laptops, qty: -2 }))));
    expect(results.sort()).toEqual(["Laptops has 0, so 2 can't be taken.", "saved"]);
    expect((await row(laptops)).data.stock).toBe(0);
    // Put them back for the tests below.
    await add(stock, "moves", { what: "Returned", item: laptops, qty: 2 });
  });

  it("refuses a change, a bulk change, a delete and its preview, with the same plain reason", async () => {
    const reason = "Moves are only added. To correct one, reverse it.";
    expect(await refused(k.as("ada", (tx, c) => updateRow(tx, c, given, { qty: -1 })))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => bulkUpdate(tx, c, [given], { values: { what: "Changed" } })))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [given])))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => deletePreview(tx, c, [given])))).toBe(reason);
    expect((await row(given)).data.qty).toBe(-3);
  });

  it("refuses to delete an item that has moves", async () => {
    const reason = "Laptops has moves, which are only added, so it can't be deleted.";
    expect(await refused(k.as("ada", (tx, c) => deletePreview(tx, c, [laptops])))).toBe(reason);
    expect(await refused(k.as("ada", (tx, c) => deleteRows(tx, c, [laptops])))).toBe(reason);
  });

  it("never lets a person type the balance or a reversal", async () => {
    expect(await refused(add(stock, "moves", { what: "x", item: laptops, qty: 1, after: 99 }))).toBe("In stock after is worked out by Bike.");
    expect(await refused(add(stock, "moves", { what: "x", item: laptops, qty: 1, reverses: given }))).toBe("Reverses is filled in when an entry is reversed.");
  });

  it("refuses a reversal that would take the stock below zero", async () => {
    expect((await row(laptops)).data.stock).toBe(2);
    expect(await refused(k.as("ada", (tx, c) => reverseEntry(tx, c, bought)))).toBe("Laptops has 2, so 5 can't be taken.");
  });

  it("reverses a move once, pointing back to it", async () => {
    const r = await k.as("ada", (tx, c) => reverseEntry(tx, c, given));
    expect(r.data).toMatchObject({ what: "Reverses Given to new starters", item: laptops, qty: 3, reverses: given, after: 5 });
    expect((await row(laptops)).data.stock).toBe(5);
    expect(await refused(k.as("ada", (tx, c) => reverseEntry(tx, c, given)))).toBe("Given to new starters is already reversed.");
    expect(await refused(k.as("ada", (tx, c) => reverseEntry(tx, c, r.id)))).toBe("This move reverses another, so it can't be reversed.");
    const { entries } = await k.as("ada", (tx, c) => listAudit(tx, c, {}));
    expect(entries.find((e) => e.event === "row.reversed")?.details).toMatchObject({ sheet: "Moves", row: "Given to new starters", by: "Reverses Given to new starters" });
  });

  it("reads a reversed move as reversed", async () => {
    const list = await k.as("ada", (tx, c) => listRows(tx, c, stock, "moves"));
    expect(list.find((r) => r.id === given)?.reversed).toBe(true);
    expect(list.filter((r) => r.reversed)).toHaveLength(1);
  });

  it("lets only someone who may add moves reverse one", async () => {
    expect(await k.as("maya", (tx, c) => reverseEntry(tx, c, bought)).then(() => "saved", (e: Error) => e.message)).toBe("You can't do that here.");
  });
});

describe("leave", () => {
  it("takes an approved request's days off Left in the same save, and gives them back when reversed", async () => {
    await add(timeOff, "balances", { who: k.id.maya, allowance: 20, used: 8 });
    const [balance] = await k.as("ada", (tx, c) => listRows(tx, c, timeOff, "balances"));
    expect(balance!.data.left).toBe(12);

    const request = await k.as("maya", (tx, c) => createRow(tx, c, timeOff, "requests", { values: { what: "Vacation, Nov 23–25", days: 3 } })).then((r) => r.id);
    await k.as("priya", (tx, c) => moveStep(tx, c, request, "approved"));
    const [entry] = await k.as("ada", (tx, c) => listRows(tx, c, timeOff, "leave"));
    expect(entry!.data).toMatchObject({ entry: "Vacation, Nov 23–25", who: k.id.maya, days: -3, request, after: -3 });
    expect((await row(balance!.id)).data.left).toBe(9);

    await k.as("ada", (tx, c) => reverseEntry(tx, c, entry!.id));
    expect((await row(balance!.id)).data.left).toBe(12);
  });

  it("shows Maya her own entries only, and lets her add or reverse none", async () => {
    await add(timeOff, "leave", { entry: "Sick, Oct 20", who: k.id.omar, days: -1 });
    const mine = await k.as("maya", (tx, c) => listRows(tx, c, timeOff, "leave"));
    expect(mine.length).toBe(2);
    expect(mine.every((r) => r.data.who === k.id.maya)).toBe(true);
    const fail = (p: Promise<unknown>) => p.then(() => "saved", (e: Error) => e.message);
    expect(await fail(k.as("maya", (tx, c) => createRow(tx, c, timeOff, "leave", { values: { entry: "Free days", who: k.id.maya, days: 10 } })))).toBe("You can't do that here.");
    expect(await fail(k.as("maya", (tx, c) => reverseEntry(tx, c, mine[1]!.id)))).toBe("You can't do that here.");
  });
});

describe("how a ledger reads", () => {
  const sheetText = (file: CapabilityFile, heading: string) =>
    renderCapabilityText(file, { capId: "x", files: new Map([["x", file]]), personName: () => undefined, viewerId: null }).find((t) => t.heading === heading)!.lines;

  it("says its entries are only added, its lowest balance, and what counts them", () => {
    expect(sheetText(stockFile(), "Moves sheet")).toEqual([
      "Move (text, required), Item (one row from Items, required), Quantity (number, required), In stock after (Item's moves added up, to this one), Reverses (the move it reverses).",
      "Moves are only added: one can't be changed or deleted, only reversed, once.",
      "Moves for one Item can't add up to less than 0.",
    ]);
    expect(sheetText(stockFile(), "Items sheet")).toContain("In stock counts the moves for it.");
    expect(sheetText(timeOffFile(), "Balances sheet")).toContain("Left counts the leave entries for its Who.");
  });

  it("adds up the amounts under the table, never the balance after each", () => {
    const sheet = timeOffFile().sheets.find((s) => s.id === "leave")!;
    expect(summedColumns(sheet).map((c) => c.id)).toEqual(["days"]);
  });
});

describe("how to use a ledger", () => {
  it("says entries are reversed, never changed or deleted, and refuses a tutorial that says otherwise", async () => {
    const ada = await k.as("ada", (tx, c) => accessSummary(tx, c, stock));
    const maya = await k.as("maya", (tx, c) => accessSummary(tx, c, stock));
    expect(ada.sheets.find((s) => s.name === "Moves")).toMatchObject({ edit: false, delete: false, reverse: true });
    expect(maya.sheets.find((s) => s.name === "Moves")).toMatchObject({ edit: false, delete: false, reverse: false });
    expect(ada.sheets.find((s) => s.name === "Items")).not.toHaveProperty("reverse");
    const step = (text: string) => ({ purpose: "x", waits: [], cannot: [], steps: [{ title: "Fix a move you got wrong", text, does: { kind: "read" as const, sheet: "Moves", step: null } }] });
    expect(checkTutorial(ada, step("Find the move and change it, or delete it."))).toEqual([
      "Step 1 (“Fix a move you got wrong”): moves are only added; a wrong one is reversed, never changed or deleted.",
    ]);
    expect(checkTutorial(ada, step("Open the move and press Reverse."))).toEqual([]);
    expect(checkTutorial(ada, step("Moves can't be changed or deleted; a wrong one is reversed."))).toEqual([]);
  });
});
