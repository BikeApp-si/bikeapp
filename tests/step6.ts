// The messages typed on screens 6b–6l, shared by the recordings (scripts/ai-record.ts) and the tests that
// replay them. Each capability's Customize chat is one conversation, so they are sent in this order.
export const STEP6 = {
  // Customer contracts (6c → 6e, 6f, 6l, 6k)
  legal: "Contracts over $50,000 need a legal review by Lena before they’re Active. Also remind owners 90 days before the notice date.",
  draftRule: "If a contract is still in Draft 14 days after it was added, remind its owner.",
  vague: "Make sure big contracts are handled properly.",
  leo: "Add Leo Grant as a contract owner for the Northwind account.",
  // Hiring (6h → 6j)
  hired: "Remove the Hired step. Offers should end at Offer accepted.",
};
