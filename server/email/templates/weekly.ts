import { edition } from "@/edition";
import type { Weekly, WeeklyLine } from "@/server/kernel/weekly";
import type { Email } from "../send";
import { markImg } from "./header";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// What changed this week (m34-a; a quiet week m34-a2), from the kernel's summary in fixed words.
export function weeklyEmail(e: { to: string; firstName: string; company: string; subdomain: string; mark: string; week: Weekly }): Email {
  const w = e.week;
  const subject = w.quiet ? `A quiet week at ${e.company}, ${w.range}` : `What changed at ${e.company}, ${w.range}`;
  const opening = w.quiet
    ? `Good morning ${e.firstName}, nothing changed in Bike last week, ${w.days}: no rows were added or moved and no rules ran.`
    : `Good morning ${e.firstName}, here is what changed in Bike last week, ${w.days}.`;
  const audit = edition.workspaceUrl(e.subdomain, "/audit");
  const link = (r: Weekly["waiting"][number]) => edition.workspaceUrl(e.subdomain, `/c/${r.capabilityId}?sheet=${r.sheetId}&row=${r.rowId}`);
  const footer = `You get this every Monday as an admin of ${e.company}. Bike counts it from the Audit log, for the apps you can see.`;

  const sections: { head: string; lines: WeeklyLine[] | string; rows?: Weekly["waiting"] }[] = [];
  if (w.added.length) sections.push({ head: "Added and moved", lines: w.added });
  if (w.rules) sections.push({ head: "Rules", lines: w.rules });
  if (w.stopped.length) sections.push({ head: "Stopped", lines: w.stopped });
  if (w.waiting.length) sections.push({ head: "Waiting longest", lines: [], rows: w.waiting });

  const text = [
    opening,
    ...sections.flatMap((s) => [
      "",
      s.head,
      ...(typeof s.lines === "string" ? [s.lines] : s.lines.map((l) => `${l.app}  ${l.text}`)),
      ...(s.rows ?? []).map((r) => `${r.app}  ${r.title} · ${r.text}\n${link(r)}`),
    ]),
    "",
    `Open the Audit log: ${audit}`,
    "",
    footer,
  ].join("\n");

  const td = "padding:10px 0;border-bottom:1px solid #E3E6EA;vertical-align:top";
  const table = (cells: [string, string][]) =>
    `<table style="width:100%;border-collapse:collapse;font-size:15.5px;line-height:1.45">${cells
      .map(([a, b]) => `<tr><td style="${td};color:#62748E;white-space:nowrap;padding-right:22px">${a}</td><td style="${td}">${b}</td></tr>`)
      .join("")}</table>`;
  const body = sections
    .map((s) => {
      const head = `<p style="margin:22px 0 4px;font-size:15px;font-weight:600">${esc(s.head)}</p>`;
      if (typeof s.lines === "string") return `${head}<p style="margin:0;font-size:15.5px;line-height:1.55">${esc(s.lines)}</p>`;
      if (s.rows)
        return head + table(s.rows.map((r) => [esc(r.app), `<a href="${link(r)}" style="color:#0F172B;text-decoration:none"><b style="font-weight:500">${esc(r.title)}</b> · ${esc(r.text)}</a>`]));
      return head + table(s.lines.map((l) => [esc(l.app), esc(l.text)]));
    })
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:600px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<div style="margin:0 0 20px">${markImg(e.mark)}</div>
<p style="margin:0;font-size:15.5px;line-height:1.55">${esc(opening)}</p>
${body}
<a href="${audit}" style="display:inline-block;margin-top:20px;padding:8px 16px;border-radius:6px;background:#1E90FF;color:#FFFFFF;font-size:16px;font-weight:500;text-decoration:none">Open the Audit log</a>
<p style="margin:20px 0 0;font-size:15px;line-height:1.6;color:#62748E">${esc(footer)}</p>
</div>
<p style="margin:24px 0 0;text-align:center;font-size:15px"><a href="https://bikeapp.si/privacy" style="color:#62748E;text-decoration:none">Privacy</a>&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://bikeapp.si/terms" style="color:#62748E;text-decoration:none">Terms</a></p>
</div></body></html>`;
  return { to: e.to, subject, text, html };
}
