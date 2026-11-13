// Hiring as 6g, 8d and 8e show it, at version 3. v1 came with the build on Oct 12, with its offer rules; v2
// let Engineering see the open roles and refer people, and added the hand-off to Onboarding; v3 added the
// Interviews sheet and its scorecard rule (9a, Oct 20).
// "Add three interviews when a candidate reaches Interview" (6g) needs a field map that names the row that
// ran the rule; it comes with the Customize text in M6.
import type { CapabilityFile, Role, Rule, Sheet } from "@/server/kernel/schema/file";
import type { Seeder } from "./seeder";

const $ = (dollars: number) => dollars * 100;

const openings: Sheet = {
  id: "openings",
  name: "Openings",
  kind: "list",
  row: { one: "role", many: "roles" },
  addAction: "Open a role",
  titleColumn: "role",
  columns: [
    { id: "role", name: "Role", type: "text", required: true },
    {
      id: "team",
      name: "Team",
      type: "choice",
      options: [{ id: "engineering", name: "Engineering" }, { id: "growth", name: "Growth" }, { id: "customer", name: "Customer" }, { id: "operations", name: "Operations" }],
    },
    { id: "hiring_manager", name: "Hiring manager", type: "person" },
    { id: "salary_band", name: "Salary band", type: "money_range" },
    { id: "opens_on", name: "Opens on", type: "date" },
    { id: "status", name: "Status", type: "step" },
  ],
  steps: [
    { id: "draft", name: "Draft", start: true },
    { id: "open", name: "Open", tone: "green" },
    { id: "filled", name: "Filled", end: "final", tone: "done" },
    { id: "closed", name: "Closed", end: "exit", tone: "grey" },
  ],
};

const candidates: Sheet = {
  id: "candidates",
  name: "Candidates",
  kind: "list",
  row: { one: "candidate", many: "candidates" },
  titleColumn: "name",
  form: {
    tabs: [
      { name: "Candidate", sections: [{ name: null, columns: ["name", "opening", "source", "referred_by", "cv"] }] },
      { name: "Offer", sections: [{ name: null, columns: ["offer", "offer_approval", "start_date"] }] },
    ],
  },
  columns: [
    { id: "name", name: "Name", type: "text", required: true },
    { id: "opening", name: "Opening", type: "link", link: { sheet: "openings" } },
    { id: "source", name: "Source", type: "choice", options: [{ id: "referral", name: "Referral" }, { id: "inbound", name: "Inbound" }, { id: "agency", name: "Agency" }] },
    { id: "referred_by", name: "Referred by", type: "person" },
    { id: "cv", name: "CV", type: "file" },
    // 8d shows the offer ($168,000); the salary-band rule reads it. 6g, 6h and 6j list it from M6.
    { id: "offer", name: "Offer", type: "money" },
    // Wade's decision on an offer above the band; the rule that asks him writes it.
    { id: "offer_approval", name: "Offer approval", type: "choice", options: [{ id: "approved", name: "Approved" }, { id: "declined", name: "Declined" }] },
    { id: "start_date", name: "Start date", type: "date" }, // filled at Offer; Onboarding copies it
    { id: "stage", name: "Stage", type: "step" },
  ],
  steps: [
    { id: "applied", name: "Applied", start: true },
    { id: "screen", name: "Screen" },
    { id: "interview", name: "Interview", tone: "violet" },
    { id: "offer", name: "Offer", tone: "yellow" },
    { id: "hired", name: "Hired", end: "final", tone: "done" },
    { id: "rejected", name: "Rejected", end: "exit", tone: "grey" },
  ],
};

const interviews: Sheet = {
  id: "interviews",
  name: "Interviews",
  kind: "list",
  row: { one: "interview", many: "interviews" },
  titleColumn: "candidate",
  columns: [
    { id: "candidate", name: "Candidate", type: "link", link: { sheet: "candidates" }, required: true },
    { id: "interviewer", name: "Interviewer", type: "person" },
    { id: "when", name: "When", type: "datetime" },
    { id: "score", name: "Score", type: "number", min: 1, max: 4 },
    { id: "notes", name: "Notes", type: "long_text" },
  ],
};

