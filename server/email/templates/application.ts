import type { Email } from "../send";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// set: the app set whose page they came from (G2), when they came from one.
export type Application = { name: string; email: string; company: string; people: string; runsOn: string; note: string; set?: string };

const FIELDS: [keyof Application, string][] = [
  ["name", "Name"],
  ["email", "Work email"],
  ["company", "Company"],
  ["people", "How many people"],
  ["runsOn", "What they run on today"],
  ["note", "Anything else"],
  ["set", "App set"],
];

// The pilot form, sent to whoever reads applications (APPLY_TO); a reply goes to the applicant.
export function applicationEmail(a: Application, to: string): Email {
  const rows = FIELDS.filter(([k]) => a[k]);
  const text = ["A new application for the Bike pilot.", "", ...rows.map(([k, label]) => `${label}: ${a[k]}`), "", "Reply to this email to answer them."].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<p style="margin:0 0 16px;font-size:16px">A new application for the Bike pilot.</p>
<table style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5">${rows
    .map(([k, label]) => `<tr><td style="padding:8px 16px 8px 0;border-bottom:1px solid #E3E6EA;color:#62748E;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:8px 0;border-bottom:1px solid #E3E6EA;white-space:pre-wrap">${esc(a[k] ?? "")}</td></tr>`)
    .join("")}</table>
<p style="margin:16px 0 0;font-size:15px;color:#62748E">Reply to this email to answer them.</p>
</div></div></body></html>`;
  return { to, subject: `Pilot application: ${a.company}`, text, html, replyTo: a.email };
}
