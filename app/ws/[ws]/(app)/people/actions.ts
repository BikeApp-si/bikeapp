"use server";

import { checkTeamCsv } from "@/server/kernel/people";
import { addPerson, importPeopleCsv, rolesOf, type NewPerson } from "@/server/kernel/directory";
import { asAction } from "@/server/auth/kernel-call";

// People's reads and writes; each is a kernel call as the signed-in person (adding is for admins only).

export async function personRoles(personId: string) {
  return asAction(async (tx, ctx) => ({ roles: await rolesOf(tx, ctx, personId) }));
}

export async function createPerson(input: NewPerson) {
  return asAction(async (tx, ctx) => addPerson(tx, ctx, input));
}

// Import CSV: first a preview with the count and any problems, then the import, all or nothing.
export async function previewPeopleCsv(text: string) {
  const check = checkTeamCsv(text);
  return { count: check.rows.length, problems: [...check.problems, ...check.questions], flagged: check.flagged };
}

export async function importPeople(name: string, text: string) {
  return asAction(async (tx, ctx) => importPeopleCsv(tx, ctx, { name, text }));
}
