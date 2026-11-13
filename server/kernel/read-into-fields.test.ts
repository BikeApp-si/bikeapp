import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { capabilities, people } from "@/db/schema";
import { seedWorkspace } from "@/seed";
import { seedCapabilities } from "@/seed/capabilities";
import { FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES } from "@/seed/fernwood";
import type { KernelCtx } from "./context";
import { fieldsFrom, formReading } from "./read-into-fields";
import { withWorkspace, type Tx } from "./tx";
import { saveUpload } from "./uploads";

// 7c's drop box, the kernel's side, on Fernwood's Customer contracts: who may use it, what prompt 5's form
// mode may fill, and how its answer becomes the form's values (as an import reads a row's cells).

let ws: string;
let contracts: string;
const ids = new Map<string, string>();
const as = <T>(n: string, fn: (tx: Tx, c: KernelCtx) => Promise<T>) =>
  withWorkspace({ workspaceId: ws, personId: ids.get(n) }, (tx) => fn(tx, { workspaceId: ws, actor: { id: ids.get(n)!, email: `${n}@fernwood.dev` } }));

beforeAll(async () => {
  ws = (await seedWorkspace({ subdomain: `rf${Date.now().toString(36)}`, name: "Fernwood Labs", timeZone: "America/Chicago" }, FERNWOOD_ADMIN, FERNWOOD_PEOPLE, FERNWOOD_TIMES)).workspaceId;
  await seedCapabilities(ws);
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) ids.set(p.email.split("@")[0]!, p.id);
    contracts = (await tx.select({ id: capabilities.id }).from(capabilities).where(eq(capabilities.name, "Customer contracts")))[0]!.id;
  });
}, 60_000);

const pdf = () => new Uint8Array(readFileSync("tests/files/Juniper Health signed contract.pdf"));

describe("reading a dropped document into a new row's form", () => {
  it("offers the plain fields to fill, for someone who may add rows", async () => {
    const up = await as("wade", (tx, c) => saveUpload(tx, c, { name: "Juniper.pdf", body: pdf() }));
    const r = await as("wade", (tx, c) => formReading(tx, c, contracts, "contracts", up.id));
    expect(r.fileColumn).toBe("signed_contract");
    expect(r.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["Customer", "Value a year", "Start", "Owner"]));
    expect(r.columns.some((c) => c.type === "file" || c.type === "step")).toBe(false);
  });

  it("refuses someone who can't add contracts, and a file they can't open", async () => {
    const mine = await as("maya", (tx, c) => saveUpload(tx, c, { name: "Juniper.pdf", body: pdf() }));
    await expect(as("maya", (tx, c) => formReading(tx, c, contracts, "contracts", mine.id))).rejects.toThrow("can't add rows here");
    await expect(as("wade", (tx, c) => formReading(tx, c, contracts, "contracts", mine.id))).rejects.toThrow("can't see it");
  });

  it("reads each value as an import reads a cell; one it can't read stays empty and is named", async () => {
    const up = await as("wade", (tx, c) => saveUpload(tx, c, { name: "Juniper.pdf", body: pdf() }));
    const r = await as("wade", (tx, c) => formReading(tx, c, contracts, "contracts", up.id));
    const out = fieldsFrom(
      r.sheet,
      [
        { column: "Customer", value: "Juniper Health" },
        { column: "Value a year", value: "42000" },
        { column: "Start", value: "2026-11-01" },
        { column: "Owner", value: "Krishna" },
        { column: "Notice", value: "sixty" },
        { column: "Status", value: "Active" },
        { column: "Payroll", value: "x" },
      ],
      r.keys,
    );
    expect(out.values).toEqual({ customer: "Juniper Health", value: 4_200_000, start: "2026-11-01", owner: ids.get("krishna") });
    expect(out.unread).toEqual(["Notice"]);
  });
});
