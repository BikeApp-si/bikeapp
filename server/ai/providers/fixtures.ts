import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

// Recorded real answers, for tests (AI_PROVIDER=fixtures). Each is keyed by everything the model was sent,
// so a changed prompt, context or message needs a new recording. AI_PROVIDER=record calls the real provider
// once and saves what it answered; it never calls it again for a request already recorded.

const DIR = path.join(process.cwd(), "server/ai/fixtures");

export function keyOf(req: ProviderRequest): string {
  // Images by their hash, so the key stays short and the same image gives the same key.
  const images = req.images?.map((i) => createHash("sha256").update(i.data).digest("hex"));
  const sent = { model: req.model, effort: req.effort, system: req.system, context: req.context, message: req.message, retry: req.retry ?? null, schema: req.jsonSchema, structured: req.structured, ...(req.answerTool ? { answerTool: true } : {}), ...(images?.length ? { images } : {}) };
  return createHash("sha256").update(JSON.stringify(sent)).digest("hex").slice(0, 16);
}

const fileOf = (req: ProviderRequest) => path.join(DIR, req.prompt, `${keyOf(req)}.json`);

type Recorded = { message: string; retry: ProviderRequest["retry"] | null; response: ProviderResponse };

export class MissingFixture extends Error {}

// Every recording read or written in this process, so a recording run can remove the ones nothing used.
export const usedFixtures = new Set<string>();

export function fixturesProvider(record?: Provider): Provider {
  return {
    async call(req) {
      const file = fileOf(req);
      usedFixtures.add(file);
      // A Playwright recording run keeps the list of what its flows used, so scripts/ai-record.ts keeps them too.
      if (process.env.FIXTURES_LOG) await appendFile(process.env.FIXTURES_LOG, `${path.relative(process.cwd(), file)}\n`);
      const saved = await readFile(file, "utf8").catch(() => null);
      if (saved) return (JSON.parse(saved) as Recorded).response;
      if (!record) {
        // Keep what was sent, so a recording missed now and then can be compared with the one that exists
        // (tmp/missing-fixtures/<prompt>/<key>.json; Nov 5, the build's Ontology request seen to vary).
        const kept = path.join(process.cwd(), "tmp/missing-fixtures", req.prompt, `${keyOf(req)}.json`);
        await mkdir(path.dirname(kept), { recursive: true }).catch(() => undefined);
        await writeFile(kept, JSON.stringify({ system: req.system, context: req.context, message: req.message, retry: req.retry ?? null }, null, 1)).catch(() => undefined);
        throw new MissingFixture(`No recorded answer for ${req.prompt} (${path.relative(process.cwd(), file)}). Record it with AI_PROVIDER=record.\nMessage: ${req.message.slice(0, 200)}`);
      }
      const response = await record.call(req);
      // An answer cut off or refused isn't kept: replayed, it would fail the same way every time (M28, a C1 answer
      // that ran into its limit). The next recording run asks again.
      if (response.stop !== "done") return response;
      await mkdir(path.dirname(file), { recursive: true });
      const out: Recorded = { message: req.message, retry: req.retry ?? null, response };
      await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
      return response;
    },
  };
}
