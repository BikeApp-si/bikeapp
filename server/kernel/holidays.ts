import { asc } from "drizzle-orm";
import { workspaceHolidays } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { record } from "./audit";
import { currentTime } from "./clock";
import { KernelError, type KernelCtx } from "./context";
import type { Tx } from "./tx";

// Public holidays from a company's policies (4c–4d): kept with the document and page that list them. Bike has
// no holiday list of its own, so a workspace whose policies list none has none.

export type Holiday = { date: string; name: string; file: string; page: number | null };

// A real calendar day as YYYY-MM-DD (Feb 30 isn't one, though Date.parse rolls it on to March).
function isDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// Adds the holidays a build found; a date already kept stays as it is. Returns how many were added.
export async function saveHolidays(tx: Tx, ctx: KernelCtx, list: Holiday[], opts: { chatId?: string | null } = {}): Promise<number> {
  await mustBeAdmin(tx, ctx);
  if (!list.length) return 0;
  for (const h of list) if (!isDay(h.date)) throw new KernelError(`“${h.date}” isn't a date.`);
  const at = ctx.now ?? currentTime();
  const added = await tx
    .insert(workspaceHolidays)
    .values(list.map((h) => ({ workspaceId: ctx.workspaceId, date: h.date, name: h.name.trim(), file: h.file, page: h.page, createdAt: at })))
    .onConflictDoNothing()
    .returning({ date: workspaceHolidays.date });
  if (added.length)
    await record(tx, ctx, {
      who: ctx.actor.email,
      event: "holidays.saved",
      details: { holidays: added.length, files: [...new Set(list.map((h) => h.file))] },
      chatId: opts.chatId ?? null,
      at,
    });
  return added.length;
}

export async function listHolidays(tx: Tx): Promise<Holiday[]> {
  const rows = await tx.select().from(workspaceHolidays).orderBy(asc(workspaceHolidays.date));
  return rows.map((r) => ({ date: r.date, name: r.name, file: r.file, page: r.page }));
}
