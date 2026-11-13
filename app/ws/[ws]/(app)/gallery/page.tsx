import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { LayoutGrid } from "lucide-react";
import { CapIconBox } from "@/components/cap-icon";
import { BetaTag } from "@/components/chips";
import { TopBar } from "@/components/shell/top-bar";
import { capColor } from "@/lib/cap-colors";
import { currentWorkspace, requireAdmin } from "@/server/auth/current";
import { listedSets } from "@/server/gallery/list";
import { setText } from "@/server/gallery/text";

// G2 (g2-c2), admins only: the app sets in the gallery. With none listed there's no gallery (a 404).
export default async function GalleryPage({ params }: { params: Promise<{ ws: string }> }) {
  await connection();
  await requireAdmin(await currentWorkspace((await params).ws));
  const sets = listedSets();
  if (!sets.length) notFound();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="App sets" icon={<LayoutGrid size={16} strokeWidth={1.8} />} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 pt-10 pb-10">
          <h2 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">Start from an app set</h2>
          <p className="mt-1.5 mb-0 text-[15.5px] leading-[1.55] text-muted">
            Ready-made apps for one kind of company. Pick the ones you want and say who does what; change anything later in Customize.
          </p>
          <div className="mt-6 border-t border-line">
            {sets.map((s) => {
              const apps = setText(s);
              return (
                <Link key={s.key} href={`/gallery/${s.key}`} className="flex items-center gap-4 border-b border-line py-4.5 hover:bg-hover">
                  <span className="flex gap-1">
                    {apps.map((a) => (
                      <CapIconBox key={a.key} name={a.icon} color={capColor(a.color)} />
                    ))}
                  </span>
                  <span className="flex-1">
                    <span className="flex items-center gap-2 text-[16.5px] font-semibold">
                      {s.name}
                      {s.beta ? <BetaTag /> : null}
                    </span>
                    <span className="block text-[15px] text-muted">
                      {apps.map((a) => a.name).join(", ")} · {apps.length === 1 ? "1 app" : `${apps.length} apps`}
                    </span>
                  </span>
                  <span className="inline-flex h-9 items-center rounded-[6px] border border-line bg-white px-3.5 text-[15px] font-medium">Choose</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
