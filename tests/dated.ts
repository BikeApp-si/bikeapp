// The messages for sheets kept by date (0.5, M30), shared by the recordings (scripts/ai-record.ts, E2E_RECORD=1) and
// the tests that replay them: Customize on Spend (tests/e2e/dated.spec.ts), and a price list as a new capability from
// Home's chat (server/chat/dated.replay.test.ts).
export const DATED = {
  customize: "Keep spending limits for each category, each with the date it starts. An expense can't be over its category's limit in force on its date.",
  build: "Sell from a price list: products, each product's price from the date it starts, and quotes that show the price in force on the quote's date.",
};
