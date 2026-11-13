import { AiError, ask } from "@/server/ai/gateway";
import type { Who } from "@/server/ai/log";
import { readIntoFields } from "@/server/ai/prompts/read-into-fields@1";
import { readPdf } from "@/server/files/read";
import { fieldsFrom, type formReading } from "@/server/kernel/read-into-fields";
import { MAX_IMAGE_BYTES } from "./run";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { recordFlags } from "@/server/kernel/flags";
import { withWorkspace } from "@/server/kernel/tx";

// 7c: the dropped document read by prompt 5's form mode, its answer turned into the form's values by the
// kernel, the file itself in the form's file column. Nothing is saved. Runs outside any transaction.
export async function readIntoFormWith(
  r: Awaited<ReturnType<typeof formReading>>,
  uploadId: string,
  who: Who,
): Promise<{ ok: true; values: Record<string, unknown>; unread: string[] } | { ok: false; error: string; problems: string[] }> {
  let document = null;
  let image = null;
  if (r.file.mime === "application/pdf") {
    const { pages, text } = await readPdf(r.file.body);
    document = { name: r.file.name, pages, text };
  } else if ((r.file.mime === "image/png" || r.file.mime === "image/jpeg") && r.file.body.byteLength <= MAX_IMAGE_BYTES) {
    image = { mediaType: r.file.mime as "image/png" | "image/jpeg", data: Buffer.from(r.file.body).toString("base64") };
  } else return { ok: false, error: "Drop a PDF or a photo (PNG or JPG).", problems: [] };
  try {
    const out = await ask(readIntoFields, { capability: r.capability, rowName: r.rowName, columns: r.columns, people: r.people, document, image, formats: r.formats }, who, { building: false });
    const { values, unread } = fieldsFrom(r.sheet, out.values, r.keys);
    if (document || out.flags.length) await flagged(who, document ? [document] : [{ name: r.file.name, text: "" }], out.flags);
    return { ok: true, values: { ...values, [r.fileColumn]: uploadId }, unread };
  } catch (e) {
    if (e instanceof AiError) return { ok: false, error: e.message, problems: [] };
    throw e;
  }
}

// Recorded as the person who dropped it, on the capability.
async function flagged(who: Who, documents: { name: string; pages?: number | null; text: string }[], said: string[]) {
  await withWorkspace({ workspaceId: who.workspaceId, personId: who.personId }, async (tx) => {
    const [me] = await tx.select({ email: people.email }).from(people).where(eq(people.id, who.personId!));
    await recordFlags(tx, { workspaceId: who.workspaceId, actor: { id: who.personId!, email: me!.email } }, { capabilityId: who.capabilityId }, documents, said);
  });
}
