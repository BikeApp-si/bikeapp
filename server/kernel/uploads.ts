import { and, eq, isNull, sql } from "drizzle-orm";
import { rows, uploads, workspaces } from "@/db/schema";
import { checkUpload } from "@/server/files/limits";
import { scan, ScanUnavailable } from "@/server/files/scan";
import { looksLike } from "@/server/files/sniff";
import { getFile, keyFor, putFile } from "@/server/files/storage";
import { accessTo } from "./access";
import { AccessError, KernelError, load, type KernelCtx } from "./context";
import type { Tx } from "./tx";
import { currentTime } from "./clock";

// Uploaded files. A file is saved first and then put in a row (or as the logo) by a later write. It opens
// for the person who uploaded it, for anyone who can see a row that holds it, and for everyone when it is
// the workspace logo.

export async function saveUpload(tx: Tx, ctx: KernelCtx, file: { name: string; body: Uint8Array }) {
  const name = file.name.trim().replace(/[/\\]/g, "-").slice(0, 200) || "file";
  const checked = checkUpload(name, file.body.byteLength);
  if (!checked.ok) throw new KernelError(checked.reason);
  // What it holds, then viruses, before anything is kept (M9).
  if (!looksLike(name.toLowerCase().split(".").pop() ?? "", file.body)) throw new KernelError("That file isn't the kind its name says.");
  const scanned = await scan(file.body).catch((e) => {
    if (e instanceof ScanUnavailable) throw new KernelError("Bike couldn't check that file for viruses just now. Try again in a minute.");
    throw e;
  });
  if (!scanned.clean) throw new KernelError("That file didn't pass the virus check, so it wasn't added.");
  const id = crypto.randomUUID();
  const key = keyFor(ctx.workspaceId, id, name);
  await putFile(key, file.body, checked.mime);
  await tx.insert(uploads).values({ id, workspaceId: ctx.workspaceId, key, name, mime: checked.mime, size: file.body.byteLength, uploadedBy: ctx.actor.id, createdAt: ctx.now ?? currentTime() });
  return { id, name };
}

// Names of uploaded files, for showing them as chips.
export async function uploadNames(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const found = await tx
    .select({ id: uploads.id, name: uploads.name })
    .from(uploads)
    .where(sql`${uploads.id} in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  return new Map(found.map((f) => [f.id, f.name]));
}

async function mayOpen(tx: Tx, ctx: KernelCtx, upload: { id: string; key: string; uploadedBy: string | null }): Promise<boolean> {
  if (upload.uploadedBy === ctx.actor.id) return true;
  const [ws] = await tx.select({ logo: workspaces.logoKey }).from(workspaces);
  if (ws?.logo === upload.key) return true;
  const holding = await tx
    .select({ id: rows.id, capabilityId: rows.capabilityId, sheetId: rows.sheetId, data: rows.data, parentRowId: rows.parentRowId })
    .from(rows)
    .where(and(isNull(rows.deletedAt), sql`exists (select 1 from jsonb_each_text(${rows.data}) e where e.value = ${upload.id})`));
  if (!holding.length) return false;
  const loaded = await load(tx);
  for (const row of holding) {
    const access = await accessTo(tx, loaded, row.capabilityId, ctx.actor.id);
    if (access && (await access.allows("see", { ...row, data: row.data as Record<string, unknown> }))) return true;
  }
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function openUpload(tx: Tx, ctx: KernelCtx, uploadId: string) {
  const [u] = UUID.test(uploadId) ? await tx.select().from(uploads).where(eq(uploads.id, uploadId)) : [];
  if (!u || !(await mayOpen(tx, ctx, u))) throw new AccessError("That file doesn't exist, or you can't see it.");
  const file = await getFile(u.key);
  if (!file) throw new KernelError("That file is no longer stored.");
  return { name: u.name, mime: u.mime, body: file.body };
}

// A file a row holds, for that row's AI step (it reads the row's own receipt, and nothing else).
export async function rowFile(tx: Tx, rowId: string, uploadId: string) {
  const [row] = await tx.select({ data: rows.data }).from(rows).where(and(eq(rows.id, rowId), isNull(rows.deletedAt)));
  if (!row || !Object.values(row.data as Record<string, unknown>).includes(uploadId)) return null;
  const [u] = await tx.select().from(uploads).where(eq(uploads.id, uploadId));
  const file = u && (await getFile(u.key));
  return u && file ? { name: u.name, mime: u.mime, body: file.body } : null;
}
