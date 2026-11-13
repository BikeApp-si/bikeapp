import { describe, expect, it } from "vitest";
import { COLUMN_TYPES } from "@/server/kernel/schema/file";
import { recordLayout, SECTIONS_UP_TO } from "./form-layout";
import { COLUMN_ICONS } from "./question-row";
import type { SheetView } from "./types";

const col = (id: string, extra = {}) => ({ id, name: id, type: "text", ...extra }) as SheetView["columns"][number];
function sheet(perTab: number[]) {
  let n = 0;
  const tabs = perTab.map((count, t) => ({ name: `Tab ${t}`, sections: [{ name: null, columns: Array.from({ length: count }, () => `q${n++}`) }] }));
  return { tabs, columns: tabs.flatMap((t) => t.sections[0]!.columns.map((id) => col(id))) } as unknown as Pick<SheetView, "tabs" | "columns">;
}

describe("a record's layout", () => {
  it("shows a short form's tabs as sections under one Details tab", () => {
    const out = recordLayout(sheet([6, SECTIONS_UP_TO - 6]));
    expect(out.map((t) => t.name)).toEqual(["Details"]);
    expect(out[0]!.sections.map((s) => s.name)).toEqual(["Tab 0", "Tab 1"]);
  });

  it("keeps a longer form's tabs", () => {
    expect(recordLayout(sheet([6, SECTIONS_UP_TO - 5])).map((t) => t.name)).toEqual(["Tab 0", "Tab 1"]);
  });

  it("names each section after its tab, with all the tab's questions", () => {
    const s = sheet([1, 1]);
    s.tabs[1]!.sections = [{ name: "Term", columns: ["q1"] }, { name: "Notice", columns: ["q2"] }];
    expect(recordLayout(s)[0]!.sections).toEqual([{ name: "Tab 0", columns: ["q0"] }, { name: "Tab 1", columns: ["q1", "q2"] }]);
  });

  it("leaves a one-tab form as one list, step left out", () => {
    const s = sheet([2]);
    s.columns.push(col("status", { type: "step" }));
    expect(recordLayout(s)[0]!.sections).toEqual([{ name: null, columns: ["q0", "q1"] }]);
  });

  it("places what the sheet works out after the last question it reads", () => {
    const s = sheet([1, 1]);
    s.columns.push(col("sum", { type: "computed", expr: { col: "q0" } }));
    expect(recordLayout(s)[0]!.sections[0]!.columns).toEqual(["q0", "sum"]);
  });
});

describe("question icons", () => {
  it("cover every column type", () => {
    for (const t of COLUMN_TYPES) expect(COLUMN_ICONS[t]).toBeTruthy();
  });
});
