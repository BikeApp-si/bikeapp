import { edition } from "@/edition";
import type { Email } from "../send";
import { markImg } from "./header";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type NotifyPayload = { message: string; capabilityId: string; capability: string; sheet: string; rowId: string; row: string };

// A rule's notify action: its message about one row, with a link to that row on the person's workspace.
export function notifyEmail(e: { to: string; subdomain: string; mark: string; payload: NotifyPayload }): Email {
  const p = e.payload;
  const link = edition.workspaceUrl(e.subdomain, `/c/${p.capabilityId}?sheet=${p.sheet}&row=${p.rowId}`);
  const subject = `${p.capability} · ${p.row}`;
  const text = [p.message, "", `${p.capability} · ${p.row}`, link].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<div style="margin:0 0 20px">${markImg(e.mark)}</div>
<p style="margin:0;font-size:16px;line-height:1.5">${esc(p.message)}</p>
<p style="margin:12px 0 0;font-size:15px;color:#62748E">${esc(p.capability)} · <a href="${link}" style="color:#0F172B">${esc(p.row)}</a></p>
<a href="${link}" style="display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#1E90FF;color:#FFFFFF;font-size:16px;font-weight:500;text-decoration:none">Open Bike</a>
</div></div></body></html>`;
  return { to: e.to, subject, text, html };
}
