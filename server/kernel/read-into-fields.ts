import { accessTo } from "./access";
import { AccessError, KernelError, load, type KernelCtx } from "./context";
import { checkImport, peopleKeys } from "./plans/import-check";
import { byName } from "./plans/names";
import type { Sheet } from "./schema/file";
import type { Tx } from "./tx";
import { openUpload } from "./uploads";

// 7c's "Drop the signed PDF", the kernel's side: what prompt 5's form mode may fill (a new row's plain fields,
// for someone who may add rows to the sheet), and its answer read the way an import reads a row's cells. A
// value the kernel can't read stays empty. Nothing is saved: the form is filled and the person creates it.

const FILLABLE = new Set(["text", "long_text", "number", "money", "percent", "date", "days", "person", "email", "phone", "url", "choice"]);

export async function formReading(tx: Tx, ctx: KernelCtx, capId: string, sheetId: string, uploadId: string) {
  const loaded = await load(tx);
  const access = await accessTo(tx, loaded, capId, ctx.actor.id);
  if (!access?.can("add", sheetId)) throw new AccessError("You can't add rows here.");
  const cap = access.cap.file;
  const sheet = cap.sheets.find((s) => s.id === sheetId);
  const fileColumn = sheet?.columns.find((c) => c.type === "file");
  if (!sheet || !fileColumn) throw new KernelError("This form takes no document.");
  const file = await openUpload(tx, ctx, uploadId);
  const people = [...loaded.people.values()];
  return {
    capability: cap.name,
    sheet,
    rowName: sheet.row?.one ?? "row",
    fileColumn: fileColumn.id,
    columns: sheet.columns.filter((c) => FILLABLE.has(c.type)).map((c) => ({ name: c.name, type: c.type, ...(c.options ? { choices: c.options.map((o) => o.name) } : {}) })),
    people: people.map((p) => p.name).sort(),
    keys: peopleKeys(people.map((p) => ({ id: p.id, name: p.name, email: p.email }))),
    file,
    formats: loaded.formats,
  };
}

// The answer as the form's values: each one read as an import reads a cell (dates, amounts, people, choices).
export function fieldsFrom(sheet: Sheet, answer: { column: string; value: string }[], keys: ReturnType<typeof peopleKeys>) {
  const usable = answer.filter((a) => {
    const c = byName(sheet.columns, a.column);
    return c && FILLABLE.has(c.type) && a.value.trim();
  });
  const header = usable.map((a) => byName(sheet.columns, a.column)!.name);
  const out = checkImport(sheet, [header, usable.map((a) => a.value)], header.map((h) => ({ from: h, to: h, format: "YYYY-MM-DD", values: [] })), keys);
  const values = out.rows[0]?.values ?? out.gaps[0]?.values ?? {};
  const step = sheet.columns.find((c) => c.type === "step");
  if (step) delete values[step.id];
  const filled = new Set(Object.keys(values));
  return { values, unread: usable.map((a) => byName(sheet.columns, a.column)!).filter((c) => !filled.has(c.id)).map((c) => c.name) };
}
