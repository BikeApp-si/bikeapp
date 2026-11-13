import { currentWorkspace } from "@/server/auth/current";
import { publicLogo } from "@/server/kernel/settings";
import { withWorkspace } from "@/server/kernel/tx";

// The company's logo from Settings, without signing in: its sign-in pages, browser-tab icon and emails use it.
// No logo (or not an image) is a plain 404, and the pages show Bike's B instead.
export async function GET(_req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const ws = await currentWorkspace((await params).ws);
  const logo = await withWorkspace({ workspaceId: ws.id, personId: null }, publicLogo);
  if (!logo) return new Response("Not found", { status: 404 });
  return new Response(logo.body as BodyInit, {
    headers: { "content-type": logo.mime, "x-content-type-options": "nosniff", "cache-control": "public, max-age=300" },
  });
}
