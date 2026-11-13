import { mustBeAdmin } from "@/server/kernel/admin";
import { listPeople } from "@/server/kernel/directory";
import { suggestSlots } from "@/server/kernel/gallery/add";
import { referencesIn, type AppSet } from "@/server/kernel/gallery/format";
import type { KernelCtx } from "@/server/kernel/context";
import type { Tx } from "@/server/kernel/tx";
import { desc } from "drizzle-orm";
import { capabilities } from "@/db/schema";
import { tintAt } from "@/lib/avatar";
import { setText } from "./text";

// What the add page (G2) shows before anything is checked: the set's apps with the apps each needs, its role slots
// (one person or a group, what each does), the company rules with the apps and slots they use, and the company's
// people with those suggested by job title. Admins only. Picking and Add go through previewSet and addSet.

export type AddPage = {
  apps: { key: string; name: string; icon: string; color: string; description: string; needs: string[]; slots: string[] }[];
  slots: { key: string; name: string; does: string | null; one: boolean }[];
  rules: { apps: string[]; slots: string[] }[];
  people: { id: string; name: string; tint: string }[];
  suggested: Record<string, string[]>;
};

export async function addPage(tx: Tx, ctx: KernelCtx, set: AppSet): Promise<AddPage> {
  await mustBeAdmin(tx, ctx);
  const people = await listPeople(tx);
  const single = referencesIn([set.files, set.companyRules]).single;
  const [last] = await tx.select({ color: capabilities.color }).from(capabilities).orderBy(desc(capabilities.position)).limit(1);
  const text = setText(set, undefined, last?.color ?? null);
  return {
    apps: text.map((a) => {
      const refs = referencesIn(set.files[a.key]);
      return { key: a.key, name: a.name, icon: a.icon, color: a.color, description: a.description, needs: [...refs.apps].filter((x) => x !== a.key), slots: [...refs.slots] };
    }),
    slots: set.slots.map((s) => ({ key: s.key, name: s.name, does: s.does ?? null, one: single.has(s.key) })),
    rules: set.companyRules.map((r) => {
      const refs = referencesIn(r);
      return { apps: [...refs.apps], slots: [...refs.slots] };
    }),
    people: people.map((p, i) => ({ id: p.id, name: p.name, tint: tintAt(i) })),
    suggested: suggestSlots(set, people),
  };
}
