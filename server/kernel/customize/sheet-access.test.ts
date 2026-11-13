import { describe, expect, it } from "vitest";
import { PEOPLE, salesLeadsFile } from "../fixtures";
import type { CapabilityFile, Column, Sheet } from "../schema/file";
import { validateFile } from "../schema/validate";
import { applyChanges, ChangeError, type Change } from "./changes";
import { compileCustomize, ruleChanges, tryEdits } from "./compile";
import { accessLines, defaultAccess } from "./sheet-access";

// C1: who sees a sheet a Customize change adds, and the change that says who sees a sheet. Pure: no database.

const people = new Set(Object.values(PEOPLE));
const valid = (f: CapabilityFile) => {
  const r = validateFile(f, { people });
  expect(r.ok ? [] : r.errors).toEqual([]);
};
const role = (f: CapabilityFile, id: string) => f.roles.find((r) => r.id === id)!;

function companies(extra: Column[] = []): Sheet {
  return {
    id: "companies",
    name: "Companies",
    kind: "list",
    row: { one: "company", many: "companies" },
    titleColumn: "name",
    columns: [{ id: "name", name: "Name", type: "text", required: true }, { id: "website", name: "Website", type: "url" }, ...extra],
  };
}
const owner: Column = { id: "owner", name: "Owner", type: "person", default: { kind: "creator" } };
const addCompanies = (extra: Column[] = []): Change => ({ kind: "add_sheet", sheet: companies(extra) });

describe("a new sheet under a role that sees its own rows", () => {
  it("is seen by its Owner column", () => {
    const f = applyChanges(salesLeadsFile(), [addCompanies([owner])]);
    expect(role(f, "lead_owners").scopeColumns).toEqual({ leads: { column: "owner" }, companies: { column: "owner" } });
    expect(role(f, "lead_owners").sheets).toBeUndefined();
    valid(f);
    expect(accessLines(salesLeadsFile(), f)).toEqual(["Lead owners see their own companies, by Owner."]);
  });

  it("is seen by the person column filled with whoever adds the row, when none is called Owner", () => {
    const f = applyChanges(salesLeadsFile(), [
      addCompanies([
        { id: "contact", name: "Contact", type: "person" },
        { id: "added_by", name: "Added by", type: "person", default: { kind: "creator" } },
      ]),
    ]);
    expect(role(f, "lead_owners").scopeColumns?.companies).toEqual({ column: "added_by" });
    valid(f);
  });

  it("is seen one link away when it points at a sheet the role decides by a person column", () => {
    const f = applyChanges(salesLeadsFile(), [
      { kind: "add_sheet", sheet: { ...companies([{ id: "lead", name: "Lead", type: "link", link: { sheet: "leads" } }]), id: "calls", name: "Calls", row: { one: "call", many: "calls" } } },
    ]);
    expect(role(f, "lead_owners").scopeColumns?.calls).toEqual({ via: "lead", column: "owner" });
    valid(f);
    expect(accessLines(salesLeadsFile(), f)).toEqual(["Lead owners see their own calls, by Lead's Owner."]);
  });

  it("is left to admins when nothing says whose a row is", () => {
    const f = applyChanges(salesLeadsFile(), [addCompanies()]);
    expect(role(f, "lead_owners").sheets).toEqual(["leads"]);
    expect(role(f, "lead_owners").scopeColumns).toEqual({ leads: { column: "owner" } });
    valid(f);
    expect(accessLines(salesLeadsFile(), f)).toEqual(["Lead owners won't see Companies yet."]);
  });

  it("leaves roles that see every row, and roles with their own list of sheets, as they are", () => {
    const before = salesLeadsFile();
    role(before, "lead_owners").sheets = ["leads"];
    const f = applyChanges(before, [addCompanies()]);
    expect(role(f, "sales_managers")).toEqual(role(before, "sales_managers"));
    expect(role(f, "lead_owners")).toEqual(role(before, "lead_owners"));
    valid(f);
  });

  it("skips lines, which go with their document", () => {
    const f = salesLeadsFile();
    const was = structuredClone(f);
    defaultAccess(f, { ...companies(), kind: "lines", parentSheet: "leads" });
    expect(f).toEqual(was);
  });

  it("gives the same file for the same change", () => {
    expect(applyChanges(salesLeadsFile(), [addCompanies([owner])])).toEqual(applyChanges(salesLeadsFile(), [addCompanies([owner])]));
  });
});

