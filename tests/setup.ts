import { readFileSync } from "node:fs";
import { createWorkspace } from "@/server/kernel/workspaces";
import { saveUpload } from "@/server/kernel/uploads";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import type { KernelCtx } from "@/server/kernel/context";

// The messages typed on setup's screens (2b–2e), shared by the recordings (scripts/ai-record.ts) and the
// tests that replay them. Each runs in a new workspace made as sign up makes it.
export const SETUP = {
  organization:
    "Fernwood Labs, 210 Congress Ave, Austin TX. fernwood.dev. We build developer tools: Fernwood CI for build pipelines and Fernwood Trace for debugging in production. Sold as monthly subscriptions to engineering teams.",
  team: "I'm the founder. Priya leads engineering, Dev leads growth, Krishna runs ops, Lena is our part-time accountant.",
  correction: "Lena reports to Krishna",
  // The founder default (leads report to the founder) loses to what the admin says.
  override: "I'm the founder. Priya Nair leads engineering and Dev Kumar leads growth. Priya reports to Dev while we hire.",
  typed: "I'm the founder. Priya Nair leads engineering, with Maya Chen and Omar Ali. Dev Kumar leads growth. Lena Ortiz is our part-time accountant, lena@fernwood.dev.",
};

let n = 0;
export async function newFernwood() {
  const sub = `setup${Date.now().toString(36)}${n++}`;
  const { workspaceId, personId } = await createWorkspace({ subdomain: sub, name: "Fernwood Labs", timeZone: "America/Chicago", admin: { name: "Wade Wilson", email: "wade@fernwood.dev" } });
  const ctx: KernelCtx = { workspaceId, actor: { id: personId, email: "wade@fernwood.dev" } };
  const k = <T>(fn: (tx: Tx, c: KernelCtx) => Promise<T>) => withWorkspace({ workspaceId, personId }, (tx) => fn(tx, ctx));
  const upload = (path: string) => k((tx, c) => saveUpload(tx, c, { name: path.split("/").pop()!, body: readFileSync(path) })).then((u) => u.id);
  // A send, then its work as it runs after the response.
  const say = async (send: (tx: Tx, c: KernelCtx) => Promise<() => Promise<void>>) => {
    const work = await k(send);
    await work();
  };
  return { workspaceId, personId, ctx, k, upload, say };
}
