import { companyEntries } from "../rule-set";
import { people as peopleTable, workspaces } from "@/db/schema";
import { mustBeAdmin } from "../admin";
import { capabilitiesFor } from "../capabilities";
import { load, type KernelCtx } from "../context";
import type { CapabilityFile } from "../schema/file";
import type { Tx } from "../tx";
import { describeAll } from "./structure";

// What a plan is built from, read with the asking admin's access: the capabilities they can see (structure
// only, by name), People, and the company. The same call gives the names the kernel checks the plan against,
// so the AI can't name a capability the admin can't see.
export async function planContext(tx: Tx, ctx: KernelCtx) {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const visible = await capabilitiesFor(tx, ctx);
  const files = new Map<string, CapabilityFile>(visible.map((c) => [c.id, loaded.files.get(c.id)!.file]));
  const [ws] = await tx.select({ name: workspaces.name, timeZone: workspaces.timeZone }).from(workspaces);
  const people = [...loaded.people.values()];
  const me = loaded.people.get(ctx.actor.id)!;
  const personName = (id: string) => loaded.people.get(id)?.name;
  const managerEmail = (id: string | null) => (id ? loaded.people.get(id)?.email : undefined) ?? null;
  const directory = await tx.select({ id: peopleTable.id, title: peopleTable.title, team: peopleTable.team }).from(peopleTable);
  const extra = new Map(directory.map((p) => [p.id, p]));
  return {
    files,
    // The company's rules (0.2), for the loop check.
    companyRules: companyEntries(loaded.rules),
    order: visible.map((c) => c.id),
    peopleByEmail: new Map(people.map((p) => [p.email.toLowerCase(), p.id])),
    personName,
    company: { name: ws!.name, people: people.length, currency: loaded.formats.currency, timeZone: ws!.timeZone },
    user: { name: me.name, email: me.email },
    existing: describeAll(
      visible.map((c) => c.id),
      files,
      personName,
    ),
    people: people
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, email: p.email, title: extra.get(p.id)?.title ?? null, team: extra.get(p.id)?.team ?? null, manager: managerEmail(p.managerId) })),
  };
}
export type PlanContext = Awaited<ReturnType<typeof planContext>>;
