import { AuthPage } from "@/components/auth/auth-page";

// X4: a mistyped or unknown address.
export default function NoWorkspace() {
  return (
    <AuthPage width={420} className="gap-3 shadow-none">
      <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-primary font-semibold text-white">B</span>
      <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">No workspace at this address</h1>
      <p className="m-0 text-base leading-[1.55] text-muted">Check the address, or ask your admin for your company’s Bike address.</p>
    </AuthPage>
  );
}
