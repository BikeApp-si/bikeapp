"use server";

import { cookies } from "next/headers";
import { LOGIN_EMAIL_COOKIE, readPendingCode, shortCookie, workspaceFromHost } from "@/server/auth/current";
import { requestMeta } from "@/server/auth/request";
import { checkSignInCode, requestSignInCode } from "@/server/auth/signin";
import { orUnsent } from "@/server/email/send";
import { UNSENT } from "@/lib/messages";
import { endSession, SESSION_COOKIE, sessionCookie } from "@/server/auth/session";
import type { CodeState } from "@/components/auth/code-form";

export type LoginState = { error: string | null; email: string; next?: string };

// 1a Continue with email.
export async function sendSignInCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Please enter your work email.", email };
  const ws = await workspaceFromHost();
  const meta = await requestMeta();
  const sent = await orUnsent(() => requestSignInCode(ws, email, meta), () => null);
  if (!sent) return { error: UNSENT, email };
  if (!sent.ok) return { error: `Too many codes. Try again in ${sent.retryInMinutes} ${sent.retryInMinutes === 1 ? "minute" : "minutes"}.`, email };
  (await cookies()).set(shortCookie(LOGIN_EMAIL_COOKIE, JSON.stringify({ email, sentAt: Date.now() }), 15 * 60));
  return { error: null, email, next: "/code" };
}

async function loginEmail() {
  return readPendingCode((await cookies()).get(LOGIN_EMAIL_COOKIE)?.value)?.email ?? null;
}

const backToLogin: CodeState = { status: "go", next: "/login", sentAt: 0 };

// 1c / 1d: Verify, or Resend / Send a new code.
export async function signInCodeAction(prev: CodeState, form: FormData): Promise<CodeState> {
  return orUnsent(() => checkOrResend(prev, form), () => ({ status: "unsent" as const, sentAt: prev.sentAt }));
}

// Verify (a fifth wrong try sends a new code), or Resend: both may send an email.
async function checkOrResend(prev: CodeState, form: FormData): Promise<CodeState> {
  if (form.get("intent") === "resend") return resendSignInCode();
  const ws = await workspaceFromHost();
  const email = await loginEmail();
  if (!email) return backToLogin;
  const result = await checkSignInCode(ws, email, String(form.get("code") ?? ""), await requestMeta());
  if (result.ok) {
    const jar = await cookies();
    jar.set(sessionCookie(result.sessionToken));
    jar.delete(LOGIN_EMAIL_COOKIE);
    return { status: "go", next: "/home", sentAt: 0 };
  }
  if (result.newCodeSent) return { status: "sent", sentAt: Date.now() };
  // No code is waiting (expired, used up or never sent).
  if (result.triesLeft === null) return { status: "expired", sentAt: prev.sentAt };
  return { status: "wrong", triesLeft: result.triesLeft, sentAt: prev.sentAt };
}

async function resendSignInCode(): Promise<CodeState> {
  const ws = await workspaceFromHost();
  const email = await loginEmail();
  if (!email) return backToLogin;
  const sent = await requestSignInCode(ws, email, await requestMeta());
  if (!sent.ok) return { status: "limited", retryInMinutes: sent.retryInMinutes, sentAt: Date.now() };
  return { status: "sent", sentAt: Date.now() };
}

// The menu on the name at the bottom of the sidebar: Log out ends this address's session, then 1a.
export async function logOut(): Promise<{ next: string }> {
  const ws = await workspaceFromHost();
  const jar = await cookies();
  await endSession(ws.id, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return { next: "/login" };
}
