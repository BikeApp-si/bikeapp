import { mustBeAdmin } from "../admin";
import { record } from "../audit";
import { createCapability, newChangeSet } from "../capabilities";
import { saveCompanyRules } from "../company-rules";
import { KernelError, load, type KernelCtx, type Loaded } from "../context";
import { currentTime } from "../clock";
import type { CapabilityFile } from "../schema/file";
import type { CompanyRule } from "../schema/company";
import { renderCapabilityText, type TextSection } from "../render-text";
import { atomic, type Tx } from "../tx";
import { checkFilled } from "./check";
import { referencesIn, type AppSet, type Filled } from "./format";

// Adding an app set (G1). Nothing is live until an admin clicks: the preview says what would be added and every
// reason it can't be; Add makes it in one change set (source "gallery", with the set's name and version), each app
// with its capability.created entry, the set's company rules added to the company's, and one set.added entry. No AI.
// Names that clash with an app the company has are refused, never merged.

export type SetChoice = {
  apps: string[]; // the set's app keys picked
  slots: Record<string, string[]>; // slot key → the people filling it
};

export type SetPreview = {
  problems: string[];
  apps: { key: string; name: string }[];
  slots: { key: string; name: string; people: string[] }[]; // the slots the picked apps use, with who fills them
  // G2: with no problems, the plan as the admin reads it before Add: each app's text with the company's people
  // (the admin as "You") and what adding changes elsewhere.
  plan?: { key: string; sections: TextSection[] }[];
  alsoChanges?: string[];
};

const words = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

const nameOf = (set: AppSet, app: string) => (set.files[app] as { name: string }).name;

// The set as far as the picked apps go: their files, in the set's order, and the company rules whose apps were all
// picked.
function picked(set: AppSet, apps: string[]): AppSet {
  const keep = set.apps.filter((a) => apps.includes(a));
  const companyRules = set.companyRules.filter((r) => [...referencesIn(r).apps].every((a) => keep.includes(a)));
  return { ...set, apps: keep, files: Object.fromEntries(keep.map((a) => [a, set.files[a]])), companyRules };
}

function previewWith(loaded: Loaded, set: AppSet, choice: SetChoice): SetPreview & { sub: AppSet } {
  const problems: string[] = [];
  for (const a of choice.apps) if (!set.apps.includes(a)) problems.push(`“${a}” isn't an app of ${set.name}.`);
  const sub = picked(set, choice.apps);
  if (!sub.apps.length) problems.push("Pick at least one app to add.");

  // An app that links to, or hands work to, an app of the set that isn't picked can't come alone.
  for (const app of sub.apps)
    for (const needs of referencesIn(sub.files[app]).apps)
      if (!sub.apps.includes(needs)) problems.push(`${nameOf(set, app)} needs ${nameOf(set, needs)}, so add them together.`);

  const have = new Map([...loaded.files.values()].map((f) => [f.file.name.trim().toLowerCase(), f.file.name]));
  for (const app of sub.apps) {
    const clash = have.get(nameOf(set, app).trim().toLowerCase());
    if (clash) problems.push(`You already have an app called ${clash}.`);
  }

  const used = referencesIn([sub.files, sub.companyRules]);
  const slots = set.slots.filter((s) => used.slots.has(s.key));
  for (const s of slots) {
    const ids = choice.slots[s.key] ?? [];
    const unknown = ids.filter((id) => !loaded.people.has(id));
    if (unknown.length) problems.push(`${s.name}: someone picked isn't in People.`);
    else if (!ids.length) problems.push(`Pick who is ${s.name}.`);
    else if ((used.single.has(s.key) || s.one) && ids.length > 1) problems.push(`${s.name} is one person: pick one.`);
  }
  return {
    problems,
    sub,
    apps: sub.apps.map((a) => ({ key: a, name: nameOf(set, a) })),
    slots: slots.map((s) => ({ key: s.key, name: s.name, people: (choice.slots[s.key] ?? []).map((id) => loaded.people.get(id)?.name ?? "") })),
  };
}

const worldOf = (loaded: Loaded) => new Map<string, CapabilityFile>([...loaded.files].map(([id, f]) => [id, f.file]));