const ENGINEERING = ["priya", "maya", "omar", "kim", "ana"];

const band = { col: "salary_band", via: "opening", part: "to" as const };
const sendIt = { kind: "ask_person" as const, column: "hiring_manager", via: "opening", step: "offer", label: "Send the offer" };

function rules(s: Seeder, version: 1 | 2 | 3, onboarding: string): Rule[] {
  const out: Rule[] = [
    {
      id: "above_band",
      text: "An offer above the role’s salary band waits on Wade to approve it.",
      reading: { when: "A candidate reaches Offer with an offer above the salary band", then: "It waits on Wade to approve or decline the offer" },
      trigger: { kind: "enters_step", sheet: "candidates", step: "offer" },
      condition: { op: "gt", args: [{ col: "offer" }, band] },
      actions: [{ kind: "ask_person", person: s.p("wade"), label: "Approve the offer", decision: { column: "offer_approval", approve: "approved", decline: "declined" } }],
      enabled: true,
    },
    {
      id: "send_offer",
      text: "An offer within the band waits on the hiring manager to send it.",
      reading: { when: "A candidate reaches Offer with an offer within the salary band", then: "It waits on the opening’s hiring manager to send the offer" },
      trigger: { kind: "enters_step", sheet: "candidates", step: "offer" },
      condition: { op: "and", args: [{ op: "not", args: [{ op: "empty", args: [{ col: "offer" }] }] }, { op: "or", args: [{ op: "empty", args: [band] }, { op: "lte", args: [{ col: "offer" }, band] }] }] },
      actions: [sendIt],
      enabled: true,
    },
    {
      id: "send_approved",
      text: "Once Wade approves an offer, it waits on the hiring manager to send it.",
      reading: { when: "Wade approves an offer", then: "It waits on the opening’s hiring manager to send the offer" },
      trigger: { kind: "field_changed", sheet: "candidates", field: "offer_approval" },
      condition: { op: "and", args: [{ op: "eq", args: [{ col: "offer_approval" }, "approved"] }, { op: "eq", args: [{ col: "stage" }, "offer"] }] },
      actions: [sendIt],
      enabled: true,
    },
  ];
  if (version >= 2)
    out.push(
      {
        id: "start_onboarding",
        text: "When a candidate is Hired, start their onboarding plan with name, start date and manager.",
        reading: { when: "A candidate is Hired", then: "Their plan starts in Onboarding with their name, start date and manager" },
        trigger: { kind: "enters_step", sheet: "candidates", step: "hired" },
        actions: [{ kind: "create_row_in", target: { capability: onboarding, sheet: "plans" }, map: { name: { col: "name" }, start_date: { col: "start_date" }, manager: { col: "hiring_manager", via: "opening" } } }],
        enabled: true,
      },
      {
        id: "fill_opening",
        text: "When a candidate is Hired, their opening moves to Filled.",
        reading: { when: "A candidate is Hired", then: "Their opening moves to Filled" },
        trigger: { kind: "enters_step", sheet: "candidates", step: "hired" },
        actions: [{ kind: "update_row_in", target: { sheet: "openings" }, via: "opening", map: { status: "filled" } }],
        enabled: true,
      },
    );
  if (version >= 3)
    out.push(
      {
        // 6g. No seeded candidate enters Interview after v3, so it adds no rows to the seed.
        id: "add_interviews",
        text: "When a candidate moves to Interview, add three interviews and give each interviewer a scorecard task.",
        reading: { when: "A candidate moves to Interview", then: "Three interviews are added for them; each interviewer gets a scorecard task on the day" },
        trigger: { kind: "enters_step", sheet: "candidates", step: "interview" },
        actions: [1, 2, 3].map(() => ({ kind: "create_row_in" as const, target: { sheet: "interviews" }, map: { candidate: { ref: "row" as const } } })),
        enabled: true,
      },
      {
        id: "scorecard",
        text: "On the day of an interview, if it has no score yet, it waits on the interviewer for their scorecard.",
        reading: { when: "The day of an interview, while it has no score", then: "It waits on the interviewer for their scorecard" },
        trigger: { kind: "date_reached", sheet: "interviews", date: "when", offsetDays: 0 },
        condition: { op: "empty", args: [{ col: "score" }] },
        actions: [{ kind: "ask_person", column: "interviewer", until: "score", label: "Your scorecard" }],
        enabled: true,
      },
    );
  return out;
}

