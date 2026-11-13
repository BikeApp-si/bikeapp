// The worked example from developer notes §8 (prompt 2), in the shape the prompts answer in. It shows the
// judgment and the shape; it is never copied for another request.

const col = (name: string, type: string, more: Record<string, unknown> = {}) => ({
  name, type, required: false, default: null, options: [], link: null, formula: null, result: null, ...more,
});
const step = (name: string, more: Record<string, unknown> = {}) => ({ name, start: false, end: null, button: null, only_when: null, move_out: "anyone", move_in: "anyone", ...more });

export const DESIGN_EXAMPLE = {
  input: "Wade Wilson (admin) at Fernwood Labs, with Hiring, Onboarding, Time off, Spend and Tools and budgets: “We need to keep track of customer contracts and get reminded well before they renew. Krishna and I look after all of them.”",
  output: {
    type: "new_capability",
    lead: "None of your 5 apps track contracts, so I’ve planned a new one, **Customer contracts**.",
    brief:
      "Each contract gets a row with its customer, yearly value, start and renewal dates, notice period, owner and signed file. It moves through 5 steps, from Draft to Renewed or Ended. 60 days before the notice date the owner is reminded by email, and if nobody acts you’re told 30 days before.",
    left_out: null,
    question: null,
    capability: {
      name: "Customer contracts",
      icon: "file-pen-line",
      sheets: [
        {
          name: "Contracts", kind: "list", parent_sheet: null, title_column: "Customer", row_one: "contract", row_many: "contracts", add_action: "New contract",
          columns: [
            col("Customer", "text", { required: true }),
            col("Value a year", "money", { required: true }),
            col("Start", "date"),
            col("Renews on", "date", { default: { kind: "formula", value: '{"op":"date_add","args":[{"col":"Start"},1,"years"]}' } }),
            col("Notice", "days", { default: { kind: "value", value: "30" } }),
            col("Notice date", "computed", { result: "date", formula: '{"op":"date_add","args":[{"col":"Renews on"},{"op":"mul","args":[{"col":"Notice"},-1]},"days"]}' }),
            col("Owner", "person", { default: { kind: "creator", value: null } }),
            col("Signed contract", "file"),
            col("Status", "step"),
          ],
          steps: [step("Draft", { start: true }), step("Signed"), step("Active"), step("Renewal due"), step("Renewed", { end: "final", button: "Mark renewed" }), step("Ended", { end: "exit", button: "End contract" })],
        },
      ],
      roles: [
        { name: "Contract managers", people: ["wade@fernwood.dev", "krishna@fernwood.dev"], person_column: null, everyone: false, can: ["see", "add", "edit", "delete", "move_steps", "customize"], scope: "all", scope_columns: [], sheets: null },
        { name: "Contract owners", people: [], person_column: { sheet: "Contracts", column: "Owner" }, everyone: false, can: ["see", "edit", "move_steps"], scope: "own", scope_columns: [{ sheet: "Contracts", column: "Owner", via: null }], sheets: null },
      ],
      later: ["A Contacts sheet linked to each contract", "An AI step that reads signed PDFs into the row"],
    },
    rule_requests: [
      "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
      "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.",
    ],
    rules_from: null,
    suggested_connections: ["At Renewal due, start a renewal request in Spend."],
    also_changes: [],
    experience: {
      intro: "You and Krishna manage every contract. Each contract’s owner works only on their own. Everyone else in Fernwood Labs won’t see Customer contracts at all.",
      rows: [
        { who: "You and Krishna", sees: "Customer contracts in the sidebar, every contract and the summary", can_do: "Add, edit and move any contract; change how it works" },
        { who: "Contract owners", sees: "Customer contracts in the sidebar, only the contracts they own", can_do: "Edit and move their own contracts; upload the signed file" },
        { who: "Everyone else", sees: "Nothing; the app is hidden", can_do: "Nothing. You can give someone access later in Customize" },
      ],
    },
    flags: [],
  },
};

const act = (a: Record<string, unknown>) => ({
  kind: null, step: null, target: null, via: null, map: [], people: [], columns: [], message: null, person: null, column: null, manager_of: null, until: null, label: null, decision: null, question: null, answer_column: null, ...a,
});

export const LOGIC_EXAMPLE = {
  sentences: DESIGN_EXAMPLE.output.rule_requests,
  output: {
    rules: [
      {
        capability: "Customer contracts", sheet: "Contracts",
        text: "60 days before a contract’s notice date, move it to Renewal due and remind its owner.",
        when: "60 days before a contract’s notice date", then: "It moves to Renewal due and its owner is reminded",
        trigger: { kind: "date_reached", step: null, field: null, date: "Notice date", offset_days: -60 },
        condition: null,
        actions: [
          act({ kind: "ask_person", step: "Renewal due", column: "Owner", label: "Decide on the renewal" }),
          act({ kind: "notify", columns: ["Owner"], message: "This contract is due for renewal." }),
        ],
      },
      {
        capability: "Customer contracts", sheet: "Contracts",
        text: "30 days before the notice date, if it is still in Renewal due, tell Wade and the owner.",
        when: "30 days before the notice date, while it is in Renewal due", then: "Wade and the owner are told",
        trigger: { kind: "date_reached", step: null, field: null, date: "Notice date", offset_days: -30 },
        condition: '{"op":"eq","args":[{"col":"Status"},"Renewal due"]}',
        actions: [act({ kind: "notify", people: ["wade@fernwood.dev"], columns: ["Owner"], message: "This contract is still waiting for a renewal decision." })],
      },
    ],
    could_not: [],
  },
};
