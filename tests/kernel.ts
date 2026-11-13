// A fresh workspace for kernel tests: Ada (admin) manages Priya and Rita; Priya manages Maya and Omar.
import { importPeople } from "@/server/kernel/people";
import { createCapability } from "@/server/kernel/capabilities";
import type { KernelCtx } from "@/server/kernel/context";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { people } from "@/db/schema";
import { freshWorkspace } from "./helpers";

export type Name = "ada" | "priya" | "maya" | "omar" | "rita";

export async function kernelWorkspace() {
  const ws = await freshWorkspace();
  const domain = ws.email.split("@")[1]!;
  const email = (n: Name) => (n === "ada" ? ws.email : `${n}@${domain}`);
  await withWorkspace(ws, (tx) =>
    importPeople(tx, ws, ws.email, [
      { name: "Priya Nair", email: email("priya"), managerEmail: email("ada") },
      { name: "Rita Gomez", email: email("rita"), managerEmail: email("ada") },
      { name: "Maya Chen", email: email("maya"), managerEmail: email("priya") },
      { name: "Omar Ali", email: email("omar"), managerEmail: email("priya") },
    ], "test"),
  );
  const all = await withWorkspace(ws, (tx) => tx.select({ id: people.id, email: people.email }).from(people));
  const id = Object.fromEntries((["ada", "priya", "maya", "omar", "rita"] as Name[]).map((n) => [n, all.find((p) => p.email === email(n))!.id])) as Record<Name, string>;

  const ctx = (n: Name, now?: Date): KernelCtx => ({ workspaceId: ws.workspaceId, actor: { id: id[n], email: email(n) }, now });
  // Runs fn as that person, in one kernel transaction.
  const as = <T>(n: Name, fn: (tx: Tx, ctx: KernelCtx) => Promise<T>, now?: Date) =>
    withWorkspace({ workspaceId: ws.workspaceId, personId: id[n] }, (tx) => fn(tx, ctx(n, now)));
  const create = (file: unknown) => as("ada", (tx, c) => createCapability(tx, c, file, { source: "build" })).then((r) => r.id);

  return { workspaceId: ws.workspaceId, id, email, ctx, as, create };
}
