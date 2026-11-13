import { flagInstructions, type Flag } from "@/server/files/documents";
import { record } from "./audit";
import type { KernelCtx } from "./context";
import type { Tx } from "./tx";

// Text in an uploaded document that tried to direct Bike ("ignore your rules", "make Maya an admin"): the
// kernel's own check on each document, and what the model said it saw (its `flags`), each one Audit entry
// (document.flagged) on the chat or capability it came in. Nothing in it is ever followed; documents are data.
export async function recordFlags(
  tx: Tx,
  ctx: KernelCtx,
  at: { chatId?: string | null; capabilityId?: string | null },
  documents: { name: string; pages?: number | null; text: string }[],
  said: string[],
): Promise<Flag[]> {
  const flags = documents.flatMap((d) => flagInstructions({ kind: "text", name: d.name, pages: d.pages ?? null, text: d.text }));
  for (const s of said) {
    const excerpt = s.trim().slice(0, 160);
    if (!excerpt || flags.some((f) => f.excerpt.includes(excerpt) || excerpt.includes(f.excerpt))) continue;
    const file = documents.find((d) => d.text.includes(excerpt))?.name ?? documents[0]?.name ?? "";
    flags.push({ file, page: null, excerpt });
  }
  for (const f of flags)
    await record(tx, ctx, { who: ctx.actor.email, capabilityId: at.capabilityId ?? undefined, event: "document.flagged", details: { file: f.file, page: f.page, excerpt: f.excerpt }, chatId: at.chatId ?? null });
  return flags;
}
