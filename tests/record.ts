import { contractsFile } from "@/server/kernel/fixtures";
import type { CapabilityFile, Rule } from "@/server/kernel/schema/file";

// Customer contracts with what points at a contract (0.4, M22): Renewals (owners see those of their own contracts) and
// Contacts (managers only), and a rule that moves a signed contract on to Active.
export function recordFile(managers: string[]): CapabilityFile {
  const f = contractsFile(managers);
  f.sheets.push(
    {
      id: "renewals",
      name: "Renewals",
      kind: "list",
      row: { one: "renewal", many: "renewals" },
      titleColumn: "contract",
      columns: [
        { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" }, required: true },
        { id: "due", name: "Due", type: "date" },
        { id: "new_value", name: "New value a year", type: "money" },
      ],
    },
    {
      id: "contacts",
      name: "Contacts",
      kind: "list",
      row: { one: "contact", many: "contacts" },
      titleColumn: "name",
      columns: [
        { id: "contract", name: "Contract", type: "link", link: { sheet: "contracts" }, required: true },
        { id: "name", name: "Name", type: "text", required: true },
        { id: "email", name: "Email", type: "email" },
      ],
    },
  );
  const owners = f.roles.find((r) => r.id === "owners")!;
  owners.sheets = ["contracts", "renewals"];
  owners.scopeColumns = { contracts: { column: "owner" }, renewals: { column: "owner", via: "contract" } };
  f.rules = [
    {
      id: "on_to_active",
      text: "When a contract is signed, move it on to Active.",
      reading: { when: "w", then: "t" },
      enabled: true,
      trigger: { kind: "enters_step", sheet: "contracts", step: "signed" },
      actions: [{ kind: "move_to_step", step: "active" }],
    } as unknown as Rule,
  ];
  return f;
}
