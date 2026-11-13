import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// O4: from 0.6 on, a database update only adds, so going back to the Bike before it (update.sh <older version>)
// still runs on the updated database. A statement the older Bike would trip on fails here: dropping or renaming,
// changing a column's type, making a column required, or a required column with no default (the older Bike's
// inserts leave it out). A statement reviewed as safe carries `-- safe to roll back: <why>` on the line before.

const FIRST = 49; // 0049_release_check: the first update after the open Bike's first release
const DIR = path.join(process.cwd(), "db/migrations");

const RULES: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE|VIEW|FUNCTION|INDEX|POLICY|TRIGGER)\b/i, "drops something"],
  [/\bRENAME\b/i, "renames something"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "changes a column's type"],
  [/\bSET\s+NOT\s+NULL\b/i, "makes a column required"],
  [/\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i, "adds a required column with no default"],
  [/\bTRUNCATE\b|\bDELETE\s+FROM\b/i, "removes rows"],
];

export function rollbackProblems(sql: string): string[] {
  const problems: string[] = [];
  for (const raw of sql.split(/-->\s*statement-breakpoint|;\s*\n/)) {
    const lines = raw.split("\n");
    const reviewed = lines.some((l) => /^\s*--\s*safe to roll back:\s*\S/i.test(l));
    const statement = lines.filter((l) => !/^\s*--/.test(l)).join("\n");
    if (reviewed) continue;
    for (const [rule, says] of RULES) if (rule.test(statement)) problems.push(`${says}: ${statement.trim().split("\n")[0]}`);
  }
  return problems;
}

describe("database updates only add", () => {
  it("from 0.6 on", () => {
    const journal = JSON.parse(readFileSync(path.join(DIR, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const later = journal.entries.filter((e) => e.idx >= FIRST);
    expect(later.length).toBeGreaterThan(0);
    for (const e of later) expect(rollbackProblems(readFileSync(path.join(DIR, `${e.tag}.sql`), "utf8")), e.tag).toEqual([]);
  });

  it("catches what an older Bike would trip on", () => {
    expect(rollbackProblems('ALTER TABLE "a" ADD COLUMN "b" text;')).toEqual([]);
    expect(rollbackProblems('ALTER TABLE "a" ADD COLUMN "b" text DEFAULT \'x\' NOT NULL;')).toEqual([]);
    expect(rollbackProblems('CREATE TABLE "c" ("id" uuid PRIMARY KEY NOT NULL);')).toEqual([]);
    expect(rollbackProblems('ALTER TABLE "a" ADD COLUMN "b" text NOT NULL;')).toHaveLength(1);
    expect(rollbackProblems('ALTER TABLE "a" DROP COLUMN "b";')).toHaveLength(1);
    expect(rollbackProblems('DROP TABLE "a";')).toHaveLength(1);
    expect(rollbackProblems('ALTER TABLE "a" RENAME COLUMN "b" TO "c";')).toHaveLength(1);
    expect(rollbackProblems('ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE integer;')).toHaveLength(1);
    expect(rollbackProblems('ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;')).toHaveLength(1);
    expect(rollbackProblems('DELETE FROM "a";')).toHaveLength(1);
    expect(rollbackProblems('-- safe to roll back: the old index was never read\nDROP INDEX "a_idx";')).toEqual([]);
    expect(rollbackProblems('-- a note\nALTER TABLE "a" ADD COLUMN "b" text;')).toEqual([]);
  });
});
