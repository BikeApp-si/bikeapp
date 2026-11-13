// C1's Customize requests (stand-ins written for the pilot's Sales leads messages, which weren't kept, and the
// same kind of request on other capabilities). Recorded by scripts/ai-record.ts in this order, each capability's
// in its own chat; replayed by server/chat/customize-c1.test.ts. Each must end in a preview that applies, or one
// question whose every choice applies, or (Hiring, at its limit of sheets) a refusal in plain words.

export const C1 = {
  // Sales leads, where Lead owners see only their own leads: five ways of asking for companies.
  salesLeads: [
    "Add a Companies sheet",
    "Track the companies our leads work at, with their website and industry",
    "I need a list of companies, and each lead should be linked to its company",
    "Add companies. Only sales managers should see them.",
    "Each lead owner should see the companies they added, and nobody else's",
  ],
  // Onboarding, where managers see their own hires' plans: a sheet that hangs off a plan.
  onboarding: "Add an Equipment sheet for each new hire's laptop and accounts. Managers should see their own hires' equipment.",
  // Hiring, brought to its 6 sheets (tests/at-limit.ts): asked twice, the second answer can't be the first again.
  hiring: "Add an Offers sheet",
} as const;
