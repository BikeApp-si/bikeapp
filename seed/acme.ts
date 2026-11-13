import type { PersonInput } from "@/server/kernel/people";

// A second, small workspace used only by the tenancy tests.
export const ACME = { subdomain: "acme", name: "Acme Supply", timeZone: "Europe/Ljubljana" };
export const ACME_ADMIN = { name: "Sam Reed", email: "sam@acme.test", title: "Owner", team: "Leadership", startDate: "2022-01-10" };
export const ACME_PEOPLE: PersonInput[] = [
  { name: "Tina Novak", email: "tina@acme.test", title: "Buyer", team: "Purchasing", managerEmail: "sam@acme.test", startDate: "2023-04-03" },
  { name: "Luka Horvat", email: "luka@acme.test", title: "Warehouse lead", team: "Warehouse", managerEmail: "sam@acme.test", startDate: "2024-02-12" },
];
