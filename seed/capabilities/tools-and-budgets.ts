// Tools and budgets (4e: every software seat and vendor budget, with renewal dates; 3 sheets, owned by Lena).
// No Step 6–8 screen shows its rows; the budgets behind 11c are seeded in M8.
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

const TEAMS = [
  { id: "engineering", name: "Engineering" },
  { id: "marketing", name: "Marketing" },
  { id: "sales", name: "Sales" },
  { id: "operations", name: "Operations" },
  { id: "people", name: "People" },
];

function file(s: Seeder): CapabilityFile {
  return {
    name: "Tools and budgets",
    icon: "wrench",
    description: "Software seats and vendor budgets",
    sheets: [
      {
        id: "tools",
        name: "Tools",
        kind: "list",
        row: { one: "tool", many: "tools" },
        addAction: "Add a tool",
        titleColumn: "tool",
        columns: [
          { id: "tool", name: "Tool", type: "text", required: true },
          { id: "vendor", name: "Vendor", type: "text" },
          { id: "team", name: "Team", type: "choice", options: TEAMS },
          { id: "seats", name: "Seats", type: "number", min: 0 },
          { id: "cost", name: "Cost a year", type: "money" },
          { id: "renews_on", name: "Renews on", type: "date" },
          { id: "owner", name: "Owner", type: "person" },
        ],
      },
      {
        id: "seats",
        name: "Seats",
        kind: "list",
        row: { one: "seat", many: "seats" },
        titleColumn: "person",
        columns: [
          { id: "tool", name: "Tool", type: "link", link: { sheet: "tools" }, required: true },
          { id: "person", name: "Person", type: "person", required: true },
          { id: "since", name: "Since", type: "date" },
        ],
      },
      {
        id: "budgets",
        name: "Budgets",
        kind: "list",
        row: { one: "budget", many: "budgets" },
        addAction: "Set a budget",
        titleColumn: "team",
        columns: [
          { id: "team", name: "Team", type: "choice", options: TEAMS, required: true },
          { id: "quarter", name: "Quarter", type: "text", required: true },
          { id: "budget", name: "Budget", type: "money", required: true },
        ],
      },
    ],
    roles: [
      {
        id: "finance",
        name: "Finance",
        members: { kind: "people", people: [s.p("lena"), s.p("wade"), s.p("krishna")] },
        can: ["see", "add", "edit", "delete", "customize"],
        scope: "all",
      },
    ],
    rules: [],
    later: [],
  };
}

export async function seedToolsAndBudgets(s: Seeder) {
  return s.create(file(s), "2026-10-12T09:20:04Z", { owner: "lena" });
}
