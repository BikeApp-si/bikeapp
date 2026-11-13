// The messages for ledgers (0.5, M29), shared by the recordings (scripts/ai-record.ts, E2E_RECORD=1) and the tests
// that replay them: Customize on Time off (tests/e2e/ledger.spec.ts), and Stock as a new capability from Home's chat
// (server/chat/ledger.replay.test.ts).
export const LEDGERS = {
  customize: "Keep leave in a ledger: an approved request takes its days off as an entry, and Left counts the entries.",
  build: "Track office equipment: items, and moves in and out. Stock can't go below zero.",
};
