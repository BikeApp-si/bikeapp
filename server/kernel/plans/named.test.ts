import { describe, expect, it } from "vitest";
import type { DraftRole } from "./draft";
import { unnamedInRoles } from "./named";

// Access goes only to people the admin named; relationships (owner, manager, team) need no name.

const people = [
  { name: "Wade Wilson", email: "wade@fernwood.dev" },
  { name: "Krishna", email: "krishna@fernwood.dev" },
  { name: "Rita Gomez", email: "rita@fernwood.dev" },
  { name: "Lena Ortiz", email: "lena@fernwood.dev" },
];
const role = (name: string, more: Partial<DraftRole> = {}): DraftRole => ({
  name, people: [], person_column: null, everyone: false, can: ["see"], scope: "all", scope_columns: [], sheets: null, ...more,
});
const check = (roles: DraftRole[], texts: string[]) =>
  unnamedInRoles(roles.map((r) => ({ capability: "Customer contracts", role: r })), [], { adminEmail: "wade@fernwood.dev", texts, people });

const MESSAGE = "We need to keep track of customer contracts and get reminded well before they renew. Krishna and I look after all of them.";

describe("people a role names", () => {
  it("refuses Rita when nobody named her, and accepts the admin and Krishna, who were named", () => {
    expect(check([role("Contract managers", { people: ["wade@fernwood.dev", "krishna@fernwood.dev", "rita@fernwood.dev"] })], [MESSAGE])).toEqual([
      "Customer contracts, role “Contract managers”: Rita Gomez isn't named in the request or its documents. Give access only to people named there, or to a person column, a manager or a team.",
    ]);
    expect(check([role("Contract managers", { people: ["wade@fernwood.dev", "krishna@fernwood.dev"] })], [MESSAGE])).toEqual([]);
  });

  it("accepts roles that work through a relationship without naming anyone (owners, managers approve, a team)", () => {
    const owners = role("Contract owners", { person_column: { sheet: "Contracts", column: "Owner" }, scope: "own", scope_columns: [{ sheet: "Contracts", column: "Owner", via: null }] });
    const managers = role("Managers", { everyone: true, scope: "team", can: ["see", "move_steps"] });
    expect(check([owners, managers], ["Requests go to the person's manager, and managers approve them."])).toEqual([]);
  });

  it("takes a name from a document or an earlier message, by full name, first name or email", () => {
    const lena = [role("Legal reviewer", { people: ["lena@fernwood.dev"] })];
    expect(check(lena, [MESSAGE])).toHaveLength(1);
    expect(check(lena, [MESSAGE, "[Page 2]\nLena Ortiz does the legal review."])).toEqual([]);
    expect(check(lena, ["Ask lena@fernwood.dev"])).toEqual([]);
    // A first name inside another word doesn't count.
    expect(check(lena, ["Our Lenaway supplier"])).toHaveLength(1);
  });

  it("checks a person an Also change adds to a role", () => {
    const add = { capability: "Spend", sheet: null, change: "Add Rita to Finance", reason: "r", kind: "add" as const, edits: [{ kind: "add_role_member" as const, sheet: null, column: null, step: null, after: null, role: "Finance", person: "rita@fernwood.dev", link: null }] };
    expect(unnamedInRoles([], [add], { adminEmail: "wade@fernwood.dev", texts: [MESSAGE], people })).toEqual([
      "Spend, role “Finance”: Rita Gomez isn't named in the request or its documents. Give access only to people named there, or to a person column, a manager or a team.",
    ]);
  });
});
