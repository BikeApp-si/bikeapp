import { rowNotes } from "@/db/schema";
import { record } from "./audit";
import { titleShown } from "./commands";
import { currentTime } from "./clock";
import { KernelError, load, type KernelCtx } from "./context";
import { getRow } from "./rows";
import type { Tx } from "./tx";
import { namesFor } from "./views";

// Notes on a row (0.4, M22): anyone who may see the row writes a short note, kept with their name and the time. A note
// is fixed once posted (the app may only add and read them) and is in the Audit log as row.noted. Search, reports and
// chat don't read notes.

export const NOTE_MAX = 2000;

export async function addNote(tx: Tx, ctx: KernelCtx, rowId: string, text: string): Promise<{ id: string }> {
  const row = await getRow(tx, ctx, rowId); // refused when the person can't see it
  const body = text.trim();
  if (!body) throw new KernelError("Write the note first.");
  if (body.length > NOTE_MAX) throw new KernelError(`Keep a note under ${NOTE_MAX.toLocaleString("en-US")} characters.`);
  const loaded = await load(tx);
  const sheet = loaded.files.get(row.capabilityId)!.file.sheets.find((s) => s.id === row.sheetId)!;
  const at = ctx.now ?? currentTime();
  const [made] = await tx
    .insert(rowNotes)
    .values({ workspaceId: ctx.workspaceId, capabilityId: row.capabilityId, rowId, authorId: ctx.actor.id, text: body, createdAt: at })
    .returning({ id: rowNotes.id });
  await record(tx, ctx, {
    who: ctx.actor.email,
    capabilityId: row.capabilityId,
    event: "row.noted",
    // The note's id, so the row's History places it among the changes in the log's own order.
    details: { sheet: sheet.name, row: titleShown(sheet, row.data, await namesFor(tx, ctx, sheet, [row])), note: made!.id },
    at,
    rows: [rowId],
  });
  return made!;
}