describe("set_sheet_access", () => {
  const withCompanies = (extra: Column[] = []) => applyChanges(salesLeadsFile(), [addCompanies(extra)]);

  it("all: a role that sees its own rows gets one beside it that sees every company", () => {
    const before = withCompanies();
    const f = applyChanges(before, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    expect(role(f, "lead_owners").sheets).toEqual(["leads"]);
    expect(role(f, "lead_owners_companies")).toEqual({
      id: "lead_owners_companies",
      name: "Lead owners on Companies",
      members: { kind: "column", sheet: "leads", column: "owner" },
      can: ["see", "add", "edit", "move_steps"],
      sheets: ["companies"],
      scope: "all",
      beside: { role: "lead_owners", sheet: "companies" },
    });
    valid(f);
    expect(accessLines(before, f)).toEqual(["Lead owners see every company."]);
  });

  it("all, asked again, changes the role beside it rather than adding a second", () => {
    const once = applyChanges(withCompanies(), [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    const twice = applyChanges(once, [{ kind: "set_sheet_access", role: "lead_owners_companies", sheet: "companies", sees: "all" }]);
    expect(twice.roles.length).toBe(once.roles.length);
  });

  it("none: Sales managers stop seeing Companies; the change is refused when it would leave them nothing", () => {
    const before = withCompanies();
    const f = applyChanges(before, [{ kind: "set_sheet_access", role: "sales_managers", sheet: "companies", sees: "none" }]);
    expect(role(f, "sales_managers").sheets).toEqual(["leads"]);
    valid(f);
    expect(accessLines(before, f)).toEqual(["Sales managers won't see Companies any more."]);
    expect(() => applyChanges(salesLeadsFile(), [{ kind: "set_sheet_access", role: "lead_owners", sheet: "leads", sees: "none" }])).toThrow(ChangeError);
  });

  it("by_column: on a role that sees its own rows; on a role that sees every row, one beside it", () => {
    const before = withCompanies([owner]);
    const own = applyChanges(withCompanies([{ ...owner, id: "rep", name: "Rep" }]), [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "by_column", column: "rep" }]);
    expect(role(own, "lead_owners").scopeColumns?.companies).toEqual({ column: "rep" });
    valid(own);

    const managers = applyChanges(before, [{ kind: "set_sheet_access", role: "sales_managers", sheet: "companies", sees: "by_column", column: "owner" }]);
    expect(role(managers, "sales_managers").sheets).toEqual(["leads"]);
    expect(role(managers, "sales_managers_companies")).toMatchObject({ scope: "own", sheets: ["companies"], scopeColumns: { companies: { column: "owner" } }, can: ["see", "add", "edit", "delete", "move_steps"] });
    valid(managers);
    expect(accessLines(before, managers)).toEqual(["Sales managers see their own companies, by Owner."]);
  });

  it("through_link: whose a row is, one link away", () => {
    const before = withCompanies([{ id: "lead", name: "Lead", type: "link", link: { sheet: "leads" } }]);
    // The default already found the link; set again, it stays one rule, checked as before.
    const f = applyChanges(before, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "through_link", via: "lead", column: "owner" }]);
    expect(role(f, "lead_owners").scopeColumns?.companies).toEqual({ via: "lead", column: "owner" });
    valid(f);
  });

  it("a role on that one sheet alone changes how it sees it in place", () => {
    const before = salesLeadsFile();
    const f = applyChanges(before, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "leads", sees: "all" }]);
    expect(role(f, "lead_owners")).toMatchObject({ scope: "all" });
    expect(role(f, "lead_owners").scopeColumns).toBeUndefined();
    expect(f.roles.length).toBe(2);
    valid(f);
  });

  it("never takes the id of a role that's already there, and never folds a role that only looks like one beside another", () => {
    const before = withCompanies();
    // A role of its own whose id happens to read like one added beside Lead owners.
    before.roles.push({ id: "lead_owners_companies", name: "Company keepers", members: { kind: "everyone" }, can: ["see"], sheets: ["companies"], scope: "all" });
    const f = applyChanges(before, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    expect(role(f, "lead_owners_companies").name).toBe("Company keepers");
    expect(role(f, "lead_owners_companies_2")).toMatchObject({ name: "Lead owners on Companies", beside: { role: "lead_owners", sheet: "companies" } });
    valid(f);
  });

  it("is changed through its role: back to their own by Owner switches the role beside it off; none switches it off too", () => {
    const before = withCompanies([owner]);
    const all = applyChanges(before, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    const own = applyChanges(all, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "by_column", column: "owner" }]);
    expect(role(own, "lead_owners").sheets).toEqual(["leads", "companies"]);
    expect(role(own, "lead_owners").scopeColumns?.companies).toEqual({ column: "owner" });
    expect(role(own, "lead_owners_companies").sheets).toEqual([]);
    valid(own);
    expect(accessLines(all, own)).toEqual(["Lead owners see their own companies, by Owner."]);
    // Asked again for every company, the same role beside it comes back on.
    const again = applyChanges(own, [{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "all" }]);
    expect(again.roles.length).toBe(all.roles.length);
    expect(role(again, "lead_owners_companies").sheets).toEqual(["companies"]);
    const none = applyChanges(all, [{ kind: "set_sheet_access", role: "lead_owners_companies", sheet: "companies", sees: "none" }]);
    expect(role(none, "lead_owners_companies").sheets).toEqual([]);
    expect(role(none, "lead_owners").sheets).toEqual(["leads"]);
    valid(none);
    expect(accessLines(all, none)).toEqual(["Lead owners won't see Companies any more."]);
  });

  it("names a role or sheet that doesn't exist in plain words", () => {
    expect(() => applyChanges(salesLeadsFile(), [{ kind: "set_sheet_access", role: "nobody", sheet: "leads", sees: "all" }])).toThrow("Sales leads has no role “nobody”.");
  });
});

