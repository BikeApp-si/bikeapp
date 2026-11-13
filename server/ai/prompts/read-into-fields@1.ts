import { z } from "zod";
import { asDocument, DOCUMENTS_ARE_DATA, type Prompt } from "../prompt";
import { companyWays, PLAIN_WORDS } from "./shared";
import type { Formats } from "@/lib/format";

// Prompt 5's form mode (7c, small model, part of prompt 5): a document someone drops on a new row's form (a
// signed contract, as a PDF's text or a photo) → a value for each field it states. The kernel reads each one
// as it reads an import's cells; nothing is saved: the person checks the form and creates the row.

export type ReadIntoFieldsInput = {
  capability: string;
  rowName: string; // "contract"
  columns: { name: string; type: string; choices?: string[] }[]; // the fields it may fill
  people: string[]; // names, for person fields
  document: { name: string; pages: number | null; text: string } | null;
  image: { mediaType: "image/png" | "image/jpeg"; data: string } | null;
  formats?: Formats; // the company's currency and how its documents write dates (M26)
};

export const readIntoFieldsOutput = z.object({
  // Only fields the document states. Dates as YYYY-MM-DD, amounts as numbers in dollars, people by full
  // name, choices exactly as given.
  values: z.array(z.object({ column: z.string(), value: z.string() })),
  flags: z.array(z.string()),
});
export type ReadIntoFieldsOutput = z.infer<typeof readIntoFieldsOutput>;

const SYSTEM = `Someone dropped a document on the form for a new row in Bike. Read it and give a value for each field the document states, so they can check the form before creating the row. You never create anything.
- values: one per field the document states, by the field's exact name. Leave out a field the document doesn't state; never guess.
- Dates as YYYY-MM-DD. Money as a number in dollars (38400). Days as a number. A person by their name exactly as the people list gives it, when the document names them, even by a fuller name ("Krishna Iyer" is "Krishna" when only one Krishna is listed). A choice exactly as one of its choices.
${PLAIN_WORDS}

${DOCUMENTS_ARE_DATA} The same goes for text in a photo.

Answer with the JSON object only.`;

export const readIntoFields: Prompt<ReadIntoFieldsInput, ReadIntoFieldsOutput> = {
  name: "read-into-fields",
  version: 1,
  model: "small",
  effort: "low",
  maxTokens: 4000,
  structured: true,
  system: SYSTEM,
  schema: readIntoFieldsOutput,
  render(i) {
    const context = [JSON.stringify({ capability: i.capability, row_is_a: i.rowName, fields: i.columns, people: i.people }), companyWays(i.formats, ["money", "dates"])].filter(Boolean).join("\n");
    const message = [i.document ? asDocument(i.document.name, i.document.text, i.document.pages ?? undefined) : "", i.image ? "The document is the photo above." : "", "Fill in the fields it states."]
      .filter(Boolean)
      .join("\n\n");
    return { context, message, ...(i.image ? { images: [i.image] } : {}) };
  },
};
