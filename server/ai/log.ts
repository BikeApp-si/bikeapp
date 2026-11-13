import { aiCalls } from "@/db/schema";
import { withWorkspace } from "@/server/kernel/tx";
import { costOf, type Usage } from "./prices";
import { edition } from "@/edition";
import { currentTime } from "@/server/kernel/clock";

// Every AI call is logged in its own transaction, so a call that fails or is refused is still counted, with its real
// cost and the credits it takes (hosted, P1; none in the open Bike). What a company has left is in credits.ts.

export type Who = { workspaceId: string; personId: string | null; capabilityId?: string | null; chatId?: string | null };

export type CallLog = { prompt: string; version: number; model: string; usage: Usage; ms: number; attempt: number; passed: boolean; problem?: string | null };

export async function logCall(who: Who, c: CallLog) {
  const cost = costOf(c.model, c.usage);
  await withWorkspace({ workspaceId: who.workspaceId, personId: who.personId }, (tx) =>
    tx.insert(aiCalls).values({
      workspaceId: who.workspaceId,
      prompt: c.prompt,
      version: c.version,
      model: c.model,
      tokensIn: c.usage.tokensIn,
      tokensOut: c.usage.tokensOut,
      cacheRead: c.usage.cacheRead,
      cacheWrite: c.usage.cacheWrite,
      costUsd: cost.toFixed(6),
      credits: edition.creditsFor(cost),
      ms: c.ms,
      personId: who.personId,
      capabilityId: who.capabilityId ?? null,
      chatId: who.chatId ?? null,
      attempt: c.attempt,
      passed: c.passed,
      problem: c.problem ?? null,
      at: currentTime(),
    }),
  );
}
