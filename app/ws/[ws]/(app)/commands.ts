"use server";

import { asAction } from "@/server/auth/kernel-call";
import { commandIndex, findRows } from "@/server/kernel/commands";

// ⌘K (0.4, M21): what the person can jump to, and rows found by a few letters. Kernel reads as the signed-in person.

export async function commandsFor() {
  return asAction(async (tx, ctx) => ({ index: await commandIndex(tx, ctx) }));
}

export async function findForCommand(q: string) {
  return asAction(async (tx, ctx) => ({ rows: await findRows(tx, ctx, q) }));
}
