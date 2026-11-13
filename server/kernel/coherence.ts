import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { coherenceChecks } from "@/db/schema";
import { mustBeAdmin } from "./admin";
import { currentTime } from "./clock";
import type { KernelCtx } from "./context";
import type { OntologyInput } from "./ontology";
import type { Tx } from "./tx";

// The coherence check, the kernel's side: what prompt 4's coherence mode reads (each capability's Customize
// text, as the Ontology has it), the check of what it found, and the one current result. Shown on the
// Ontology under Worth a look, before prompt 6's items, at most 5 in all.

export type CoherenceItem = { text: string; capabilities: string[] };
export type StoredCoherence = { inputHash: string; items: CoherenceItem[]; checkedAt: Date };

// The company's rules (0.2) go along only when there are any, so a company without them is checked exactly as before.
export const coherenceInputOf = (o: OntologyInput) => ({
  capabilities: o.capabilities.map((c) => ({ name: c.name, text: c.text })),
  ...(o.companyRules?.length ? { companyRules: o.companyRules } : {}),
});
export const coherenceHash = (o: OntologyInput) => createHash("sha256").update(JSON.stringify(coherenceInputOf(o))).digest("hex");

// Each item names capabilities that exist and no number their texts don't have.
export function checkCoherence(items: CoherenceItem[], o: OntologyInput): string[] {
  const problems: string[] = [];
  const names = new Set(o.capabilities.map((c) => c.name));
  const given = new Set(([...o.capabilities.map((c) => c.text), ...(o.companyRules ?? []).map((r) => r.text)].join(" ").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
  for (const it of items) {
    for (const n of it.capabilities) if (!names.has(n)) problems.push(`"${n}" isn't an app; use ${[...names].join(", ")}.`);
    for (const n of (it.text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ""))) if (!given.has(n)) problems.push(`${n} isn't in the app texts.`);
  }
  return problems;
}

export async function readCoherence(tx: Tx): Promise<StoredCoherence | null> {
  const [c] = await tx.select().from(coherenceChecks);
  return c ? { inputHash: c.inputHash, items: c.items as CoherenceItem[], checkedAt: c.checkedAt } : null;
}

export async function saveCoherence(tx: Tx, ctx: KernelCtx, inputHash: string, items: CoherenceItem[]) {
  await mustBeAdmin(tx, ctx);
  const values = { workspaceId: ctx.workspaceId, inputHash, items, checkedAt: ctx.now ?? currentTime() };
  const before = await readCoherence(tx);
  if (before) await tx.update(coherenceChecks).set(values).where(eq(coherenceChecks.workspaceId, ctx.workspaceId));
  else await tx.insert(coherenceChecks).values(values);
}

// Worth a look on 4e: the coherence check's items first (rules that fight matter most), then prompt 6's.
export function worthALook(coherence: CoherenceItem[], written: string[]): string[] {
  return [...coherence.map((c) => c.text), ...written].slice(0, 5);
}
