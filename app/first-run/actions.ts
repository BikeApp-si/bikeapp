"use server";

import { cookies, headers } from "next/headers";
import { edition } from "@/edition";
import { openEdition } from "@/server/edition/open";
import { LOGIN_EMAIL_COOKIE, shortCookie } from "@/server/auth/current";
import { requestMeta } from "@/server/auth/request";
import { requestSignInCode } from "@/server/auth/signin";
import { orUnsent } from "@/server/email/send";
import { createFirstCompany, storedAddress } from "@/server/kernel/instance";
import { workspaceBySubdomain } from "@/server/kernel/workspaces";
import { UNSENT } from "@/lib/messages";

export type FirstRunState = { error: string | null; codeWrong?: boolean; next?: string; values?: Record<string, string> };

const NOT_HERE = "This Bike is already set up.";

// Create company (a-first-run.png): only while the open Bike has no company, at its own address. Then a sign-in code
// goes to the new admin (by email, or to the log without a relay) and they land on 1c.
export async function createCompanyAction(_prev: FirstRunState, form: FormData): Promise<FirstRunState> {
  const values = Object.fromEntries(["company", "name", "email", "timeZone", "aiKey"].map((k) => [k, String(form.get(k) ?? "")]));
  if ((await edition.route((await headers()).get("host"))).kind !== "firstRun") return { error: NOT_HERE, values };
  const result = await createFirstCompany({ code: String(form.get("code") ?? ""), company: values.company!, name: values.name!, email: values.email!, timeZone: values.timeZone!, aiKey: values.aiKey });
  if (!result.ok) return { error: result.error, codeWrong: result.codeWrong, values };
  openEdition.forget();
  const ws = (await workspaceBySubdomain(storedAddress(values.company!)))!;
  const meta = await requestMeta();
  const sent = await orUnsent(() => requestSignInCode(ws, result.email, meta), () => null);
  if (!sent?.ok) return { error: sent ? null : UNSENT, next: "/login" };
  (await cookies()).set(shortCookie(LOGIN_EMAIL_COOKIE, JSON.stringify({ email: result.email, sentAt: Date.now() }), 15 * 60));
  return { error: null, next: "/code" };
}
