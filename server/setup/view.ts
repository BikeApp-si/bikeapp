import { eq } from "drizzle-orm";
import { people, workspaces } from "@/db/schema";
import type { KernelCtx } from "@/server/kernel/context";
import { addressLine, fromAddress, fromAddressLine } from "@/server/kernel/setup/organization";
import { readSetup, stale, type SetupFile } from "@/server/kernel/setup/state";
import { leadsTable, teamSummary } from "@/server/kernel/setup/team";
import type { Tx } from "@/server/kernel/tx";

// What the setup page shows (2b–2f), worked out from setup's state: the readings as the tables on 2c and 2e.

export type SetupReply =
  | { kind: "working" }
  | { kind: "failed"; text: string }
  | { kind: "organization"; text: string; rows: [string, string | null][]; missing: string[]; latest: boolean }
  | { kind: "team"; text: string; leads: { name: string; title: string; reports: number; role: string }[]; problems: string[]; latest: boolean };

export type SetupShown = { from: "admin"; text: string; files: SetupFile[] } | ({ from: "bike" } & SetupReply);

export type SetupView =
  | { step: "organization" | "team"; name: string; messages: SetupShown[]; working: boolean; ready: boolean }
  | { step: "done"; name: string; people: number; organization: string; team: string; leftOut: string[]; noManager: string[] };

const STOPPED = "That stopped before it finished. Send it again.";

export async function setupView(tx: Tx, ctx: KernelCtx): Promise<SetupView> {
  const { state } = await readSetup(tx, ctx);
  const [ws] = await tx.select().from(workspaces);
  if (state.step === "done") {
    const t = await teamSummary(tx);
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    return {
      step: "done",
      name: ws!.name,
      people: t.people,
      organization: [ws!.name, ws!.city, ws!.website].filter(Boolean).join(" · "),
      team: [n(t.people, "person", "people"), n(t.teams, "team", "teams"), n(t.roles, "role", "roles")].join(" · "),
      leftOut: state.done?.leftOut ?? [],
      noManager: state.done?.noManager ?? [],
    };
  }
  const [owner] = await tx.select({ email: people.email }).from(people).where(eq(people.id, ws!.ownerId!));
  const lastDone = state.messages.findLastIndex((m) => m.from === "bike" && m.status === "done");
  const messages: SetupShown[] = state.messages.map((m, i) => {
    if (m.from === "admin") return m;
    if (m.status === "working") return stale(m.since, ctx.now) ? { from: "bike", kind: "failed", text: STOPPED } : { from: "bike", kind: "working" };
    if (m.status === "failed") return { from: "bike", kind: "failed", text: m.text };
    const latest = i === lastDone;
    if (m.organization) {
      const r = m.organization;
      const f = fromAddress(r.address?.country, ws!.timeZone);
      const rows: [string, string | null][] = [
        ["Name", r.name],
        ["Address", addressLine(r.address) || null],
        ["Website", r.website ?? null],
        ["What it does", r.what_it_does],
        ["Business model", r.business_model],
        ["Products", r.products.join(", ") || null],
        ["Set from your address", fromAddressLine(f)],
      ];
      return { from: "bike", kind: "organization", text: m.text, rows, missing: r.missing, latest };
    }
    if (m.team) {
      const t = leadsTable(m.team);
      const leads = t.leads.map((l) => ({ name: l.key === owner?.email ? `${l.name} (you)` : l.name, title: l.title ?? "", reports: l.reports, role: l.role }));
      return { from: "bike", kind: "team", text: m.text, leads, problems: m.team.problems, latest };
    }
    return { from: "bike", kind: "failed", text: m.text };
  });
  const working = messages.some((m) => m.from === "bike" && m.kind === "working");
  return { step: state.step, name: ws!.name, messages, working, ready: messages.some((m) => m.from === "bike" && (m.kind === "organization" || m.kind === "team") && m.latest) };
}
