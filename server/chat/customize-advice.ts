import { AiError, ask } from "@/server/ai/gateway";
import { customizeAdvisor, type AdvisorInput, type AdvisorOutput } from "@/server/ai/prompts/customize-advisor@2";
import type { Who } from "@/server/ai/log";
import type { Part } from "@/server/kernel/chats";
import type { CheckChanges } from "./customize-guide";

// Advice in the Customize chat (C3): the advisor (prompt 11) recommends what to add first, what later and what to look
// at on top. It changes nothing. The kernel keeps it honest: an item placed in this capability becomes a button only
// when its changes would apply, and never more new sheets than the capability has room for; an item that is its own
// capability or a report links to Home with its request filled in.

type Item = AdvisorOutput["groups"][number]["items"][number];
const sheetsAdded = (i: Item) => i.changes.filter((c) => c.kind === "add_sheet").length;

// What's wrong with an answer, for the one retry: items that wouldn't apply, too many new sheets, missing requests.
async function problemsOf(o: AdvisorOutput, room: number, check: CheckChanges): Promise<string[]> {
  const out: string[] = [];
  let sheets = 0;
  for (const i of o.groups.flatMap((g) => g.items)) {
    if (i.place === "here") {
      if (!i.request || !i.changes.length) out.push(`“${i.title}” is placed here, so it needs its request and its changes.`);
      sheets += sheetsAdded(i);
      if (sheetsAdded(i) && sheets > room) out.push(`“${i.title}” adds a sheet, but there's room for only ${room} more here: place it as its own app.`);
      for (const p of await check(i.changes)) out.push(`“${i.title}” wouldn't apply: ${p}`);
    } else {
      if ((i.place === "capability" || i.place === "report") && !i.request) out.push(`“${i.title}” needs the request to ask in Home.`);
      if (i.changes.length) out.push(`“${i.title}” isn't placed here, so it has no changes.`);
    }
  }
  return out;
}

export async function adviceAnswer(input: AdvisorInput, who: Who, check: CheckChanges): Promise<{ text: string; parts: Part[] }> {
  let last: AdvisorOutput | null = null;
  try {
    return await adviceReply(
      await ask(customizeAdvisor, input, who, {
        building: false,
        check: (o) => {
          last = o;
          return problemsOf(o, input.room, check);
        },
      }),
      input.room,
      check,
    );
  } catch (e) {
    // After the retry: the advice stands, with only the items that would apply as buttons.
    if (e instanceof AiError && last) return adviceReply(last, input.room, check);
    throw e;
  }
}

export async function adviceReply(o: AdvisorOutput, room: number, check: CheckChanges): Promise<{ text: string; parts: Part[] }> {
  const buttons: string[] = [];
  const links: Part[] = [];
  let sheets = 0;
  for (const i of o.groups.flatMap((g) => g.items)) {
    if (i.place === "here" && i.request && i.changes.length) {
      const adds = sheetsAdded(i);
      if (adds && sheets + adds > room) continue;
      if ((await check(i.changes)).length) continue;
      sheets += adds;
      buttons.push(i.request.trim());
    } else if ((i.place === "capability" || i.place === "report") && i.request) {
      links.push({ kind: "link", label: i.place === "capability" ? `Build ${i.title} in Home` : `Ask for ${i.title} in Home`, href: `/home?ask=${encodeURIComponent(i.request.trim())}`, outline: true });
    }
  }
  return {
    text: o.intro.trim(),
    parts: [
      {
        kind: "advice",
        groups: o.groups.map((g) => ({ title: g.title.trim(), items: g.items.map((i) => ({ title: i.title.trim(), why: i.why.trim(), fields: i.fields.map((f) => f.trim()), place: i.place })) })),
        start: o.start.trim(),
      },
      ...(buttons.length ? [{ kind: "buttons" as const, buttons: buttons.map((label) => ({ action: "plan", label })) }] : []),
      ...links,
    ],
  };
}
