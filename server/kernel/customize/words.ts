// The kernel's problems with a Customize change, for the person who asked (C1). The AI gets them as the kernel
// writes them, with where each one is; the admin reads a sentence: no "Role X › Sheet:" prefixes, no "Later"
// (a word only the AI knows), and the limits said as limits of this version.

type Rewrite = [RegExp, (...m: string[]) => string];

const REWRITES: Rewrite[] = [
  [/^Role (.+?) › (.+?): needs a person column that says whose each row is\.$/, (role, sheet) => `${role} see only their own rows, and nothing in ${sheet} says whose a row is. Say who should see ${sheet}, or add a person column such as Owner.`],
  [/^Role (.+?) › (.+?): .+ isn't a (?:person|link) column on (?:this sheet|the row .+ points to)\..*$/, (role, sheet) => `${role} can't see ${sheet} that way: whose a row is must come from a person on it, or one link away.`],
  [/^Role (.+?): decides whose rows are on a sheet it doesn't cover\.$/, (role) => `${role} would decide whose rows are on a sheet they don't see.`],
  [/^Role (.+?): names someone who isn't in People\.$/, (role) => `${role} would name someone who isn't in People.`],
  [/^(.+?): at most (\d+) sheets; put the rest under Later\.$/, (cap, n) => `${cap} can have at most ${n} sheets in this version, and this would make more.`],
  [/^(.+?): at most (\d+) rules; put the rest under Later\.$/, (cap, n) => `${cap} can have at most ${n} rules in this version, and this would make more.`],
  [/^(.+?) sheet: at most (\d+) columns\.$/, (sheet, n) => `${sheet} can have at most ${n} columns in this version, and this would make more.`],
  [/^(.+?) sheet: at most (\d+) steps before the end\.$/, (sheet, n) => `${sheet} can have at most ${n} steps before the end in this version.`],
];

export function plainProblem(p: string): string {
  for (const [re, say] of REWRITES) {
    const m = p.match(re);
    if (m) return say(...m.slice(1));
  }
  // Any other role problem: who it's about, then what's wrong.
  const role = p.match(/^Role (.+?)(?: › (.+?))?: (.+)$/);
  if (role) return `${role[1]}${role[2] ? ` (${role[2]})` : ""}: ${role[3]}`;
  // "Equipment › Plan: links to …": the column in its sheet, then what's wrong.
  const at = p.match(/^([^›:]+?) › ([^›:]+?): ([a-z].+)$/);
  if (at) return `${at[2]} in ${at[1]} ${at[3]}`;
  return p.replace(/;? ?put the rest under Later\.?/, ".").replace(/\.\.$/, ".");
}

// The reply when a change can't be made: the first problem, plainly; the rest are usually the same cause.
export function refusal(problems: readonly string[]): string {
  return `I can't apply that. ${plainProblem(problems[0] ?? "")}`.trim();
}
