import { KernelError, type KernelCtx } from "@/server/kernel/context";
import { withWorkspace, type Tx } from "@/server/kernel/tx";
import { currentPerson, currentWorkspace, requirePerson, workspaceFromHost } from "./current";

// Kernel calls made by the signed-in person: the workspace from the host, the person from this host's
// session, one transaction. Nothing the browser sends picks the workspace or the person.

type Fn<T> = (tx: Tx, ctx: KernelCtx) => Promise<T>;

// In a page: the workspace must agree with the [ws] segment; no session goes to the log in.
export async function asPage<T>(wsParam: string, fn: Fn<T>): Promise<T> {
  const ws = await currentWorkspace(wsParam);
  const person = await requirePerson(ws);
  return withWorkspace({ workspaceId: ws.id, personId: person.id }, (tx) => fn(tx, { workspaceId: ws.id, actor: { id: person.id, email: person.email } }));
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; problems: string[] };

// In a server action: a refusal comes back as plain words, so the form can show it.
export async function asAction<T extends object>(fn: Fn<T>): Promise<Result<T>> {
  const ws = await workspaceFromHost();
  const person = await currentPerson(ws);
  if (!person) return { ok: false, error: "Please log in again.", problems: [] };
  try {
    const out = await withWorkspace({ workspaceId: ws.id, personId: person.id }, (tx) => fn(tx, { workspaceId: ws.id, actor: { id: person.id, email: person.email } }));
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof KernelError) return { ok: false, error: e.message, problems: e.problems };
    throw e;
  }
}
