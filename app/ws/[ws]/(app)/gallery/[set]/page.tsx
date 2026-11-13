import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LayoutGrid } from "lucide-react";
import { CapIconBox } from "@/components/cap-icon";
import { AddSet } from "@/components/gallery/add-set";
import { TopBar } from "@/components/shell/top-bar";
import { capColor } from "@/lib/cap-colors";
import { asPage } from "@/server/auth/kernel-call";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { listedSet } from "@/server/gallery/list";
import { addPage } from "@/server/gallery/page";

// G2 (g2-d to g2-h), admins only: adding one app set. A set that isn't listed is a 404, as for anyone else.
export default async function GallerySetPage({ params }: { params: Promise<{ ws: string; set: string }> }) {
  await connection();
  const { ws: wsParam, set: key } = await params;
  await requireAdmin(await currentWorkspace(wsParam));
  const set = listedSet(key);
  if (!set) notFound();
  const page = await asPage(wsParam, (tx, ctx) => addPage(tx, ctx, set));
  const icons = Object.fromEntries(page.apps.map((a) => [a.key, <CapIconBox key={a.key} name={a.icon} color={capColor(a.color)} />]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title={set.name} parent={{ label: "App sets", href: "/gallery" }} icon={<LayoutGrid size={16} strokeWidth={1.8} />} />
      <div className="min-h-0 flex-1 overflow-auto">
        <AddSet setKey={set.key} name={set.name} description={set.description} beta={set.beta} page={page} icons={icons} />
      </div>
    </div>
  );
}
