import { NavigationPanel, NavigationProvider } from "@/components/shell/navigation";
import { CommandBar } from "@/components/shell/command-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { currentWorkspace, requirePerson } from "@/server/auth/current";
import { CapIcon } from "@/components/cap-icon";
import { capColor } from "@/lib/cap-colors";
import { capabilitiesFor } from "@/server/kernel/capabilities";
import { peopleCount } from "@/server/kernel/directory";
import { workspaceLogo } from "@/server/kernel/settings";
import { withWorkspace } from "@/server/kernel/tx";
import { waitingCounts } from "@/server/kernel/waiting";
import { logOut } from "../actions";
import { edition } from "@/edition";
import { workspaceFormats } from "@/server/kernel/context";
import { FormatsProvider } from "@/components/formats";
import { ModelProvider } from "@/components/no-model";
import { hasModel } from "@/server/kernel/instance-settings";

// The signed-in frame: sidebar, a straight line, and the main panel.
export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ws: string }> }) {
  const ws = await currentWorkspace((await params).ws);
  const person = await requirePerson(ws);
  const count = await peopleCount(ws.id, person.id);
  const ctx = { workspaceId: ws.id, actor: { id: person.id, email: person.email } };
  const { caps, logo, waiting, credits, formats } = await withWorkspace({ workspaceId: ws.id, personId: person.id }, async (tx) => ({
    caps: await capabilitiesFor(tx, ctx),
    logo: await workspaceLogo(tx),
    waiting: await waitingCounts(tx, ctx),
    // Hosted (P1): admins see the company's AI credits above their name.
    credits: person.isAdmin ? await edition.adminCredits(tx) : null,
    formats: await workspaceFormats(tx),
  }));
  const capabilities = caps.map((c) => ({ id: c.id, name: c.name, icon: <CapIcon name={c.icon} size={16} strokeWidth={1.8} color={capColor(c.color)} />, waiting: waiting[c.id] ?? 0 }));
  const model = await hasModel();
  return (
    <FormatsProvider formats={formats}>
     <ModelProvider none={!model} admin={person.isAdmin}>
      <NavigationProvider>
        <div className="flex h-screen min-h-[480px] bg-white text-ink">
          <Sidebar workspaceName={ws.name} logoUploadId={logo} peopleCount={count} person={person} capabilities={capabilities} toDo={Object.values(waiting).reduce((a, n) => a + n, 0)} credits={credits} logOut={logOut} docsUrl={edition.docsUrl()} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l border-line">
            <NavigationPanel>{children}</NavigationPanel>
          </div>
        </div>
        <CommandBar />
      </NavigationProvider>
     </ModelProvider>
    </FormatsProvider>
  );
}
