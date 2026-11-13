import type { MovePlan } from "@/server/kernel/customize/move";

// A data move (M27) as the reply shows it, in words the kernel's counts fill in (m27-a, m27-b, m27-c): what moves,
// a few rows as examples, and every row that can't be mapped. Stored with the preview, so it is small: a few
// examples, and at most 50 rows that can't be mapped, with a count of the rest.

export type MoveView = {
  ok: boolean; // false: some row can't be mapped, so nothing can be applied
  lead: string; // the callout, with its first sentence in bold
  head: string[];
  rows: string[][];
  more: string | null; // the muted last row: "and 9 more, one customer each"
  after: string | null; // what to do next, when it can't be applied
  button: string | null; // "Apply and link 12 contracts"
};

const SHOWN = 3;
const AT_MOST = 50;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function moveView(p: MovePlan): MoveView {
  if (p.cantMap.length) {
    const missing = [...new Set(p.cantMap.filter((c) => c.why.startsWith("No ") && c.value).map((c) => c.value))];
    const linked = p.linked.length;
    const shown = p.cantMap.slice(0, AT_MOST);
    return {
      ok: false,
      lead: `**${n(p.cantMap.length, `${p.rowOne} can’t be linked`, `${p.rowMany} can’t be linked`)}, so nothing can move yet.** Bike never guesses a ${p.targetOne}: every ${p.rowOne} must match exactly one by name.`,
      head: [cap(p.rowOne), "Typed", "Why"],
      rows: shown.map((c) => [c.row, c.value || "—", c.why]),
      more: p.cantMap.length > AT_MOST ? `and ${p.cantMap.length - AT_MOST} more` : null,
      after: [
        missing.length
          ? `Add ${list(missing.slice(0, 3))}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} to ${p.target}, or change the name on ${p.cantMap.length === 1 ? `that ${p.rowOne}` : `those ${p.rowMany}`}, then send your message again.`
          : `Fill in or change ${p.cantMap.length === 1 ? `that ${p.rowOne}` : `those ${p.rowMany}`}, then send your message again.`,
        linked ? `The other ${n(linked, p.rowOne, p.rowMany)} ${linked === 1 ? "matches" : "match"}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      button: null,
    };
  }

  const empty = p.empty ? ` ${n(p.empty, `${p.rowOne} has`, `${p.rowMany} have`)} no ${p.targetOne} typed and ${p.empty === 1 ? "stays" : "stay"} empty.` : "";
  if (p.created.length) {
    // The target is new (5l): one row per name, then each row linked.
    const per = new Map<string, number>();
    for (const l of p.linked) per.set(l.toName.toLowerCase(), (per.get(l.toName.toLowerCase()) ?? 0) + 1);
    return {
      ok: true,
      lead: `**This moves data.** ${p.target} starts with one row for each ${p.targetOne} typed on your ${n(p.rows, p.rowOne, p.rowMany)}, ${p.created.length} in all, and each ${p.rowOne} is linked to its ${p.targetOne}. What was typed stays on each ${p.rowOne} as ${p.kept}, read only.${empty}`,
      head: [`New ${p.targetOne}`, cap(p.rowMany)],
      rows: p.created.slice(0, SHOWN).map((name) => [name, String(per.get(name.toLowerCase()) ?? 0)]),
      more: p.created.length > SHOWN ? `and ${p.created.length - SHOWN} more` : null,
      after: null,
      button: null,
    };
  }
  const linked = p.linked.length;
  const targets = new Set(p.linked.map((l) => l.to)).size;
  return {
    ok: true,
    lead: `**This moves data.** ${linked === p.rows ? `All ${n(p.rows, p.rowOne, p.rowMany)} match` : `${n(linked, p.rowOne, p.rowMany)} ${linked === 1 ? "matches" : "match"}`} one ${p.targetOne} each by name: ${n(linked, p.rowOne, p.rowMany)} will be linked, and nothing is left out.${empty}`,
    head: [`Typed on the ${p.rowOne}`, "Links to"],
    rows: p.linked.slice(0, SHOWN).map((l) => [l.value, l.toName]),
    more: linked > SHOWN ? `and ${linked - SHOWN} more${targets === linked ? `, one ${p.targetOne} each` : ""}` : null,
    after: null,
    button: `Apply and link ${n(linked, p.rowOne, p.rowMany)}`,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