// What adding would do, checked by the kernel as Add will check it; nothing is saved.
export async function previewSet(tx: Tx, ctx: KernelCtx, set: AppSet, choice: SetChoice): Promise<SetPreview> {
  await mustBeAdmin(tx, ctx);
  const loaded = await load(tx);
  const { sub, ...out } = previewWith(loaded, set, choice);
  if (out.problems.length) return out;
  const filled: Filled = { apps: Object.fromEntries(sub.apps.map((a) => [a, crypto.randomUUID()])), slots: choice.slots };
  const world = worldOf(loaded);
  const checked = checkFilled(sub, filled, world, new Set(loaded.people.keys()));
  if (!checked.ok) return { ...out, problems: checked.problems };
  const files = new Map([...world, ...checked.files]);
  const company = [...(loaded.company?.rules ?? []), ...checked.companyRules];
  const plan = sub.apps.map((key) => {
    const capId = filled.apps[key]!;
    const ctxText = { capId, files, personName: (id: string) => loaded.people.get(id)?.name, viewerId: ctx.actor.id, company, formats: loaded.formats };
    return { key, sections: renderCapabilityText(checked.files.get(capId)!, ctxText) };
  });
  // Everyone filling a slot, in the slots' order, the admin as "you".
  const ids = [...new Set(out.slots.flatMap((s) => choice.slots[s.key] ?? []))];
  const named = ids.map((id) => (id === ctx.actor.id ? "you" : (loaded.people.get(id)?.name ?? ""))).filter(Boolean);
  const alsoChanges = [
    ...checked.companyRules.map((r) => `Ontology › Company rules: adds “${r.text}”`),
    ...(named.length ? [`People: ${words(named)} ${named.length > 1 || named[0] === "you" ? "get roles" : "gets a role"} in these apps.`] : []),
  ];
  return { ...out, plan, alsoChanges };
}

// A company rule's id the company already uses gets the first free one after it ("approvals_2").
function freeIds(have: CompanyRule[], adding: CompanyRule[]): CompanyRule[] {
  const used = new Set(have.map((r) => r.id));
  return adding.map((r) => {
    let id = r.id;
    for (let n = 2; used.has(id); n++) id = `${r.id.slice(0, 36)}_${n}`;
    used.add(id);
    return { ...r, id };
  });
}

export function addSet(tx: Tx, ctx: KernelCtx, set: AppSet, choice: SetChoice) {
  return atomic(tx, (tx) => adding(tx, ctx, set, choice));
}

async function adding(tx: Tx, ctx: KernelCtx, set: AppSet, choice: SetChoice) {
  await mustBeAdmin(tx, ctx);
  const at = ctx.now ?? currentTime();
  const loaded = await load(tx);
  const { sub, problems, slots } = previewWith(loaded, set, choice);
  if (problems.length) throw new KernelError(problems[0]!, problems);
  const filled: Filled = { apps: Object.fromEntries(sub.apps.map((a) => [a, crypto.randomUUID()])), slots: choice.slots };
  const world = worldOf(loaded);
  const checked = checkFilled(sub, filled, world, new Set(loaded.people.keys()));
  if (!checked.ok) throw new KernelError(checked.problems[0]!, checked.problems);

  const ids = sub.apps.map((a) => filled.apps[a]!);
  const opts = { source: "gallery" as const, set: { name: set.name, version: set.version }, at, others: new Map([...world, ...checked.files]) };
  const changeSetId = await newChangeSet(tx, ctx, opts, ids.map((id) => ({ capabilityId: id, fromVersion: 0, toVersion: 1 })));
  for (const id of ids) await createCapability(tx, ctx, checked.files.get(id), { ...opts, changeSetId, id });
  if (checked.companyRules.length) {
    const have = loaded.company?.rules ?? [];
    await saveCompanyRules(tx, ctx, [...have, ...freeIds(have, checked.companyRules)], { changeSetId, at, why: `added with ${set.name}` });
  }
  await record(tx, ctx, {
    who: ctx.actor.email,
    event: "set.added",
    details: {
      set: set.name,
      version: set.version,
      apps: sub.apps.map((a) => nameOf(set, a)),
      // As the Audit log reads it: "2 roles (Approver: Priya Nair, Team leads: Rita Gomez and Priya Nair)".
      roles: slots.map((s) => `${s.name}: ${s.people.join(" and ")}`),
      ...(checked.companyRules.length ? { companyRules: checked.companyRules.length } : {}),
    },
    changeSetId,
    at,
  });
  return { changeSetId, apps: sub.apps.map((a) => ({ key: a, id: filled.apps[a]!, name: nameOf(set, a) })) };
}

// Who might fill each slot, from People's job titles ("Principal" fills Principal), for the add flow to suggest.
export function suggestSlots(set: AppSet, people: { id: string; title: string | null }[]): Record<string, string[]> {
  const norm = (t: string) => t.trim().toLowerCase();
  return Object.fromEntries(
    set.slots.map((s) => {
      const titles = new Set(s.titles.map(norm));
      return [s.key, people.filter((p) => p.title && titles.has(norm(p.title))).map((p) => p.id)];
    }),
  );
}
