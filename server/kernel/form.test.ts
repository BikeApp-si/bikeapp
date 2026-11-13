import { describe, expect, it } from "vitest";
import { contractsFile, PEOPLE } from "./fixtures";
import { quickOf, tabsOf } from "./form";
import type { CapabilityFile, Rule } from "./schema/file";
import { validateFile } from "./schema/validate";
import { checkValues, shown } from "./values";

// The form (0.3): tabs, the questions asked when a row is added, and questions shown only when relevant, which are
// never required while hidden.

const CAP = "20000000-0000-4000-8000-000000000001";
const withFile = (f: (file: CapabilityFile) => void) => {
  const file = structuredClone(contractsFile());
  f(file);
  return file;
};
const sheetOf = (file: CapabilityFile) => file.sheets[0]!;
const quick = (file: CapabilityFile) => quickOf(file, CAP, sheetOf(file), new Map([[CAP, file]]));
const errors = (file: CapabilityFile) => {
  const r = validateFile(file, { people: new Set(Object.values(PEOPLE)) });
  return r.ok ? "" : r.errors.join(" ");
};
const TABS = [
  { name: "Basics", sections: [{ name: null, columns: ["customer", "value"] }] },
  { name: "Dates", sections: [{ name: "Term", columns: ["start", "renews"] }] },
];
// "Ask for the signed copy only over $50,000."
const OVER_50K = { op: "gt" as const, args: [{ col: "value" }, 5_000_000] };

describe("tabs", () => {
  it("are the sheet's own, with every question it leaves out in the last tab", () => {
    const file = withFile((f) => (sheetOf(f).form = { tabs: TABS }));
    expect(tabsOf(sheetOf(file))).toEqual([TABS[0], { name: "Dates", sections: [{ name: "Term", columns: ["start", "renews"] }, { name: null, columns: ["notice", "owner"] }] }]);
  });
  it("are one Details tab in sheet order when the sheet has none (no computed or step questions)", () => {
    expect(tabsOf(sheetOf(contractsFile()))).toEqual([{ name: "Details", sections: [{ name: null, columns: ["customer", "value", "start", "renews", "notice", "owner"] }] }]);
  });
});

describe("the questions asked when a row is added", () => {
  it("are the title and the required ones, plus the form's own", () => {
    expect(quick(contractsFile())).toEqual(["customer", "value"]);
    expect(quick(withFile((f) => (sheetOf(f).form = { tabs: TABS, quick: ["start"] })))).toEqual(["customer", "value", "start"]);
  });
  it("include what the sheet's checks and its rules for a new row read", () => {
    const file = withFile((f) => {
      sheetOf(f).checks = [{ id: "c", name: "Notice under 90 days", condition: { op: "lt", args: [{ col: "notice" }, 90] } }];
      f.rules = [
        {
          id: "r",
          text: "When a contract is added without a start, move it to Signed.",
          trigger: { kind: "row_created", sheet: "contracts" },
          condition: { op: "empty", args: [{ col: "start" }] },
          actions: [{ kind: "move_to_step", step: "signed" }],
        } as unknown as Rule,
      ];
    });
    expect(quick(file)).toEqual(["customer", "value", "start", "notice"]);
  });
  it("are every question when a new row goes to someone at once (a request)", () => {
    const file = withFile((f) => {
      f.rules = [
        {
          id: "r",
          text: "New contracts go to their owner to approve.",
          trigger: { kind: "enters_step", sheet: "contracts", step: "draft" },
          actions: [{ kind: "ask_person", person: { column: "owner" }, label: "Approve", step: "draft" }],
        } as unknown as Rule,
      ];
    });
    expect(quick(file)).toEqual(["customer", "value", "start", "renews", "notice", "owner"]);
  });
});

describe("questions shown only when relevant", () => {
  const file = withFile((f) => {
    const start = sheetOf(f).columns.find((c) => c.id === "start")!;
    start.required = true;
    start.showWhen = OVER_50K;
  });
  const sheet = sheetOf(file);
  const start = sheet.columns.find((c) => c.id === "start")!;

  it("are shown when the condition holds, and only then", () => {
    expect(shown(start, { value: 6_000_000 }, "2026-10-31")).toBe(true);
    expect(shown(start, { value: 4_000_000 }, "2026-10-31")).toBe(false);
    expect(shown(start, {}, "2026-10-31")).toBe(false);
  });
  it("are never required while hidden, and required once shown", () => {
    const opts = { creatorId: null, today: "2026-10-31" };
    expect(checkValues(sheet, { customer: "Kova", value: 4_000_000 }, opts).ok).toBe(true);
    expect(checkValues(sheet, { customer: "Kova", value: 6_000_000 }, opts)).toEqual({ ok: false, errors: ["Start is required."] });
    // An edit that raises the value asks for it too.
    expect(checkValues(sheet, { value: 6_000_000 }, { ...opts, existing: { customer: "Kova", value: 4_000_000 } }).ok).toBe(false);
  });
  it("are checked when the file is saved", () => {
    expect(errors(file)).toBe("");
    const bad = (f: (c: CapabilityFile["sheets"][number]["columns"][number], file: CapabilityFile) => void) =>
      errors(
        withFile((file) => {
          f(sheetOf(file).columns.find((c) => c.id === "start")!, file);
        }),
      );
    expect(bad((c) => (c.showWhen = { col: "value" }))).toMatch(/yes\/no condition/);
    expect(bad((c) => (c.showWhen = { op: "empty", args: [{ col: "start" }] }))).toMatch(/its own answer/);
    expect(bad((c, file) => ((c.showWhen = { op: "empty", args: [{ col: "notice" }] }), (sheetOf(file).columns.find((x) => x.id === "notice")!.showWhen = OVER_50K)))).toMatch(
      /itself shown only sometimes/,
    );
    expect(bad((_, file) => (sheetOf(file).columns[0]!.showWhen = OVER_50K))).toMatch(/always shown/);
  });
  it("and so is the form's layout", () => {
    expect(errors(withFile((f) => (sheetOf(f).form = { tabs: TABS })))).toBe("");
    expect(errors(withFile((f) => (sheetOf(f).form = { tabs: [{ name: "A", sections: [{ name: null, columns: ["days_left"] }] }] })))).toMatch(/can't be filled/);
    expect(errors(withFile((f) => (sheetOf(f).form = { tabs: [TABS[0]!, { name: "basics", sections: [{ name: null, columns: ["start"] }] }] })))).toMatch(/tab names/);
    expect(errors(withFile((f) => (sheetOf(f).form = { tabs: [TABS[0]!, { name: "B", sections: [{ name: null, columns: ["value"] }] }] })))).toMatch(/more than one place/);
    expect(errors(withFile((f) => (sheetOf(f).form = { tabs: TABS, quick: ["status"] })))).toMatch(/can't be filled/);
  });
});
