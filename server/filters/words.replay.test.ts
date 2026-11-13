import { beforeAll, describe, expect, it } from "vitest";
import { capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import type { KernelCtx } from "@/server/kernel/context";
import { filterWordsInput } from "@/server/kernel/filter-words";
import { listRows, sheetTotals } from "@/server/kernel/rows";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { FILTER_WORDS } from "@/tests/filter-words";
import { wordsToFilters } from "./words";

// Filters in plain words with filter-words@1's recorded answers (scripts/ai-record.ts): each request on Fernwood, as
// Wade on Oct 27, 2026, becomes the right filters on the sheet's columns, and the rows they show are the right ones.

let ws: string;
let wade: string;
const caps = new Map<string, string>();
const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId: ws, personId: wade }, (tx) => fn(tx, { workspaceId: ws, actor: { id: wade, email: "wade@fernwood.dev" } }));
const words = async (i: number) => {
  const w = FILTER_WORDS[i]!;
  const capId = caps.get(w.sheet === "contracts" ? "Customer contracts" : "Spend")!;
  const out = await wordsToFilters(await k((tx, c) => filterWordsInput(tx, c, capId, w.sheet, w.text)), { workspaceId: ws, personId: wade, capabilityId: capId });
  if (!out.ok) throw new Error(out.error);
  return { ...out, capId, sheet: w.sheet };
};

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `fw${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    wade = (await tx.select({ id: people.id, email: people.email }).from(people)).find((p) => p.email === "wade@fernwood.dev")!.id;
    for (const c of await tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities)) caps.set(c.name, c.id);
  });
}, 120_000);

describe("filters in plain words", () => {
  it("“renewing next month over $20,000”: Renews on in November, value from $20,000", async () => {
    const out = await words(0);
    expect(out.filters).toEqual([
      { column: "renews_on", op: "between", from: "2026-11-01", to: "2026-11-30" },
      { column: "value", op: "between", from: 2_000_000, to: null },
    ]);
    const rows = await k((tx, c) => listRows(tx, c, out.capId, out.sheet, { filters: out.filters }));
    expect(rows.map((r) => r.data.customer).sort()).toEqual(["Acme Health", "Northwind"]);
  });

  it("“Rita's active contracts”: her, and Active", async () => {
    const out = await words(1);
    expect(out.filters.map((f) => [f.column, f.op])).toEqual([["owner", "in"], ["status", "in"]]);
    const rows = await k((tx, c) => listRows(tx, c, out.capId, out.sheet, { filters: out.filters }));
    expect(rows.map((r) => r.data.customer).sort()).toEqual(["Fieldstone", "Kova", "Pinecone Labs"]);
  });

  it("“expenses from Engineering this quarter”: Engineering's people, Oct 1 – Dec 31", async () => {
    const out = await words(2);
    expect(out.filters[1]).toEqual({ column: "date", op: "between", from: "2026-10-01", to: "2026-12-31" });
    const totals = await k((tx, c) => sheetTotals(tx, c, out.capId, out.sheet, { filters: out.filters }));
    expect(totals.count).toBeGreaterThan(0);
  });

  it("“the ones with a receipt”: no filter, and why in plain words", async () => {
    const out = await words(3);
    expect(out.filters).toEqual([]);
    expect(out.couldNot).toEqual(["Bike can't filter by whether a receipt is attached."]);
  });
});
