// C2's Customize messages, on a Fernwood with Sales leads (Lead owners see their own leads). Recorded by
// scripts/ai-record.ts in this order, in one chat; replayed by server/chat/customize-c2.test.ts and, the first two, by
// tests/e2e/customize.spec.ts. A question gets a guide answer that changes nothing; a button goes to the planner.

export const C2 = {
  steps: "How can I add a company sheet? Tell me the steps.",
  // Then the guide's first suggestion is pressed: a preview, not applied.
  noOwner: "Add a Companies sheet with just a name and a website. No owner.",
  // Applied; then:
  why: "Why can't lead owners see companies?",
  slack: "Can Bike send a Slack message when a lead is won?",
  unsure: "Companies?",
} as const;
