import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import type { KernelCtx } from "./context";
import { capabilityProfile } from "./profile";
import { listRows } from "./rows";
import { withWorkspace, type Tx } from "./tx";

// C3: the counts the Customize advisor reads. Right, only over the rows the person may see, and never a value
// someone typed.

let ws: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));
let contracts: string;

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `pf${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
  });
  contracts = (await as("wade", (tx) => tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Customer contracts"))))[0]!.id;
}, 180_000);

describe("capabilityProfile", () => {
  it("counts rows, empty questions and steps used, as the admin sees them", async () => {
    const p = await as("wade", (tx, c) => capabilityProfile(tx, c, contracts));
    const all = await as("wade", (tx, c) => listRows(tx, c, contracts, "contracts"));
    const sheet = p.find((s) => s.sheet === "Contracts")!;
    expect(sheet.rows).toBe(all.length);
    const signed = all.filter((x) => !x.data.signed_contract || (Array.isArray(x.data.signed_contract) && !x.data.signed_contract.length)).length;
    expect(sheet.empty["Signed contract"] ?? 0).toBe(signed);
    // Every step count is a step of the capability, and they add up to the rows with a step.
    expect(sheet.used.Status!.every((u) => ["Draft", "Signed", "Legal review", "Active", "Renewal due", "Renewed", "Ended"].includes(u.name))).toBe(true);
    expect(sheet.used.Status!.reduce((n, u) => n + u.rows, 0)).toBe(all.length);
  });

  it("covers only the rows the person may see", async () => {
    const mine = await as("rita", (tx, c) => listRows(tx, c, contracts, "contracts"));
    const p = await as("rita", (tx, c) => capabilityProfile(tx, c, contracts));
    expect(p.find((s) => s.sheet === "Contracts")!.rows).toBe(mine.length);
    expect(mine.length).toBeLessThan((await as("wade", (tx, c) => listRows(tx, c, contracts, "contracts"))).length);
  });

  it("never carries a value someone typed", async () => {
    const all = await as("wade", (tx, c) => listRows(tx, c, contracts, "contracts"));
    const sent = JSON.stringify(await as("wade", (tx, c) => capabilityProfile(tx, c, contracts)));
    for (const row of all) expect(sent).not.toContain(String(row.data.customer));
  });

  it("is empty for someone who can't see the capability", async () => {
    expect(await as("maya", (tx, c) => capabilityProfile(tx, c, contracts))).toEqual([]);
  });
});
