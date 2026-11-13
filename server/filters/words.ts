import { AiError, ask } from "@/server/ai/gateway";
import type { Who } from "@/server/ai/log";
import { filterWords } from "@/server/ai/prompts/filter-words@1";
import { filtersFrom, type filterWordsInput } from "@/server/kernel/filter-words";
import type { Filter } from "@/server/kernel/query";

// Filters in plain words (0.4, M21): the small model's answer, turned into the sheet's filters by the kernel. A name
// the kernel can't use goes back to the model once; after that, what could be used is kept and the rest is said in
// plain words. Nothing is saved. Runs outside the kernel's transactions.
export async function wordsToFilters(
  prep: Awaited<ReturnType<typeof filterWordsInput>>,
  who: Who,
): Promise<{ ok: true; filters: Filter[]; couldNot: string[] } | { ok: false; error: string }> {
  let made: ReturnType<typeof filtersFrom> | null = null;
  try {
    await ask(filterWords, prep.input, who, {
      building: false,
      check: (o) => {
        made = filtersFrom(prep.sheet, prep.people, o);
        // Only what the kernel added; what the model itself says it can't do is a fine answer.
        return made.couldNot.slice(o.could_not.length);
      },
    });
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    if (!made) return { ok: false, error: e.message };
  }
  const out = made as ReturnType<typeof filtersFrom> | null;
  if (!out) return { ok: false, error: "Bike couldn't turn that into filters. Try saying it differently." };
  return { ok: true, filters: out.filters, couldNot: out.couldNot };
}
