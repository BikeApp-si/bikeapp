import { beforeAll, describe, expect, it } from "vitest";
import { capabilities, people } from "@/db/schema";
import { seedFernwoodCopy } from "@/seed";
import { withWorkspace } from "@/server/kernel/tx";
import { accessSummary } from "@/server/kernel/access-summary";
import { adminCannot } from "@/server/kernel/tutorial";
import { tutorialFor } from "./write";

// Tutorials with tutorial-writer@3's recorded answers (scripts/ai-record.ts) on a Fernwood copy as Playwright's: each matches the
// reader's access, so Maya has no step to approve and Lena has approving and paying.

let ws: string;
const who = new Map<string, string>();
const caps = new Map<string, string>();
const read = async (email: string, cap: string) => {
  const out = await tutorialFor({ workspaceId: ws, actor: { id: who.get(email)!, email } }, caps.get(cap)!);
  if (!out.ok) throw new Error(out.error);
  return out.state.tutorial;
};

beforeAll(async () => {
  // As Playwright's copies have it (and the recording), admins included.
  ws = (await seedFernwoodCopy(`tut${Date.now().toString(36)}`)).workspaceId;
  await withWorkspace({ workspaceId: ws }, async (tx) => {
    for (const p of await tx.select({ id: people.id, email: people.email }).from(people)) who.set(p.email, p.id);
    for (const c of await tx.select({ id: capabilities.id, name: capabilities.name }).from(capabilities)) caps.set(c.name, c.id);
  });
}, 120_000);

describe("recorded tutorials", () => {
  it("Maya's Spend: her own expenses, nothing to approve", async () => {
    const t = await read("maya@fernwood.dev", "Spend");
    expect(t.steps.some((s) => s.does.kind === "move" && /approved|paid/i.test(s.does.step ?? ""))).toBe(false);
    expect(t.steps.map((s) => s.title)).toContain("Add an expense");
  });

  it("Lena's Spend: moving submitted expenses on (her approvals) is hers", async () => {
    const t = await read("lena@fernwood.dev", "Spend");
    // tutorial-writer@3 gives her one step for both ("Approve purchases and expenses that wait on you").
    expect(t.steps.filter((s) => s.does.kind === "move").map((s) => s.does.step)).toContain("Approved");
    // An admin's can't names only what nobody can do here (S1): each line a limit her access has.
    const lena = await withWorkspace({ workspaceId: ws, personId: who.get("lena@fernwood.dev")! }, (tx) => accessSummary(tx, { workspaceId: ws, actor: { id: who.get("lena@fernwood.dev")!, email: "lena@fernwood.dev" } }, caps.get("Spend")!));
    expect(t.cannot.filter((l) => !adminCannot(lena, l))).toEqual([]);
  });

  it("Wade's Customer contracts: adding and moving contracts", async () => {
    const t = await read("wade@fernwood.dev", "Customer contracts");
    expect(t.steps[0]!.does).toMatchObject({ kind: "add", sheet: "Contracts" });
  });
});
