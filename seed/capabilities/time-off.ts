// Time off (4e: requests, balances and holidays; owned by Lena), as 8a, 8f and X1 show it.
// Submitted → Approved or Declined → Taken. Managers move their team's requests out of Submitted only.
import type { CapabilityFile } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

function file(s: Seeder): CapabilityFile {
  return {
    name: "Time off",
    icon: "calendar-days",
    description: "Requests, balances and holidays",
    sheets: [
      {
        id: "requests",
        name: "Requests",
        kind: "list",
        row: { one: "request", many: "requests" },
        addAction: "Request time off",
        sort: { column: "status", dir: "asc", then: { column: "from", dir: "desc" } }, // 8a, 8b: by step, newest first
        titleColumn: "who",
        columns: [
          { id: "who", name: "Who", type: "person", required: true, default: { kind: "creator" } },
          { id: "type", name: "Type", type: "choice", required: true, options: [{ id: "vacation", name: "Vacation" }, { id: "sick", name: "Sick" }, { id: "personal", name: "Personal" }] },
          { id: "from", name: "From", type: "date", required: true },
          { id: "to", name: "To", type: "date", required: true },
          // Calendar days, both ends included: what 8a, 8f and X1 show (Aug 4–8 is 5).
          { id: "days", name: "Days", type: "computed", result: "number", expr: { op: "add", args: [{ op: "sub", args: [{ col: "to" }, { col: "from" }] }, 1] } },
          { id: "note", name: "Note", type: "long_text" },
          { id: "status", name: "Status", type: "step" },
          // X1: the days left in the person's balance once this request is taken.
          {
            id: "balance_after",
            name: "Balance after",
            type: "computed",
            result: "days",
            expr: { op: "sub", args: [{ lookup: { sheet: "balances", where: "who", is: "who", value: "left" } }, { col: "days" }] },
          },
        ],
        steps: [
          { id: "submitted", name: "Submitted", start: true, tone: "yellow" },
          // Nobody approves or declines their own request.
          { id: "approved", name: "Approved", moveIn: "not_submitter", tone: "green", button: "Approve" },
          { id: "declined", name: "Declined", end: "exit", moveIn: "not_submitter", tone: "grey", button: "Decline" },
          { id: "taken", name: "Taken", end: "final", tone: "done" },
        ],
        // 8f: a request fits in what is left of the person's balance (anyone without a balance row is let through).
        checks: [
          {
            id: "balance",
            name: "Within your balance",
            condition: {
              op: "or",
              args: [
                { op: "empty", args: [{ lookup: { sheet: "balances", where: "who", is: "who", value: "left" } }] },
                { op: "lte", args: [{ col: "days" }, { lookup: { sheet: "balances", where: "who", is: "who", value: "left" } }] },
              ],
            },
          },
        ],
      },
      {
        id: "balances",
        name: "Balances",
        kind: "list",
        row: { one: "balance", many: "balances" },
        titleColumn: "who",
        columns: [
          { id: "who", name: "Who", type: "person", required: true },
          { id: "year", name: "Year", type: "number" },
          { id: "allowance", name: "Days a year", type: "days" },
          { id: "used", name: "Used", type: "days" },
          { id: "left", name: "Left", type: "computed", result: "days", expr: { op: "sub", args: [{ col: "allowance" }, { col: "used" }] } },
        ],
      },
      {
        id: "holidays",
        name: "Holidays",
        kind: "list",
        row: { one: "holiday", many: "holidays" },
        titleColumn: "name",
        columns: [
          { id: "date", name: "Date", type: "date", required: true },
          { id: "name", name: "Holiday", type: "text", required: true },
        ],
      },
    ],
    roles: [
      { id: "admins", name: "Time off admins", members: { kind: "people", people: [s.p("lena"), s.p("wade")] }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
      {
        id: "everyone",
        name: "Everyone",
        members: { kind: "everyone" },
        can: ["see", "add"],
        sheets: ["requests", "balances"],
        scope: "own",
        scopeColumns: { requests: { column: "who" }, balances: { column: "who" } },
        // 8a, 8f: your own requests, and the form to ask for more.
        view: {
          sheet: "requests",
          line: "Your requests and balance",
          columns: [{ column: "from", name: "Dates", to: "to" }, { column: "days" }, { column: "type" }, { column: "status" }],
          form: ["type", ["from", "to"], "note"],
        },
      },
      { id: "calendar", name: "Everyone (holidays)", members: { kind: "everyone" }, can: ["see"], sheets: ["holidays"], scope: "all" },
      {
        id: "managers",
        name: "Managers",
        members: { kind: "everyone" },
        can: ["see", "move_steps"],
        moveFrom: ["submitted"],
        sheets: ["requests"],
        scope: "team",
        scopeColumns: { requests: { column: "who" } },
        // X1: a manager's team's requests.
        view: {
          sheet: "requests",
          line: "Your team’s requests",
          columns: [{ column: "who" }, { column: "from", name: "Dates", to: "to" }, { column: "days" }, { column: "type" }, { column: "status" }],
        },
      },
    ],
    rules: [
      {
        id: "to_manager",
        text: "Requests go to the person’s manager.",
        reading: { when: "A request is sent", then: "It waits on the person’s manager to approve or decline it" },
        trigger: { kind: "enters_step", sheet: "requests", step: "submitted" },
        actions: [{ kind: "ask_person", managerOf: "who", step: "submitted", label: "Approve or decline" }],
        enabled: true,
      },
      ...(["approved", "declined"] as const).map((step) => ({
        id: `told_${step}`,
        text: `When a request is ${step}, tell the person and Lena.`,
        reading: { when: `A request is ${step}`, then: "The person and Lena are emailed" },
        trigger: { kind: "enters_step" as const, sheet: "requests", step },
        actions: [{ kind: "notify" as const, columns: ["who"], people: [s.p("lena")], message: `Your time off request was ${step}.` }],
        enabled: true,
      })),
    ],
    later: [],
  };
}

export async function seedTimeOff(s: Seeder) {
  const cap = await s.create(file(s), "2026-10-12T09:20:02Z", { owner: "lena" });
  // 8a's earlier requests, and three more in Priya's team (X1: "All 7").
  type Request = [who: string, type: string, from: string, to: string, status: string];
  const REQUESTS: Request[] = [
    ["maya", "vacation", "2026-10-15", "2026-10-16", "approved"],
    ["maya", "vacation", "2026-08-04", "2026-08-08", "taken"],
    ["maya", "sick", "2026-06-02", "2026-06-02", "taken"],
    ["omar", "vacation", "2026-11-26", "2026-11-27", "approved"],
    ["omar", "vacation", "2026-09-14", "2026-09-18", "taken"],
    ["kim", "sick", "2026-10-05", "2026-10-05", "taken"],
  ];
  await s.import(
    cap,
    "requests",
    REQUESTS.map(([who, type, from, to, status]) => ({ values: { who: s.p(who), type, from, to, status } })),
    "leave.csv",
    "2026-10-12T09:20:30Z",
  );
  // 8f: 12 days left before the Dec request (X1: 8 of 20 after it).
  await s.import(cap, "balances", [{ values: { who: s.p("maya"), year: 2026, allowance: 20, used: 8 } }], "leave.csv", "2026-10-12T09:20:31Z");
  // X1: submitted Oct 20, waiting on Priya.
  await s.add("maya", cap, "requests", { type: "vacation", from: "2026-12-28", to: "2026-12-31", note: "Family trip, back on Jan 4" }, "2026-10-20T14:00:00Z");
  return cap;
}
