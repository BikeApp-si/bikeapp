import { AuthHeading, AuthPage } from "./auth-page";

// A short message on a company's address, on the sign-in card: Page not found, or Something went wrong.
export function MessageCard({ title, text, logo, children }: { title: string; text: string; logo?: string | null; children: React.ReactNode }) {
  return (
    <AuthPage width={380}>
      <AuthHeading title={title} logo={logo}>
        {text}
      </AuthHeading>
      <div className="flex flex-col gap-3">{children}</div>
    </AuthPage>
  );
}