describe("set_sheet_access by name (prompt 3)", () => {
  const CAP = "10000000-0000-4000-8000-00000000005a";
  const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
  const world = () => {
    const f = applyChanges(salesLeadsFile(), [addCompanies([owner, { id: "lead", name: "Lead", type: "link", link: { sheet: "leads" } }])]);
    return { capId: CAP, files: new Map([[CAP, f]]), people: new Map<string, string>() };
  };
  const compile = (access: { sees: "all" | "by_column" | "through_link" | "none"; column: string | null; via: string | null }, roleName = "Lead owners") =>
    compileCustomize([{ ...blank, kind: "set_sheet_access", sheet: "Companies", role: roleName, access }], world());

  it("turns names into ids", () => {
    expect(compile({ sees: "by_column", column: "owner", via: null }).changes).toEqual([{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "by_column", column: "owner" }]);
    expect(compile({ sees: "through_link", column: "Owner", via: "Lead" }).changes).toEqual([{ kind: "set_sheet_access", role: "lead_owners", sheet: "companies", sees: "through_link", via: "lead", column: "owner" }]);
    expect(compile({ sees: "all", column: null, via: null }, "sales managers").changes).toEqual([{ kind: "set_sheet_access", role: "sales_managers", sheet: "companies", sees: "all" }]);
  });

  it("lets a new sheet link to a sheet already in the capability, and Lead owners see it through that link", () => {
    const leadLink = { name: "Lead", type: "link" as const, required: false, default: null, options: [], link: { capability: null, sheet: "Leads" }, formula: null, result: null };
    const calls = { name: "Calls", kind: "list" as const, parent_sheet: null, title_column: "Lead", row_one: "call", row_many: "calls", add_action: null, columns: [leadLink], steps: [] };
    const out = compileCustomize([{ ...blank, kind: "add_sheet", new_sheet: calls }], { capId: CAP, files: new Map([[CAP, salesLeadsFile()]]), people: new Map() });
    expect(out.problems).toEqual([]);
    const after = applyChanges(salesLeadsFile(), out.changes);
    expect(after.sheets[1]!.columns[0]!.link).toEqual({ sheet: "leads" });
    expect(role(after, "lead_owners").scopeColumns?.calls).toEqual({ via: "lead", column: "owner" });
    valid(after);
  });

  it("says plainly what doesn't exist", () => {
    expect(compile({ sees: "by_column", column: "Website", via: null }).problems).toEqual(["Companies has no person column “Website” that says whose a row is."]);
    expect(compile({ sees: "through_link", column: "Owner", via: "Website" }).problems).toEqual(["Sales leads › Companies: “Website” isn't a link to another sheet of Sales leads."]);
    expect(compile({ sees: "all", column: null, via: null }, "Partners").problems).toEqual(["Sales leads has no role “Partners”."]);
  });
});

// Found live on Nov 3: a change that couldn't be applied escaped as an error ("Budgets already has a column “spent”.")
// and the admin read "I couldn't do that". It's a problem in words now, for the AI's retry and the reply.
describe("a change that can't be applied is a problem, not an error", () => {
  const CAP = "10000000-0000-4000-8000-00000000005b";
  const budgets = (): CapabilityFile => ({
    name: "Tools and budgets",
    icon: "wrench",
    sheets: [{ id: "budgets", name: "Budgets", kind: "list", titleColumn: "team", columns: [{ id: "team", name: "Team", type: "text" }, { id: "spent", name: "Spent", type: "money" }] }],
    roles: [{ id: "finance", name: "Finance", members: { kind: "people", people: [PEOPLE.wade] }, can: ["see", "customize"], scope: "all" }],
    rules: [],
    later: [],
  });
  const w = () => ({ capId: CAP, files: new Map([[CAP, budgets()]]), people: new Map<string, string>() });
  const dup = { changes: [{ kind: "add_column" as const, sheet: "budgets", column: { id: "spent", name: "Spent", type: "money" as const } }], words: [{ explain: "x", part: "x", where: "x" }], rules: [], renames: [], problems: [] };

  it("tryEdits says it in words", () => {
    expect(tryEdits(w(), dup.changes, dup)).toEqual({ edits: null, problems: ["Budgets already has a column “spent”."] });
  });

  it("ruleChanges says it in words", () => {
    expect(ruleChanges(dup, [], w())).toEqual({ changes: [], problems: ["Budgets already has a column “spent”."] });
  });
});

