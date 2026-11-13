import { ask } from "@/server/ai/gateway";
import { importMapping } from "@/server/ai/prompts/import-mapping@1";
import { checkTeamRows, TEAM_CSV_HEADERS, type ImportCheck } from "@/server/kernel/people";

// A team file read by the CSV rules (2d, and People in a build, 4c). Headers other than the template's go
// through prompt 2b's mapping first; the kernel then checks every row.
export async function checkTeamFile(name: string, table: string[][], who: { workspaceId: string; personId: string; chatId?: string }): Promise<ImportCheck> {
  const check = checkTeamRows(table);
  const isTemplate = (h: string) => TEAM_CSV_HEADERS.some((t) => t.toLowerCase() === h.trim().toLowerCase());
  const others = table[0]!.filter((h) => h.trim() && !isTemplate(h));
  const missing = TEAM_CSV_HEADERS.filter((t) => !table[0]!.some((h) => isTemplate(h) && h.trim().toLowerCase() === t.toLowerCase()));
  if (!others.length || !missing.length) return check;
  const [header, ...lines] = table;
  const mapped = await ask(
    importMapping,
    { target: { capability: "People", sheet: "Team", columns: TEAM_CSV_HEADERS.map((h) => ({ name: h, type: h.includes("email") ? "email" : h === "Start date" ? "date" : "text" })) }, file: { name, header: header!, sample: lines.slice(0, 20) } },
    who,
    { check: (o) => o.mapping.filter((m) => !TEAM_CSV_HEADERS.includes(m.to as never)).map((m) => `"${m.to}" isn't a column of the team.`), building: false },
  );
  const renamed = header!.map((h) => mapped.mapping.find((m) => m.from === h)?.to ?? h);
  return checkTeamRows([renamed, ...lines]);
}
