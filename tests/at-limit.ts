// Brings a capability up to the sheet limit (LIMITS.sheets, 6 since M25) with small list sheets, as an admin's
// Customize would, so a test can ask for one more sheet and see it refused. Used by the replays and by
// scripts/ai-record.ts in the same place, so the recorded requests and the replayed ones match.
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { getFile, saveVersion } from "@/server/kernel/capabilities";
import { LIMITS } from "@/server/kernel/schema/validate";
import type { Sheet } from "@/server/kernel/schema/file";
import { withWorkspace } from "@/server/kernel/tx";

// Fixed names, in this order, so every run sends the model the same file.
const EXTRA = ["Referrals", "Agencies", "Job boards", "Notes", "Sources", "Events"];

const sheet = (name: string): Sheet => ({
  id: name.toLowerCase().replace(/\s+/g, "_"),
  name,
  kind: "list",
  titleColumn: "name",
  columns: [{ id: "name", name: "Name", type: "text", required: true }],
});

export async function fillToSheetLimit(workspaceId: string, capabilityName: string, adminEmail = "wade@fernwood.dev") {
  await withWorkspace({ workspaceId }, async (tx) => {
    const [admin] = await tx.select({ id: people.id }).from(people).where(eq(people.email, adminEmail));
    const cap = await tx.query.capabilities.findFirst({ where: (c, { and, eq: e, isNull }) => and(e(c.name, capabilityName), isNull(c.deletedAt)) });
    if (!admin || !cap) throw new Error(`No ${capabilityName} or ${adminEmail} in this workspace.`);
    const file = structuredClone((await getFile(tx, cap.id))!.file);
    const room = LIMITS.sheets - file.sheets.length;
    if (room <= 0) return;
    file.sheets.push(...EXTRA.filter((n) => !file.sheets.some((s) => s.name === n)).slice(0, room).map(sheet));
    const ctx = { workspaceId, actor: { id: admin.id, email: adminEmail } };
    await saveVersion(tx, ctx, cap.id, file, { source: "customize", event: "customize.saved", details: { summary: `sheets added up to ${LIMITS.sheets}` } });
  });
}
