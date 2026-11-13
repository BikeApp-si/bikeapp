import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { accessTo } from "./access";
import { doItYourself, type Action } from "./actions";
import { capabilitiesFor } from "./capabilities";
import { load, type KernelCtx } from "./context";
import { listRows } from "./rows";
import { namesFor } from "./views";
import type { Sheet } from "./schema/file";
import type { Tx } from "./tx";

// What ⌘K can reach (0.4, M21): the person's capabilities and their sheets, the rows they add ("New contract", the
// same list as Do it yourself), the pages of the sidebar they have, and rows found by a few letters. Everything comes
// through the same access as the screens, so ⌘K never names a capability, sheet or row the person couldn't open.

export type CommandIndex = {
  capabilities: { id: string; name: string; icon: string; color: string; sheets: { id: string; name: string }[] }[];
  actions: Action[];
  pages: { label: string; href: string }[];
};

export type FoundRow = { id: string; title: string; capabilityId: string; capability: string; icon: string; sheetId: string; sheet: string; step: string | null };

export async function commandIndex(tx: Tx, ctx: KernelCtx): Promise<CommandIndex> {
  const loaded = await load(tx);
  const capabilities = [];
  for (const cap of await capabilitiesFor(tx, ctx)) {
    const access = await accessTo(tx, loaded, cap.id, ctx.actor.id);
    const sheets = (access?.cap.file.sheets ?? []).filter((s) => s.kind !== "lines" && access!.can("see", s.id)).map((s) => ({ id: s.id, name: s.name }));
    capabilities.push({ ...cap, sheets });
  }
  const [me] = await tx.select({ isAdmin: people.isAdmin }).from(people).where(eq(people.id, ctx.actor.id));
  // The sidebar's pages, in its order (Chats, Audit log, Ontology and Settings are for admins).
  const pages = [
    { label: "Home", href: "/home", all: true },
    { label: "Inbox", href: "/inbox", all: true },
    { label: "Chats", href: "/chats", all: false },
    { label: "People", href: "/people", all: true },
    { label: "Audit log", href: "/audit", all: false },
    { label: "Ontology", href: "/ontology", all: false },
    { label: "Settings", href: "/settings", all: false },
  ]
    .filter((p) => p.all || me?.isAdmin)
    .map(({ label, href }) => ({ label, href }));
  return { capabilities, actions: await doItYourself(tx, ctx), pages };
}

// A row's title as people read it: a person's or linked row's name, a choice's name, else the value.
export function titleShown(sheet: Sheet, data: Record<string, unknown>, names: { people: Record<string, string>; rows: Record<string, string> }): string {
  const title = sheet.columns.find((c) => c.id === sheet.titleColumn);
  const v = data[sheet.titleColumn];
  const shown =
    v == null || v === ""
      ? ""
      : title?.type === "person"
        ? (names.people[String(v)] ?? "")
        : title?.type === "link"
          ? (names.rows[String(v)] ?? "")
          : title?.type === "choice"
            ? (title.options?.find((o) => o.id === v)?.name ?? "")
            : String(v);
  return shown || `A ${sheet.row?.one ?? "row"}`;
}

const PER_SHEET = 3;
const AT_MOST = 12;

// Rows whose words match, from every sheet the person sees, through listRows (so own and team scopes hold).
export async function findRows(tx: Tx, ctx: KernelCtx, q: string): Promise<FoundRow[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const loaded = await load(tx);
  const out: FoundRow[] = [];
  for (const cap of await capabilitiesFor(tx, ctx)) {
    const access = await accessTo(tx, loaded, cap.id, ctx.actor.id);
    for (const sheet of access?.cap.file.sheets ?? []) {
      // Lines are found through their document.
      if (sheet.kind === "lines" || !access!.can("see", sheet.id)) continue;
      const found = await listRows(tx, ctx, cap.id, sheet.id, { search: text, limit: PER_SHEET });
      if (!found.length) continue;
      const names = await namesFor(tx, ctx, sheet, found);
      for (const r of found) {
        const step = sheet.steps?.find((s) => s.id === r.stepId)?.name ?? null;
        out.push({ id: r.id, title: titleShown(sheet, r.data, names), capabilityId: cap.id, capability: cap.name, icon: cap.icon, sheetId: sheet.id, sheet: sheet.name, step });
        if (out.length >= AT_MOST) return out;
      }
    }
  }
  return out;
}
