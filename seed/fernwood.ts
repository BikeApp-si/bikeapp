import type { PersonInput } from "@/server/kernel/people";

// Fernwood Labs as People shows it on 7f: 14 people in 5 teams.
// Leo and Aisha were imported with a manager email that isn't in People (the .com address from the template),
// so 7f shows "No manager" for them.
export const FERNWOOD = { subdomain: "fernwood", name: "Fernwood Labs", timeZone: "America/Chicago" };

// The same company before Step 5 (5a–5j): its people and five capabilities, without Customer contracts, for
// creating Customer contracts and Supplier bills from chat. Its own workspace, so Fernwood stays as it is.
export const FERNWOOD_NEW = { subdomain: "fernwood-new", name: "Fernwood Labs", timeZone: "America/Chicago" };

// The same company with only its founder, before anything is built: Step 4 builds it from the synthetic pack
// (4a–4d). Seeded as the recordings were (scripts/ai-record.ts), so Playwright replays them.
export const FERNWOOD_PACK = { subdomain: "fernwood-pack", name: "Fernwood Labs", timeZone: "America/Chicago" };

// Set up on the morning of Aug 12, before Customer contracts was created from chat that afternoon.
export const FERNWOOD_TIMES = { created: "2026-08-12T08:58:20Z", imported: "2026-08-12T09:01:55Z", lenaAdmin: "2026-08-12T09:04:10Z" };

export const FERNWOOD_ADMIN = { name: "Wade Wilson", email: "wade@fernwood.dev", title: "Founder", team: "Leadership", startDate: "2023-03-01" };

export const FERNWOOD_PEOPLE: PersonInput[] = [
  { name: "Priya Nair", email: "priya@fernwood.dev", title: "Engineering lead", team: "Engineering", managerEmail: "wade@fernwood.dev", startDate: "2024-03-02" },
  { name: "Maya Chen", email: "maya@fernwood.dev", title: "Backend engineer", team: "Engineering", managerEmail: "priya@fernwood.dev", startDate: "2024-06-10" },
  { name: "Omar Ali", email: "omar@fernwood.dev", title: "Frontend engineer", team: "Engineering", managerEmail: "priya@fernwood.dev", startDate: "2024-08-05" },
  { name: "Kim Tran", email: "kim@fernwood.dev", title: "Platform engineer", team: "Engineering", managerEmail: "priya@fernwood.dev", startDate: "2026-10-20" },
  { name: "Ana Ruiz", email: "ana@fernwood.dev", title: "Senior backend engineer", team: "Engineering", managerEmail: "priya@fernwood.dev", startDate: "2026-11-02" },
  { name: "Dev Kumar", email: "dev@fernwood.dev", title: "Growth lead", team: "Growth", managerEmail: "wade@fernwood.dev", startDate: "2024-04-15" },
  { name: "Rita Gomez", email: "rita@fernwood.dev", title: "Account manager", team: "Growth", managerEmail: "dev@fernwood.dev", startDate: "2024-09-09" },
  { name: "Leo Grant", email: "leo@fernwood.dev", title: "Sales executive", team: "Growth", managerEmail: "dev@fernwood.com", startDate: "2026-11-10" },
  { name: "Nina Park", email: "nina@fernwood.dev", title: "Marketing manager", team: "Growth", managerEmail: "dev@fernwood.dev", startDate: "2025-02-03" },
  { name: "Krishna", email: "krishna@fernwood.dev", title: "Operations", team: "Operations", managerEmail: "wade@fernwood.dev", startDate: "2023-05-06" },
  { name: "Jon Bell", email: "jon@fernwood.dev", title: "IT and office", team: "Operations", managerEmail: "krishna@fernwood.dev", startDate: "2025-01-13" },
  { name: "Aisha Khan", email: "aisha@fernwood.dev", title: "People partner", team: "Operations", managerEmail: "krishna@fernwood.com", startDate: "2025-07-01" },
  { name: "Lena Ortiz", email: "lena@fernwood.dev", title: "Accountant, part time", team: "Finance", managerEmail: "krishna@fernwood.dev", startDate: "2025-03-03" },
];
