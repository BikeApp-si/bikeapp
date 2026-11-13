import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { edition } from "@/edition";
import { workspaceBySubdomain, type Workspace } from "@/server/kernel/workspaces";
import { personForSession, SESSION_COOKIE, type SignedIn } from "./session";

// The workspace of this request, from the host. The [ws] segment must agree with it.
export const currentWorkspace = cache(async (wsParam: string): Promise<Workspace> => {
  const route = await edition.route((await headers()).get("host"));
  if (route.kind !== "workspace" || route.subdomain !== wsParam) notFound();
  const ws = await workspaceBySubdomain(route.subdomain);
  if (!ws) notFound();
  return ws;
});

// The signed-in person, only if their session belongs to this workspace.
export const currentPerson = cache(async (ws: Workspace): Promise<SignedIn | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return personForSession(ws.id, token);
});

export async function requirePerson(ws: Workspace): Promise<SignedIn> {
  const person = await currentPerson(ws);
  if (!person) redirect("/login");
  return person;
}

export async function requireAdmin(ws: Workspace): Promise<SignedIn> {
  const person = await requirePerson(ws);
  if (!person.isAdmin) notFound();
  return person;
}

// For server actions: the workspace comes from the host only, never from anything the browser sends.
export async function workspaceFromHost(): Promise<Workspace> {
  const route = await edition.route((await headers()).get("host"));
  const ws = route.kind === "workspace" ? await workspaceBySubdomain(route.subdomain) : null;
  if (!ws) throw new Error("No workspace at this address");
  return ws;
}

export const LOGIN_EMAIL_COOKIE = "bike_login_email";
export const SIGNUP_COOKIE = "bike_signup";

export function shortCookie(name: string, value: string, maxAgeSeconds: number) {
  return { name, value, httpOnly: true, sameSite: "lax" as const, secure: edition.secureCookies(), path: "/", maxAge: maxAgeSeconds };
}

// Which email a code was sent to, and when: kept in a short httpOnly cookie between 1a and 1c.
export function readPendingCode(value: string | undefined): { email: string; sentAt: number } | null {
  try {
    const v = JSON.parse(value ?? "") as { email?: unknown; sentAt?: unknown };
    return typeof v.email === "string" && typeof v.sentAt === "number" ? { email: v.email, sentAt: v.sentAt } : null;
  } catch {
    return null;
  }
}

// The sign up in progress on the root host: its token, when the code was sent, and the browser's time zone.
export function readSignupCookie(value: string | undefined): { token: string; sentAt: number; timeZone: string } | null {
  try {
    const v = JSON.parse(value ?? "") as { token?: unknown; sentAt?: unknown; timeZone?: unknown };
    if (typeof v.token !== "string" || typeof v.sentAt !== "number") return null;
    return { token: v.token, sentAt: v.sentAt, timeZone: typeof v.timeZone === "string" ? v.timeZone : "UTC" };
  } catch {
    return null;
  }
}
