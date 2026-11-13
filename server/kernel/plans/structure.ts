import { renderExpr } from "../expr/render";
import type { CapabilityFile, Column, Sheet } from "../schema/file";

// What the AI is told about capabilities: their structure by name, never rows and never ids. The same files
// always give the same description, so the request can be cached and replayed.

type Files = ReadonlyMap<string, CapabilityFile>;

function columnLine(c: Column, sheet: Sheet, capId: string, files: Files, personName: (id: string) => string | undefined): string {
  const bits: string[] = [c.type];
  if (c.required) bits.push("required");
  if (c.options?.length) bits.push(`choices: ${c.options.map((o) => o.name).join(", ")}`);
  if (c.link) {
    const cap = files.get(c.link.capability ?? capId);
    const target = cap?.sheets.find((s) => s.id === c.link!.sheet);
    bits.push(`links to ${c.link.capability && c.link.capability !== capId ? `${cap?.name} › ` : ""}${target?.name ?? "?"}`);
  }
  const ctx = {
    column: (id: string) => sheet.columns.find((x) => x.id === id),
    otherColumn: (sheetId: string, column: string, cap?: string) => {
      const s = files.get(cap ?? capId)?.sheets.find((x) => x.id === sheetId);
      return { sheet: s?.name ?? sheetId, column: s?.columns.find((x) => x.id === column)?.name ?? column };
    },
    otherStep: (sheetId: string, step: string, cap?: string) => files.get(cap ?? capId)?.sheets.find((x) => x.id === sheetId)?.steps?.find((x) => x.id === step)?.name,
    personName,
  };
  if (c.expr) bits.push(`worked out: ${renderExpr(c.expr, ctx)}`);
  return `${c.name} (${bits.join("; ")})`;
}

// One capability, in a few lines.
export function describeCapability(capId: string, files: Files, personName: (id: string) => string | undefined): Record<string, unknown> {
  const f = files.get(capId)!;
  return {
    name: f.name,
    sheets: f.sheets.map((s) => ({
      name: s.name,
      kind: s.kind,
      ...(s.parentSheet ? { lines_of: f.sheets.find((x) => x.id === s.parentSheet)?.name } : {}),
      columns: s.columns.map((c) => columnLine(c, s, capId, files, personName)),
      ...(s.steps?.length ? { steps: s.steps.map((st) => `${st.name}${st.start ? " (start)" : ""}${st.end ? ` (${st.end === "final" ? "last" : "exit"})` : ""}`) } : {}),
    })),
    roles: f.roles.map((r) => `${r.name}: ${r.scope === "all" ? "every row" : r.scope === "own" ? "their own rows" : "their team's rows"}`),
    rules: f.rules.map((r) => r.text),
  };
}

// Every capability in the list, in the given order.
export function describeAll(order: string[], files: Files, personName: (id: string) => string | undefined) {
  return order.filter((id) => files.has(id)).map((id) => describeCapability(id, files, personName));
}
