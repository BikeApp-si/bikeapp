import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CodeForm } from "@/components/auth/code-form";
import { LOGIN_EMAIL_COOKIE, currentWorkspace, readPendingCode } from "@/server/auth/current";
import { companyLogo } from "@/server/auth/logo";
import { mailRelay } from "@/server/email/send";
import { signInCodeAction } from "../actions";

// 1c / 1d.
export default async function CodePage({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await currentWorkspace((await params).ws);
  const pending = readPendingCode((await cookies()).get(LOGIN_EMAIL_COOKIE)?.value);
  if (!pending) redirect("/login");
  return <CodeForm email={pending.email} backHref="/login" action={signInCodeAction} sentAt={pending.sentAt} logo={await companyLogo(ws)} noRelay={!mailRelay()} />;
}
