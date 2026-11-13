import Link from "next/link";
import { headers } from "next/headers";
import { MessageCard } from "@/components/auth/message-card";
import { linkClass } from "@/components/auth/controls";
import { edition } from "@/edition";
import NoWorkspace from "@/app/no-workspace/page";
import { companyLogo } from "@/server/auth/logo";
import { workspaceBySubdomain } from "@/server/kernel/workspaces";

// Any address with no page, and any page that isn't there (notFound): on a company's address on the sign-in card,
// with the way back; elsewhere the edition's page (hosted: bikeapp.si in the website's style), or X4.
export default async function NotFound() {
  const route = await edition.route((await headers()).get("host"));
  const ws = route.kind === "workspace" ? await workspaceBySubdomain(route.subdomain) : null;
  if (ws) {
    return (
      <MessageCard title="Page not found" text="There’s nothing at this address." logo={await companyLogo(ws)}>
        <p className="m-0 text-center text-[15px]">
          <Link href="/home" className={linkClass}>
            Go to Home
          </Link>
        </p>
      </MessageCard>
    );
  }
  return (await edition.siteNotFound()) ?? <NoWorkspace />;
}
