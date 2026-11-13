import type { Metadata } from "next";
import { companyLogo } from "@/server/auth/logo";
import { currentWorkspace } from "@/server/auth/current";

// On a company's address the browser tab shows the company's logo once an admin uploads one; Bike's B until then.
export async function generateMetadata({ params }: { params: Promise<{ ws: string }> }): Promise<Metadata> {
  const logo = await companyLogo(await currentWorkspace((await params).ws));
  return logo ? { icons: { icon: logo, apple: logo } } : {};
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
