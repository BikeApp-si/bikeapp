import { edition } from "@/edition";
import type { ReportView } from "@/server/kernel/report/view";
import type { Attachment, Email } from "../send";
import { markImg } from "./header";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const frame = (mark: string, body: string) => `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<div style="margin:0 0 20px">${markImg(mark)}</div>
${body}
</div></div></body></html>`;

const button = (link: string) => `<a href="${link}" style="display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#1E90FF;color:#FFFFFF;font-size:16px;font-weight:500;text-decoration:none">Open in Bike</a>`;
const foot = (every: string) => `You get this ${every.replace(/^Every/, "every")} because you scheduled it. Stop it from the report in Bike.`;

// m33-e: a scheduled report: its title and when it ran, the table, the PDF attached, a link to the report in Bike.
export function reportEmail(e: { to: string; subdomain: string; mark: string; view: ReportView; asOf: string; read: string; every: string; pdf: Uint8Array; chatId: string }): Email {
  const v = e.view;
  const link = edition.workspaceUrl(e.subdomain, `/home?chat=${e.chatId}&report=${v.id}`);
  const line = `As of ${e.asOf} · from ${v.sources}${e.read ? ` · ${e.read}` : ""}`;
  const cell = "padding:9px 14px 9px 0;text-align:left;border-bottom:1px solid #E3E6EA;font-size:15px";
  const table = `<table style="width:100%;border-collapse:collapse;margin-top:16px"><tr>${v.table.columns.map((c) => `<th style="${cell};font-weight:600">${esc(c)}</th>`).join("")}</tr>${v.table.rows
    .map((r) => `<tr>${r.map((c) => `<td style="${cell}">${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</table>`;
  const html = frame(
    e.mark,
    `<p style="margin:0;font-size:18px;font-weight:600">${esc(v.title)}</p>
<p style="margin:4px 0 0;font-size:15px;color:#62748E">${esc(line)}</p>
${table}
<p style="margin:16px 0 0;font-size:15px;color:#62748E">The chart and how it was worked out are in the PDF.</p>
${button(link)}
<p style="margin:20px 0 0;font-size:13.5px;color:#90A1B9">${esc(foot(e.every))}</p>`,
  );
  const text = [v.title, line, "", v.table.columns.join(" · "), ...v.table.rows.map((r) => r.join(" · ")), "", "The chart and how it was worked out are in the PDF.", link, "", foot(e.every)].join("\n");
  const pdf: Attachment = { name: `${v.title}.pdf`, mime: "application/pdf", content: e.pdf };
  return { to: e.to, subject: `${v.title} · as of ${e.asOf.split(",").slice(0, 2).join(",")}`, text, html, attachments: [pdf] };
}

// A scheduled report whose query can't run any more: the plain reason, and where to change it.
export function reportRefusedEmail(e: { to: string; subdomain: string; mark: string; title: string; chatId: string; reason: string; every: string }): Email {
  const link = edition.workspaceUrl(e.subdomain, `/home?chat=${e.chatId}`);
  const say = `Bike couldn't run “${e.title}” today: ${e.reason}`;
  const html = frame(e.mark, `<p style="margin:0;font-size:16px;line-height:1.5">${esc(say)}</p>${button(link)}<p style="margin:20px 0 0;font-size:13.5px;color:#90A1B9">${esc(foot(e.every))}</p>`);
  return { to: e.to, subject: `${e.title} · couldn't run`, text: [say, "", link, "", foot(e.every)].join("\n"), html };
}
