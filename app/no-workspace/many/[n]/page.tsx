import { AuthPage } from "@/components/auth/auth-page";
import { MANY_COMPANIES } from "@/server/edition/open";

// The open Bike whose database holds more than one company: none is served (O1), and the card says why.
export default async function ManyCompanies({ params }: { params: Promise<{ n: string }> }) {
  const n = Number((await params).n) || 2;
  return (
    <AuthPage width={420} className="gap-3 shadow-none">
      <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-primary font-semibold text-white">B</span>
      <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">This Bike can’t open</h1>
      <p className="m-0 text-base leading-[1.55] text-muted">{MANY_COMPANIES(n)}</p>
    </AuthPage>
  );
}
