import { cache } from "react";
import { workspaceLogo } from "@/server/kernel/settings";
import { withWorkspace } from "@/server/kernel/tx";
import type { Workspace } from "@/server/kernel/workspaces";

// The company's logo on its own address (sign-in pages, browser tab), or null for Bike's B. The upload id in
// the address makes a new logo a new image.
export const companyLogo = cache(async (ws: Workspace): Promise<string | null> => {
  const id = await withWorkspace({ workspaceId: ws.id, personId: null }, workspaceLogo);
  return id ? `/logo?v=${id}` : null;
});
