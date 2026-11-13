import { edition } from "@/edition";
import type { Email } from "../send";
import { markImg } from "./header";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type ReadyPayload = { capabilityId: string; capability: string };

// The "ready" notice (5h: "I'll email you when it's ready"), in the notify email's layout. No screen of its own.
export function readyEmail(e: { to: string; subdomain: string; mark: string; payload: ReadyPayload }): Email {
  const p = e.payload;
  const link = edition.workspaceUrl(e.subdomain, `/c/${p.capabilityId}`);
  const line = `${p.capability} is ready.`;
  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<div style="margin:0 0 20px">${markImg(e.mark)}</div>
<p style="margin:0;font-size:16px;line-height:1.5">${esc(line)}</p>
<a href="${link}" style="display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#1E90FF;color:#FFFFFF;font-size:16px;font-weight:500;text-decoration:none">Open Bike</a>
</div></div></body></html>`;
  return { to: e.to, subject: line, text: [line, link].join("\n"), html };
}
