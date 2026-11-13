import { TEAM_TEMPLATE, TEAM_TEMPLATE_NAME } from "@/lib/team-template";

// 2g: "Download CSV template" on the team step. The same file for everyone; it holds no workspace data.
export function GET() {
  return new Response(TEAM_TEMPLATE, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${TEAM_TEMPLATE_NAME}"` },
  });
}
