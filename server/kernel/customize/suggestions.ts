import { and, eq } from "drizzle-orm";
import { capabilities, customizeSuggestions } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import type { KernelCtx } from "../context";
import { norm } from "../plans/names";
import type { CapabilityFile } from "../schema/file";
import type { Tx } from "../tx";
import { currentTime } from "../clock";

// Customize's three suggestion chips (6b, 6g), stored per version. The small model writes them once after a
// version is saved; the kernel keeps only those that name things that exist, and only kinds 0.1 can apply.

export const SUGGESTABLE = new Set(["add_step", "add_column", "rename", "add_person_to_role", "rule", "set_role_view", "set_labels"]);

type Suggestion = { text: string; kind: string; names: string[] };

// The suggestions worth showing: every name they rely on is a sheet, column, step or role of this capability,
// or someone in People.
export function keepSuggestions(list: Suggestion[], file: CapabilityFile, people: string[]): string[] {
  const known = new Set(
    [
      ...file.sheets.flatMap((s) => [s.name, ...s.columns.map((c) => c.name), ...(s.steps ?? []).map((st) => st.name), ...(s.row ? [s.row.one, s.row.many] : [])]),
      ...file.roles.map((r) => r.name),
      ...people.flatMap((n) => [n, n.split(" ")[0]!]),
      file.name,
    ].map(norm),
  );
  return list
    .filter((s) => SUGGESTABLE.has(s.kind) && s.text.trim().length <= 40 && s.names.every((n) => known.has(norm(n))))
    .map((s) => s.text.trim())
    .slice(0, 3);
}

export async function saveSuggestions(tx: Tx, workspaceId: string, capabilityId: string, version: number, items: string[]) {
  await tx.insert(customizeSuggestions).values({ workspaceId, capabilityId, version, items, createdAt: currentTime() }).onConflictDoNothing();
}

// The chips for the capability's current version; none when they haven't been written (or the call failed).
export async function suggestionsFor(tx: Tx, ctx: KernelCtx, capabilityId: string): Promise<string[]> {
  await mustBeAdmin(tx, ctx);
  const [cap] = await tx.select({ version: capabilities.currentVersion }).from(capabilities).where(eq(capabilities.id, capabilityId));
  if (!cap) return [];
  const [row] = await tx
    .select({ items: customizeSuggestions.items })
    .from(customizeSuggestions)
    .where(and(eq(customizeSuggestions.capabilityId, capabilityId), eq(customizeSuggestions.version, cap.version)));
  return (row?.items as string[] | undefined) ?? [];
}
