import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// L1: Bike's theme is blue. Violet stays only as a capability's icon colour (lib/cap-colors.ts).
describe("the theme's old violets", () => {
  it("are gone from the app", () => {
    const pattern = "6D4AFF|4A2DC6|3C259D|F5F3FF|D3C9FF|E9E4FF|D9D1FF|60, ?37, ?157|109, ?74, ?255";
    let found = "";
    try {
      found = execFileSync("git", ["grep", "-IilE", pattern, "--", "app", "components", "lib", "server"], { encoding: "utf8" });
    } catch {
      // git grep exits 1 when nothing matches.
    }
    const left = found.split("\n").filter((f) => f && !["lib/cap-colors.ts", "lib/cap-colors.test.ts", "lib/no-violet.test.ts"].includes(f));
    expect(left).toEqual([]);
  });
});
