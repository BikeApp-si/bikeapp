import { asPage } from "@/server/auth/kernel-call";
import { download, orNotFound } from "@/server/auth/download";
import { readCoherence } from "@/server/kernel/coherence";
import { ontologyInput, ontologyText, ontologyView, pastInput, readOntology, readOntologyVersion } from "@/server/kernel/ontology";

// Download on 4e: the page as a text file, admins only (checked in the kernel). ?version=N downloads a kept
// version (M34) as its page reads.
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const asked = new URL(req.url).searchParams.get("version");
  return orNotFound(async () => {
    const out = await asPage(ws, async (tx, ctx) => {
      const input = await ontologyInput(tx, ctx);
      if (asked === null) return { name: "ontology.txt", text: ontologyText(ontologyView(input, await readOntology(tx), (await readCoherence(tx))?.items)) };
      const kept = await readOntologyVersion(tx, ctx, Number(asked));
      if (!kept) return null;
      return { name: `ontology-version-${kept.version}.txt`, text: ontologyText(ontologyView({ ...input, ...(await pastInput(tx, ctx, kept.read)) }, kept, [])) };
    });
    if (!out) return new Response("Not found", { status: 404 });
    return download({ name: out.name, mime: "text/plain; charset=utf-8", body: new TextEncoder().encode(out.text) });
  });
}
