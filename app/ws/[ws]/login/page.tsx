import { redirect } from "next/navigation";
import { AuthHeading, AuthPage } from "@/components/auth/auth-page";
import { Divider, linkClass } from "@/components/auth/controls";
import { LoginForm } from "@/components/auth/login-form";
import { currentPerson, currentWorkspace } from "@/server/auth/current";
import { companyLogo } from "@/server/auth/logo";
import { edition } from "@/edition";
import { sendSignInCode } from "../actions";

// 1a Log in on the company's own address.
export default async function LoginPage({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await currentWorkspace((await params).ws);
  if (await currentPerson(ws)) redirect("/home");
  const createCompany = edition.createCompanyUrl();
  return (
    <AuthPage width={380}>
      <AuthHeading title="Welcome back" logo={await companyLogo(ws)}>Sign in to your company’s Bike</AuthHeading>
      <LoginForm action={sendSignInCode} />
      <p className="m-0 text-center text-[15px] text-muted">We’ll email you a 6-character code. No password to remember.</p>
      {createCompany ? (
        <>
          <Divider />
          <p className="m-0 text-center text-[15px] text-muted">
            New to Bike? <a href={createCompany} className={linkClass}>Create a company</a>
          </p>
        </>
      ) : null}
    </AuthPage>
  );
}