function file(s: Seeder, version: 1 | 2 | 3, onboarding = ""): CapabilityFile {
  const roles: Role[] = [
    { id: "recruiting", name: "Recruiting", members: { kind: "people", people: [s.p("wade")] }, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all" },
    {
      id: "hiring_managers",
      name: "Hiring managers",
      members: { kind: "column", sheet: "openings", column: "hiring_manager" },
      can: ["see", "add", "edit", "move_steps"],
      sheets: ["openings", "candidates"],
      scope: "own",
      scopeColumns: { openings: { column: "hiring_manager" }, candidates: { via: "opening", column: "hiring_manager" } },
      // 8d, 8e: a hiring manager's candidates.
      view: {
        sheet: "candidates",
        line: "Candidates for your team’s roles",
        columns: [{ column: "name", name: "Candidate" }, { column: "opening", name: "Role" }, { column: "stage" }],
        next: "referred_by",
      },
    },
  ];
  if (version >= 2) {
    const engineering = { kind: "people" as const, people: ENGINEERING.map(s.p) };
    roles.push(
      { id: "open_roles", name: "Open roles", members: engineering, can: ["see"], sheets: ["openings"], scope: "all" },
      { id: "referrers", name: "Referrers", members: engineering, can: ["see", "add"], sheets: ["candidates"], scope: "own", scopeColumns: { candidates: { column: "referred_by" } } },
    );
  }
  if (version >= 3)
    roles.push({
      id: "interviewers",
      name: "Interviewers",
      members: { kind: "column", sheet: "interviews", column: "interviewer" },
      can: ["see", "edit"],
      sheets: ["interviews"],
      scope: "own",
      scopeColumns: { interviews: { column: "interviewer" } },
    });
  return {
    name: "Hiring",
    icon: "briefcase-business",
    description: "Openings, candidates and interviews",
    sheets: version >= 3 ? [openings, candidates, interviews] : [openings, candidates],
    roles,
    rules: rules(s, version, onboarding),
    later: [],
  };
}

type Opening = [role: string, team: string, manager: string, band: [number, number] | null, opensOn: string, status: string];
const OPENINGS: Opening[] = [
  ["Senior backend", "engineering", "priya", [140_000, 160_000], "2026-09-01", "open"],
  ["Frontend", "engineering", "priya", null, "2026-09-15", "open"],
  ["Sales executive", "growth", "dev", null, "2026-06-01", "filled"],
  ["Product designer", "engineering", "wade", null, "2026-07-01", "filled"],
  ["Marketing manager", "growth", "dev", null, "2024-12-01", "filled"],
  ["People partner", "operations", "krishna", null, "2025-05-01", "filled"],
  ["IT and office", "operations", "krishna", null, "2024-12-01", "filled"],
];

// 8d's candidates (Sam Okafor in place of the design's Leo Grant), and the 5 already Hired (6h).
type Candidate = [name: string, opening: string, source: string, stage: string, offer?: number, startDate?: string];
const CANDIDATES: Candidate[] = [
  ["Tom Weiss", "Senior backend", "inbound", "interview"],
  ["Grace Kim", "Frontend", "agency", "interview"],
  ["Ravi Menon", "Senior backend", "inbound", "screen"],
  ["Lucy Ward", "Frontend", "inbound", "screen"],
  ["Eli Brooks", "Frontend", "inbound", "applied"],
  ["Sofia Park", "Frontend", "agency", "applied"],
  ["Sam Okafor", "Senior backend", "agency", "offer", 168_000],
  ["Leo Grant", "Sales executive", "inbound", "offer", undefined, "2026-11-10"], // Dev hires him on Oct 21 (9a); he starts as People says
  ["Mei Chen", "Product designer", "referral", "hired"],
  ["Nina Park", "Marketing manager", "inbound", "hired"],
  ["Aisha Khan", "People partner", "agency", "hired"],
  ["Jon Bell", "IT and office", "inbound", "hired"],
];

// In two parts, so Onboarding (next in the sidebar) exists before Hiring's hand-off to it is added on Oct 15.
export async function startHiring(s: Seeder) {
  return s.create(file(s, 1), "2026-10-12T09:20:00Z", { owner: "wade" });
}

export async function seedHiring(s: Seeder, cap: string, onboarding: string) {
  const openingIds = await s.import(
    cap,
    "openings",
    OPENINGS.map(([role, team, manager, band, opensOn, status]) => ({
      values: { role, team, hiring_manager: s.p(manager), salary_band: band && { from: $(band[0]), to: $(band[1]) }, opens_on: opensOn, status },
    })),
    "candidates.csv",
    "2026-10-12T09:20:30Z",
  );
  const opening = new Map(OPENINGS.map(([role], i) => [role, openingIds[i]!]));
  const candidateIds = await s.import(
    cap,
    "candidates",
    CANDIDATES.map(([name, op, source, stage, offer, startDate]) => ({ values: { name, opening: opening.get(op), source, stage, offer: offer && $(offer), start_date: startDate } })),
    "candidates.csv",
    "2026-10-12T09:20:31Z",
  );
  const candidate = new Map(CANDIDATES.map(([name], i) => [name, candidateIds[i]!]));
  // Sam came in at Offer above the band, so the import's rule asked Wade; he approved it the next morning.
  await s.decide("wade", candidate.get("Sam Okafor")!, "above_band", "approve", "2026-10-13T14:30:00Z");

  await s.change(cap, file(s, 2, onboarding), "2026-10-15T15:10:00Z", "roles added “Open roles” and “Referrers” · rules added “When a candidate is Hired…”");
  // Maya referred Hannah Cole (8d: "Referred by Maya"); Priya screened her.
  const hannah = await s.add("maya", cap, "candidates", { name: "Hannah Cole", opening: opening.get("Senior backend"), source: "referral", referred_by: s.p("maya") }, "2026-10-16T14:05:00Z");
  await s.move("priya", hannah, "screen", "2026-10-19T16:30:00Z");

  await s.change(cap, file(s, 3, onboarding), "2026-10-20T18:30:11Z", "sheet added “Interviews”");
  type Interview = [candidate: string, interviewer: string, when: string, score?: number];
  const INTERVIEWS: Interview[] = [
    ["Tom Weiss", "omar", "2026-10-22T15:00:00Z", 3],
    ["Tom Weiss", "kim", "2026-10-23T16:00:00Z", 4],
    ["Tom Weiss", "priya", "2026-10-27T15:00:00Z"], // 8e: Priya's scorecard, due today
    ["Grace Kim", "priya", "2026-10-21T15:00:00Z", 3],
    ["Grace Kim", "maya", "2026-10-22T17:00:00Z", 4],
    ["Grace Kim", "omar", "2026-10-24T15:00:00Z"], // 8d: 1 scorecard left
  ];
  for (const [name, interviewer, when, score] of INTERVIEWS)
    await s.add("wade", cap, "interviews", { candidate: candidate.get(name), interviewer: s.p(interviewer), when, score }, "2026-10-20T18:35:00Z");

  // 9a: Leo Grant goes Offer → Hired; his hiring manager is Dev. The hand-off starts his plan in Onboarding.
  await s.move("dev", candidate.get("Leo Grant")!, "hired", "2026-10-21T09:40:21Z");

  // 9a: Priya added Jordan Lee by hand.
  await s.add("priya", cap, "candidates", { name: "Jordan Lee", opening: opening.get("Senior backend"), source: "inbound" }, "2026-10-21T09:12:40Z");
  return cap;
}
