import { strToU8, zipSync } from "fflate";
import { toCsv } from "@/lib/csv";
import { displayValue } from "@/lib/format";
import { accessTo } from "./access";
import { record } from "./audit";
import { AccessError, load, type KernelCtx } from "./context";
import { listRows } from "./rows";
import type { Sheet } from "./schema/file";
import type { Tx } from "./tx";
import { namesFor } from "./views";

// Export data as CSV (9c): every sheet the person can see, one CSV each (zipped when there are several),
// column names as headers, people, steps, choices and links written by name. Only rows they can see.

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";

// A cell a spreadsheet would run as a formula is written as text.
const safe = (v: string) => (/^[=+@\t\r]/.test(v) || /^-[^\d]/.test(v) ? `'${v}` : v);

async function sheetCsv(tx: Tx, ctx: KernelCtx, capId: string, sheet: Sheet) {
  const list = await listRows(tx, ctx, capId, sheet.id);
  const names = await namesFor(tx, ctx, sheet, list);
  const lookup = {
    person: (id: string) => names.people[id],
    row: (id: string) => names.rows[id],
    file: (id: string) => names.files[id],
    step: (id: string) => sheet.steps?.find((s) => s.id === id)?.name,
  };
  const header = sheet.columns.map((c) => c.name);
  const { formats } = await load(tx);
  const body = list.map((r) => sheet.columns.map((c) => safe(displayValue(c, r.data[c.id], lookup, formats))));
  return { csv: toCsv([header, ...body]), rows: list.length };
}

export async function exportCapability(tx: Tx, ctx: KernelCtx, capId: string): Promise<{ name: string; mime: string; body: Uint8Array }> {
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  const sheets = access?.cap.file.sheets.filter((s) => access.can("see", s.id)) ?? [];
  if (!access || !sheets.length) throw new AccessError("That app doesn't exist, or you can't see it.");
  const cap = slug(access.cap.file.name);
  const parts = [];
  for (const s of sheets) parts.push({ sheet: s, file: `${cap}-${slug(s.name)}.csv`, ...(await sheetCsv(tx, ctx, capId, s)) });

  await record(tx, ctx, {
    who: ctx.actor.email,
    capabilityId: capId,
    event: "data.exported",
    details: { sheets: parts.map((p) => p.sheet.name), rows: parts.reduce((n, p) => n + p.rows, 0) },
    at: ctx.now,
  });

  if (parts.length === 1) return { name: parts[0]!.file, mime: "text/csv", body: strToU8(parts[0]!.csv) };
  const zip = zipSync(Object.fromEntries(parts.map((p) => [p.file, strToU8(p.csv)])));
  return { name: `${cap}.zip`, mime: "application/zip", body: zip };
}
