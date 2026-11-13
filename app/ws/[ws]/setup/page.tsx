import { connection } from "next/server";
import { redirect } from "next/navigation";
import { SetupChat } from "@/components/setup/setup-chat";
import { edition } from "@/edition";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { setupView } from "@/server/setup/view";
import { hasModel } from "@/server/kernel/instance-settings";

// Setup 2b–2e on the workspace's own address, after sign up's handoff. Admins only.
export default async function SetupPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  const wsParam = (await params).ws;
  const ws = await currentWorkspace(wsParam);
  await requireAdmin(ws);
  const view = await asPage(wsParam, (tx, ctx) => setupView(tx, ctx));
  // 2f shows in the page right after Finish setup; coming back later goes Home.
  if (view.step === "done") redirect("/home");
  const address = new URL(edition.workspaceUrl(ws.subdomain)).host;
  return <SetupChat initial={view} address={address} noModel={!(await hasModel())} />;
}
