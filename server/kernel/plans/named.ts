import type { DraftAlsoChange, DraftRole } from "./draft";
import { norm } from "./names";

// Access goes only to people the admin named. A role may list a person directly only when the request, the
// conversation or a document names them (by full name, a first name, or work email), or when they are the admin
// asking. Roles that work through a relationship (a person column such as Owner, a manager, a team) name no
// one and need nothing here. Someone's title is never a reason to give them access.

type Person = { name: string; email: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}@.])${escape(word)}($|[^\\p{L}\\p{N}])`, "iu").test(text);

function named(p: Person, text: string): boolean {
  const first = p.name.split(" ")[0]!;
  return mentions(text, p.email) || mentions(text, p.name) || mentions(text, first);
}

// Plain-words problems for each person a role lists who wasn't named.
export function unnamedInRoles(
  roles: { capability: string; role: DraftRole }[],
  extra: DraftAlsoChange[],
  ctx: { adminEmail: string; texts: string[]; people: Person[] },
): string[] {
  const text = ctx.texts.join("\n");
  const byEmail = new Map(ctx.people.map((p) => [norm(p.email), p]));
  const check = (where: string, email: string): string[] => {
    if (norm(email) === norm(ctx.adminEmail)) return [];
    const p = byEmail.get(norm(email));
    if (!p) return []; // not in People: the compiler names that problem
    return named(p, text) ? [] : [`${where}: ${p.name} isn't named in the request or its documents. Give access only to people named there, or to a person column, a manager or a team.`];
  };
  return [
    ...roles.flatMap(({ capability, role }) => role.people.flatMap((e) => check(`${capability}, role “${role.name}”`, e))),
    ...extra.flatMap((c) => c.edits.flatMap((e) => (e.kind === "add_role_member" && e.person ? check(`${c.capability}, role “${e.role ?? ""}”`, e.person) : []))),
  ];
}
