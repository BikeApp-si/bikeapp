import { accessTo } from "./access";
import { titleShown } from "./commands";
import { capabilitiesFor } from "./capabilities";
import { load, type KernelCtx } from "./context";
import { countRows, getRow, listRows } from "./rows";
import type { Column } from "./schema/file";
import type { Tx } from "./tx";
import { namesFor, rowWords } from "./views";

// The rows that point at a row (0.4, M22): a contract's renewals and contacts, in any capability, through each sheet's
// own access. A sheet the person can't see isn't named; its rows come through listRows, so own and team scopes hold.
// Lines aren't here: the record panel already shows a document's lines. A sheet with none yet is listed only for
// someone who can add the first.

export type RelatedRow = { id: string; title: string; step: string | null; stepId: string | null; data: Record<string, unknown> };
export type RelatedSheet = {
  capabilityId: string;
  capability: string;
  sheetId: string;
  sheet: string;
  titleName: string; // the name of the column that titles each row
  column: { id: string; name: string }; // the link column that points here
  shownColumns: Column[]; // the two answers each row shows, besides its title and step
  one: string;
  many: string;
  addAction: string;
  canAdd: boolean;
  count: number;
  rows: RelatedRow[];
  names: { people: Record<string, string>; rows: Record<string, string>; files: Record<string, string> };
};

const AT_MOST = 20;
const SHOWN = 2;

export async function relatedRows(tx: Tx, ctx: KernelCtx, rowId: string): Promise<RelatedSheet[]> {
  const row = await getRow(tx, ctx, rowId); // refused when the person can't see it
  const loaded = await load(tx);
  const out: RelatedSheet[] = [];
  for (const cap of await capabilitiesFor(tx, ctx)) {
    const access = await accessTo(tx, loaded, cap.id, ctx.actor.id);
    for (const sheet of access?.cap.file.sheets ?? []) {
      if (sheet.kind === "lines" || !access!.can("see", sheet.id)) continue;
      // Not a ledger's reversal (M29): the entry reversing this one is a row of the same sheet, shown as Reversed.
      const links = sheet.columns.filter(
        (c) => c.type === "link" && c.link && (c.link.capability ?? cap.id) === row.capabilityId && c.link.sheet === row.sheetId && c.id !== sheet.ledger?.reverses,
      );
      for (const link of links) {
        const filters = [{ column: link.id, op: "in" as const, values: [rowId] }];
        const count = await countRows(tx, ctx, cap.id, sheet.id, { filters });
        const canAdd = access!.can("add", sheet.id);
        // With none yet, it's listed only for someone who can add the first.
        if (!count && !canAdd) continue;
        const found = await listRows(tx, ctx, cap.id, sheet.id, { filters, limit: AT_MOST });
        const names = await namesFor(tx, ctx, sheet, found);
        const shownColumns = sheet.columns
          .filter((c) => c.id !== sheet.titleColumn && c.id !== link.id && c.type !== "step" && !c.hintFor && c.type !== "computed" && c.type !== "file" && c.type !== "long_text")
          .slice(0, SHOWN);
        const { row: words } = rowWords(sheet);
        out.push({
          capabilityId: cap.id,
          capability: cap.name,
          sheetId: sheet.id,
          sheet: sheet.name,
          titleName: sheet.columns.find((c) => c.id === sheet.titleColumn)?.name ?? words.one,
          column: { id: link.id, name: link.name },
          shownColumns,
          one: words.one,
          many: words.many,
          addAction: sheet.addAction ?? `Add ${words.one}`,
          canAdd,
          count,
          rows: found.map((r) => ({
            id: r.id,
            title: titleShown(sheet, r.data, names),
            stepId: r.stepId,
            step: sheet.steps?.find((s) => s.id === r.stepId)?.name ?? null,
            data: Object.fromEntries(shownColumns.map((c) => [c.id, r.data[c.id]])),
          })),
          names,
        });
      }
    }
  }
  return out;
}
