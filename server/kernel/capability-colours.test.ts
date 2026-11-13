import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { capabilities } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { capabilitiesFor, deleteCapability, saveVersion } from "./capabilities";
import { contractsFile } from "./fixtures";

// Each capability keeps the colour it got when created (0.4, M23): the next in the cycle after the most recently
// added one, removed ones counted; a rename or a new version never changes it, and each workspace counts its own.

type K = Awaited<ReturnType<typeof kernelWorkspace>>;
const named = (k: K, name: string) => ({ ...contractsFile([k.id.ada]), name });

describe("capability colours", () => {
  it("cycle through the set as capabilities are added", async () => {
    const k = await kernelWorkspace();
    for (const n of ["A", "B", "C", "D", "E", "F", "G", "H"]) await k.create(named(k, n));
    const caps = await k.as("ada", (tx, c) => capabilitiesFor(tx, c));
    expect(caps.map((c) => c.color)).toEqual(["violet", "sky", "green", "amber", "pink", "teal", "red", "violet"]);
  });

  it("survive a rename and a new version, and a removal shifts no one", async () => {
    const k = await kernelWorkspace();
    const a = await k.create(named(k, "Contracts"));
    const b = await k.create(named(k, "Renewals"));
    await k.as("ada", (tx, c) => saveVersion(tx, c, a, named(k, "Customer contracts"), { source: "customize", event: "customize.saved" }));
    await k.as("ada", (tx, c) => deleteCapability(tx, c, b, "Renewals"));
    const c3 = await k.create(named(k, "Leads"));
    const colour = (id: string) => k.as("ada", (tx) => tx.select({ color: capabilities.color }).from(capabilities).where(eq(capabilities.id, id))).then((r) => r[0]!.color);
    expect(await colour(a)).toBe("violet");
    expect(await colour(c3)).toBe("green"); // after Renewals' sky, though Renewals is gone
  });

  it("each workspace counts its own", async () => {
    const one = await kernelWorkspace();
    const two = await kernelWorkspace();
    await one.create(named(one, "A"));
    await one.create(named(one, "B"));
    const first = await two.create(named(two, "C"));
    const caps = await two.as("ada", (tx, c) => capabilitiesFor(tx, c));
    expect(caps.find((c) => c.id === first)?.color).toBe("violet");
  });
});
