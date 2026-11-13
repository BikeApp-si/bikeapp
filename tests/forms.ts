// What an admin says in Customize to change a form (0.3, M17b). The flow in tests/e2e/customize-form.spec.ts says
// these, in this order, on fernwood-17; their answers are recorded once with E2E_RECORD=1.
export const FORMS = {
  split: "Split the contract form into Basics, Dates and Documents.",
  askStart: "Also ask for the start date when a contract is added.",
  onlyTwo: "Only ask for the customer and the value when a contract is added.",
  receipt: "Ask for a receipt only when the amount is over $75.",
} as const;
