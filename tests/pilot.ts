// The admin pilot (tests/e2e/pilot-admin.spec.ts): one company from sign-up to its first report, with the
// synthetic pack. Fixed words and address, so the recorded answers replay (record them with
// E2E_RECORD=1 pnpm exec playwright test tests/e2e/pilot-admin.spec.ts).
export const PILOT = {
  who: { name: "Wade Wilson", email: "wade@fernwood.dev", company: "Fernwood Labs", sub: "pilot" },
  customize: "Remind owners 90 days before the notice date instead of 60.",
  report: "Show expenses by category for October.",
};
