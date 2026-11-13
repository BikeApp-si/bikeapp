import { describe, expect, it } from "vitest";
import { col, contracts } from "./fixtures";
import { checkPlan } from "./plan";

// G1: a plan's link can be a pick from a list. The kernel keeps the mark, and drops it from the link a tree's
// rows sit under, which is never one.
describe("a pick from a list in a plan", () => {
  it("is kept on a link, and dropped from a tree's parent", () => {
    const capability = structuredClone(contracts);
    capability.sheets.push({
      name: "Regions", kind: "tree", parent_sheet: null, tree_parent: "Under", title_column: "Region", row_one: "region", row_many: "regions", add_action: null,
      columns: [col("Region", "text", { required: true }), col("Under", "link", { link: { capability: null, sheet: "Regions", pick: true } })],
      steps: [],
    });
    capability.sheets[0]!.columns.push(col("Region", "link", { link: { capability: null, sheet: "Regions", pick: true } }));
    capability.roles[1]!.sheets = ["Contracts"];
    const people = new Map([["wade@fernwood.dev", "00000000-0000-4000-8000-000000000001"], ["krishna@fernwood.dev", "00000000-0000-4000-8000-000000000002"]]);
    const plan = checkPlan({ capability, rules: [], alsoChanges: [] }, { newId: "n", files: new Map(), people });
    expect(plan.problems).toEqual([]);
    const [contractsSheet, regions] = plan.file.sheets;
    expect(contractsSheet!.columns.find((c) => c.name === "Region")!.link).toEqual({ sheet: "regions", pick: true });
    expect(regions!.columns.find((c) => c.name === "Under")!.link).toEqual({ sheet: "regions" });
  });
});