// Found on Nov 3 (live: "Budgets already has a column “spent”"; C3: "Contacts already has a column
// “total_of_entries”"): applying changes put a new sheet into the file as the change's own object, so a later change
// to that sheet changed the change itself, and the same changes applied again failed. Applying must leave them as
// they were.
describe("applying changes never changes the changes", () => {
  it("a new sheet with a column added to it applies twice, the same both times", () => {
    const changes: Change[] = [
      { kind: "add_sheet", sheet: companies() },
      { kind: "add_column", sheet: "companies", column: { id: "total", name: "Total", type: "money" } },
    ];
    const was = structuredClone(changes);
    const once = applyChanges(salesLeadsFile(), changes);
    expect(changes).toEqual(was);
    expect(applyChanges(salesLeadsFile(), changes)).toEqual(once);
  });

  it("so a whole change set builds its files", () => {
    const CAP = "10000000-0000-4000-8000-00000000005c";
    const w = { capId: CAP, files: new Map([[CAP, salesLeadsFile()]]), people: new Map<string, string>() };
    const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
    const col = (name: string, type: "text" | "money") => ({ name, type, required: false, default: null, options: [], link: null, formula: null, result: null });
    const c = compileCustomize(
      [
        { ...blank, kind: "add_sheet", new_sheet: { name: "Companies", kind: "list", parent_sheet: null, title_column: "Name", row_one: "company", row_many: "companies", add_action: null, columns: [col("Name", "text")], steps: [] } },
        { ...blank, kind: "add_column", sheet: "Companies", column: col("Total of leads", "money") },
      ],
      w,
    );
    expect(c.problems).toEqual([]);
    expect(tryEdits(w, c.changes, c).problems).toEqual([]);
  });
});

describe("a new sheet's title question", () => {
  it("is added as text when it's named but not among the questions", () => {
    const CAP = "10000000-0000-4000-8000-00000000005d";
    const w = { capId: CAP, files: new Map([[CAP, salesLeadsFile()]]), people: new Map<string, string>() };
    const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
    const c = compileCustomize(
      [{ ...blank, kind: "add_sheet", new_sheet: { name: "Contacts", kind: "list", parent_sheet: null, title_column: "Name", row_one: "contact", row_many: "contacts", add_action: null, columns: [{ name: "Email", type: "email", required: false, default: null, options: [], link: null, formula: null, result: null }], steps: [] } }],
      w,
    );
    expect(c.problems).toEqual([]);
    const sheet = (c.changes[0] as { sheet: { titleColumn: string; columns: { id: string; name: string; type: string; required?: boolean }[] } }).sheet;
    expect(sheet.columns[0]).toMatchObject({ name: "Name", type: "text", required: true });
    expect(sheet.titleColumn).toBe(sheet.columns[0]!.id);
  });

  it("steps with no step question get one: Status becomes it, or a Status is added", () => {
    const CAP = "10000000-0000-4000-8000-00000000005e";
    const w = { capId: CAP, files: new Map([[CAP, salesLeadsFile()]]), people: new Map<string, string>() };
    const blank = { sheet: null, new_sheet: null, column: null, step: null, after: null, rename: null, movers: null, role: null, person: null, rule: null, view: null, labels: null, hint: null, sort: null, check: null, form: null, show_when: null, access: null, link: null, explain: "x", part: "x" };
    const c2 = (columns: { name: string; type: "text" | "choice" }[]) => ({ name: "Name", required: false, default: null, options: [], link: null, formula: null, result: null, ...columns });
    const steps = [{ name: "Open", start: true, end: null, button: null, only_when: null, move_out: "anyone" as const, move_in: "anyone" as const }, { name: "Closed", start: false, end: "final" as const, button: null, only_when: null, move_out: "anyone" as const, move_in: "anyone" as const }];
    for (const extra of [[{ ...c2([]), name: "Status", type: "choice" as const, options: ["Open", "Closed"] }], []]) {
      const c = compileCustomize(
        [{ ...blank, kind: "add_sheet", new_sheet: { name: "Companies", kind: "list", parent_sheet: null, title_column: "Name", row_one: "company", row_many: "companies", add_action: null, columns: [{ ...c2([]), name: "Name", type: "text" }, ...extra], steps } }],
        w,
      );
      expect(c.problems).toEqual([]);
      const cols = (c.changes[0] as { sheet: { columns: { name: string; type: string }[] } }).sheet.columns;
      expect(cols.filter((x) => x.type === "step").map((x) => x.name)).toEqual(["Status"]);
    }
  });
});
