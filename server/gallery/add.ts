import { addSet, type SetChoice } from "@/server/kernel/gallery/add";
import type { AppSet } from "@/server/kernel/gallery/format";
import type { KernelCtx } from "@/server/kernel/context";
import { atomic, type Tx } from "@/server/kernel/tx";
import { queueOntology } from "@/server/ontology/write";

// Adds a set and, as after a build, queues the Ontology's writer in the same transaction.
export async function addFromGallery(tx: Tx, ctx: KernelCtx, set: AppSet, choice: SetChoice) {
  return atomic(tx, async (tx) => {
    const added = await addSet(tx, ctx, set, choice);
    await queueOntology(tx, ctx);
    return added;
  });
}
