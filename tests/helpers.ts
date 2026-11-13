import { outbox } from "@/server/email/send";
import { createWorkspace, workspaceBySubdomain } from "@/server/kernel/workspaces";

export const meta = (ip = "10.0.0.1") => ({ ip, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36", city: null });

let n = 0;
// A fresh workspace per test, so tests don't share rate limits or codes.
export async function freshWorkspace(adminEmail?: string) {
  const sub = `t${Date.now().toString(36)}${n++}`;
  const email = adminEmail ?? `admin@${sub}.dev`;
  const created = await createWorkspace({ subdomain: sub, name: `${sub} Labs`, timeZone: "America/Chicago", admin: { name: "Ada Admin", email } });
  return { ...created, ws: (await workspaceBySubdomain(sub))!, email };
}

// The code from the last email sent to this address.
export function lastCode(to: string): string {
  const mail = [...outbox()].reverse().find((m) => m.to === to);
  const code = mail?.subject.match(/Your Bike code: (\w{3}-\w{3})/)?.[1];
  if (!code) throw new Error(`No code email for ${to}`);
  return code;
}
