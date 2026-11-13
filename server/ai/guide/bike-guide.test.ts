import { describe, expect, it } from "vitest";
import { CHANGE_KINDS } from "@/server/kernel/customize/draft";
import { LIMITS } from "@/server/kernel/schema/validate";
import { BIKE_GUIDE, CHANGES } from "./bike-guide";

// The Bike guide is checked like code (C2): it says what every Customize change does, with the kernel's own limits.

describe("the Bike guide", () => {
  it("describes every Customize change, and nothing that isn't one", () => {
    expect(Object.keys(CHANGES).sort()).toEqual([...CHANGE_KINDS].sort());
    for (const c of Object.values(CHANGES)) expect(BIKE_GUIDE).toContain(c);
  });

  it("gives the kernel's limits", () => {
    expect(BIKE_GUIDE).toContain(`at most ${LIMITS.sheets} sheets`);
    expect(BIKE_GUIDE).toContain(`at most ${LIMITS.columns} on a sheet`);
    expect(BIKE_GUIDE).toContain(`At most ${LIMITS.steps} steps before the end steps`);
    expect(BIKE_GUIDE).toContain(`at most ${LIMITS.rules} in an app`);
  });

  it("is plain words: no ids or code", () => {
    expect(BIKE_GUIDE).not.toMatch(/[a-z]+_[a-z]+|[{}]|=>/);
  });
});
