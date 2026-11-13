// The six Fernwood capabilities with the rows the Step 6–8 screens show. Report history comes in M8, in its
// own part (seed/history/), without changing what these screens show.
import { capabilities } from "@/db/schema";
import { saveSuggestions } from "@/server/kernel/customize/suggestions";
import { withWorkspace } from "@/server/kernel/tx";
import { seedCustomerContracts } from "./customer-contracts";
import { seedHiring, startHiring } from "./hiring";
import { seedOnboarding } from "./onboarding";
import { TODAY, seeder } from "./seeder";
import { seedSpend } from "./spend";
import { seedTimeOff } from "./time-off";
import { seedToolsAndBudgets } from "./tools-and-budgets";

// Safe to run again: a workspace that already has capabilities is left as it is. contracts: false leaves
// Customer contracts out, for Fernwood as it was before Step 5 created it from chat (5a–5j).
export async function seedCapabilities(workspaceId: string, opts: { contracts?: boolean } = {}): Promise<boolean> {
  const seeded = await seedFiles(workspaceId, opts);
  if (seeded) await runSeedAiSteps(workspaceId);
  return seeded;
}

// The AI steps the seed's rules queued (8h: a category for each of the 18 Zoho expenses), answered from the
// recordings, so seeding never calls the AI; `pnpm ai:record` records them like any other answer.
async function runSeedAiSteps(workspaceId: string) {
  const { runQueued } = await import("@/server/jobs/run");
  await import("@/server/jobs/runners");
  const { withProvider } = await import("@/server/ai/gateway");
  const { fixturesProvider } = await import("@/server/ai/providers/fixtures");
  const { atInstant } = await import("@/server/kernel/clock");
  // Answered the morning the screens assume, just after the daily run, the same every time.
  const run = () => atInstant(new Date(`${TODAY}T11:01:00Z`), () => runQueued(workspaceId));
  if (process.env.AI_PROVIDER === "record") await run();
  else await withProvider(fixturesProvider(), run);
}

async function seedFiles(workspaceId: string, opts: { contracts?: boolean }): Promise<boolean> {
  return withWorkspace({ workspaceId }, async (tx) => {
    if ((await tx.$count(capabilities)) > 0) return false;
    const s = await seeder(tx, workspaceId);
    // In the sidebar's order (6b): each one's position is the order it was added.
    const hiring = await startHiring(s);
    const onboarding = await seedOnboarding(s);
    await seedHiring(s, hiring, onboarding);
    // Customize's chips as 6g shows them, for Hiring's version 3.
    await saveSuggestions(tx, workspaceId, hiring, 3, ["Rename Hired to Offer accepted", "Let managers see their candidates", "Remind me about open offers"]);
    await seedTimeOff(s);
    await seedSpend(s);
    await seedToolsAndBudgets(s);
    if (opts.contracts !== false) {
      const contracts = await seedCustomerContracts(s);
      // 6b's chips, for version 4.
      await saveSuggestions(tx, workspaceId, contracts, 4, ["Add a legal review for big contracts", "Remind owners earlier", "Let Lena see every contract"]);
    }
    // The daily runs up to the morning the screens assume.
    await s.toToday();
    // A company that has used these for weeks: no "new capability" tutorial cards (0.4, M24).
    await tx.update(capabilities).set({ introduce: false });
    return true;
  });
}
