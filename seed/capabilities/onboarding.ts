// Onboarding (4e: 2 sheets, 3 steps, owned by Priya): a first-week plan per starter with tasks for IT, the
// manager and a buddy. Seeded with Ana Ruiz's plan, where Maya is the buddy (7g: "Buddy in Onboarding").
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

function file(s: Seeder): CapabilityFile {
  const viaPlan = (column: string) => ({ via: "plan", column });
  return {
    name: "Onboarding",
    icon: "user-check",
    description: "A first-week plan for every new starter",
    sheets: [
      {
        id: "plans",
        name: "Plans",
        kind: "list",
        row: { one: "plan", many: "plans" },
        addAction: "Plan a starter’s first week",
        titleColumn: "name",
        columns: [
          { id: "name", name: "Name", type: "text", required: true },
          { id: "start_date", name: "Start date", type: "date" },
          { id: "manager", name: "Manager", type: "person" },
          { id: "buddy", name: "Buddy", type: "person" },
          { id: "it", name: "IT", type: "person" },
        ],
      },
      {
        id: "tasks",
        name: "Tasks",
        kind: "list",
        row: { one: "task", many: "tasks" },
        titleColumn: "task",
        columns: [
          { id: "plan", name: "Plan", type: "link", link: { sheet: "plans" }, required: true },
          { id: "task", name: "Task", type: "text", required: true },
          { id: "owner", name: "Owner", type: "person" },
          { id: "due", name: "Due", type: "date" },
          { id: "status", name: "Status", type: "step" },
        ],
        steps: [
          { id: "to_do", name: "To do", start: true },
          { id: "doing", name: "Doing" },
          { id: "done", name: "Done", end: "final" },
        ],
      },
    ],
    roles: [
      {
        id: "leads",
        name: "Onboarding leads",
        members: { kind: "people", people: [s.p("priya"), s.p("wade"), s.p("aisha")] },
        can: ["see", "add", "edit", "delete", "move_steps", "customize"],
        scope: "all",
      },
      {
        id: "managers",
        name: "Managers",
        members: { kind: "column", sheet: "plans", column: "manager" },
        can: ["see", "add", "edit", "move_steps"],
        scope: "own",
        scopeColumns: { plans: { column: "manager" }, tasks: viaPlan("manager") },
      },
      {
        id: "buddies",
        name: "Buddies",
        members: { kind: "column", sheet: "plans", column: "buddy" },
        can: ["see", "move_steps"],
        scope: "own",
        scopeColumns: { plans: { column: "buddy" }, tasks: viaPlan("buddy") },
      },
      {
        id: "task_owners",
        name: "Task owners",
        members: { kind: "column", sheet: "tasks", column: "owner" },
        can: ["see", "move_steps"],
        sheets: ["tasks"],
        scope: "own",
        scopeColumns: { tasks: { column: "owner" } },
      },
    ],
    rules: [],
    later: [],
  };
}

export async function seedOnboarding(s: Seeder) {
  const cap = await s.create(file(s), "2026-10-12T09:20:01Z", { owner: "priya" });
  const at = "2026-10-19T15:00:00Z";
  const plan = await s.add("priya", cap, "plans", { name: "Ana Ruiz", start_date: "2026-11-02", manager: s.p("priya"), buddy: s.p("maya"), it: s.p("jon") }, at);
  // 11f: 4 of 6 tasks done.
  const TASKS: [task: string, owner: string, due: string, done: boolean][] = [
    ["Laptop ready", "jon", "2026-10-30", true],
    ["Accounts and email", "jon", "2026-10-30", true],
    ["First-week plan", "priya", "2026-10-28", true],
    ["Welcome lunch booked", "priya", "2026-10-28", true],
    ["Team introductions", "priya", "2026-11-02", false],
    ["Buddy coffee", "maya", "2026-11-03", false],
  ];
  for (const [task, owner, due, done] of TASKS) {
    const id = await s.add("priya", cap, "tasks", { plan, task, owner: s.p(owner), due }, at);
    if (done) {
      await s.move(owner, id, "doing", "2026-10-21T15:00:00Z");
      await s.move(owner, id, "done", "2026-10-22T15:00:00Z");
    }
  }
  return cap;
}
