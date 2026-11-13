import { checkSet, placeholders } from "@/server/kernel/gallery/check";
import { referencesIn, type AppSet } from "@/server/kernel/gallery/format";
import { renderCapabilityText, type TextSection } from "@/server/kernel/render-text";
import type { Formats } from "@/lib/format";
import { nextCapColor } from "@/lib/cap-colors";

// A set's apps as plain text (G2), from the same templates Customize and a plan use, so the gallery's page reads
// exactly as what gets added. Before a company fills the slots, a slot's person reads as the slot ("Approver").
// Fixed files, no AI: the same set always gives the same text.

// color: a colour name, in the order a company with no apps would get them (a company with apps continues its own).
export type SetAppText = { key: string; name: string; icon: string; color: string; description: string; sections: TextSection[] };

// after: the colour of the company's last app, so the add page shows each app in the colour it will get.
export function setText(set: AppSet, formats?: Formats, after?: string | null): SetAppText[] {
  const checked = checkSet(set);
  if (!checked.ok) throw new Error(`${set.name} doesn't pass its check: ${checked.problems[0]}`);
  const filled = placeholders(set);
  const slotOf = new Map(set.slots.map((s) => [filled.slots[s.key]![0]!, s.name]));
  // A slot only ever used in a list of people (a role's members, who is told) is a group; one used anywhere for a
  // single person (who is asked), or marked as one, is one person.
  const single = referencesIn([set.files, set.companyRules]).single;
  const groups = new Set(set.slots.filter((s) => !single.has(s.key) && !s.one).map((s) => filled.slots[s.key]![0]!));
  let color: string | null | undefined = after;
  return set.apps.map((key) => {
    const capId = filled.apps[key]!;
    const file = checked.files.get(capId)!;
    const sections = renderCapabilityText(file, {
      capId,
      files: checked.files,
      personName: (id) => slotOf.get(id),
      viewerId: null,
      company: checked.companyRules,
      formats,
      group: (id) => groups.has(id),
    });
    color = nextCapColor(color);
    return { key, name: file.name, icon: file.icon, color, description: file.description ?? "", sections };
  });
}
