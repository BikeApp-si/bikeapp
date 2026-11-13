import { AiError, ask } from "@/server/ai/gateway";
import { customizeGuide, type GuideOutput } from "@/server/ai/prompts/customize-guide@2";
import type { Who } from "@/server/ai/log";
import type { AccessSummary } from "@/server/kernel/access-summary";
import type { Part } from "@/server/kernel/chats";
import type { TextSection } from "@/server/kernel/render-text";

// A guide answer in the Customize chat (C2): the guide (prompt 10) explains, and the kernel keeps only the suggested
// requests that would apply. It changes nothing: no plan, no Audit entry, no Apply. The reply is marked as explaining
// (a "guide" part), points at the part of the text it's about, and ends with the requests as buttons that go to the
// change planner.

export type GuideAsk = {
  sections: TextSection[]; // the capability's text, as the right side shows it
  capability: Record<string, unknown>;
  access: AccessSummary;
  conversation: { from: "person" | "bike"; text: string }[];
  message: string;
  refusal?: string;
};

// The kernel's problems with a suggestion's changes; none when it would apply.
export type CheckChanges = (changes: GuideOutput["suggestions"][number]["changes"]) => Promise<string[]>;

// Numbered steps each on their own line, as the chat shows paragraphs.
const paragraphs = (s: string) => s.trim().replace(/\n(?=\d+\. )/g, "\n\n");

export async function guideAnswer(g: GuideAsk, who: Who, checkChanges: CheckChanges): Promise<{ text: string; parts: Part[] }> {
  const text = g.sections.map((s) => [s.heading, ...s.lines].join("\n")).join("\n\n");
  // A suggestion the kernel wouldn't apply goes back for the one retry, as prompt 3's changes do. If the retry
  // still has one, the answer stands with only the suggestions that apply.
  let last: GuideOutput | null = null;
  const check = async (o: GuideOutput) => {
    last = o;
    const problems: string[] = [];
    for (const x of o.suggestions) for (const p of await checkChanges(x.changes)) problems.push(`The suggestion “${x.label}” wouldn't apply: ${p}`);
    return problems;
  };
  const input = { text, capability: g.capability, access: g.access, conversation: g.conversation, message: g.message, ...(g.refusal ? { refusal: g.refusal } : {}) };
  try {
    return await guideReply(await ask(customizeGuide, input, who, { building: false, check }), g, checkChanges);
  } catch (e) {
    if (e instanceof AiError && last) return guideReply(last, g, checkChanges);
    throw e;
  }
}

// The answer as a chat reply: only suggestions the kernel would apply become buttons, and only a heading that's
// really in the text is pointed at.
export async function guideReply(out: GuideOutput, g: Pick<GuideAsk, "sections" | "refusal">, checkChanges: CheckChanges): Promise<{ text: string; parts: Part[] }> {
  const kept: string[] = [];
  for (const s of out.suggestions) if (!(await checkChanges(s.changes)).length) kept.push(s.label.trim());
  const section = out.section && g.sections.some((s) => s.heading === out.section) ? out.section : null;
  return {
    text: paragraphs(out.answer),
    parts: [
      { kind: "guide", section, ...(g.refusal ? { refusal: true } : {}) },
      ...(out.table ? [{ kind: "table" as const, columns: out.table.columns, rows: out.table.rows }] : []),
      ...(kept.length ? [{ kind: "buttons" as const, buttons: kept.map((label) => ({ action: "plan", label })) }] : []),
    ],
  };
}
