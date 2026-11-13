import { edition } from "@/edition";
import type { MorningItem } from "@/server/kernel/morning";
import type { Email } from "../send";
import { markImg } from "./header";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// What an item asks, as 8i writes it: "Interview · your scorecard, due today", "Submitted · approve or decline".
export function itemLine(i: MorningItem, today: string): string {
  const where = i.step ?? i.rowName;
  const ask = i.label ? i.label.charAt(0).toLowerCase() + i.label.slice(1) : "";
  const due = i.due === today ? ", due today" : "";
  return ask ? `${where} · ${ask}${due}` : `${where}${due}`;
}

// Screen 8i. Each item opens its row on the person's own workspace address.
export function morningEmail(e: { to: string; firstName: string; company: string; subdomain: string; mark: string; date: string; items: MorningItem[] }): Email {
  const n = e.items.length;
  const subject = `${n} ${n === 1 ? "thing waits" : "things wait"} on you at ${e.company}`;
  const link = (i: MorningItem) => edition.workspaceUrl(e.subdomain, `/c/${i.capabilityId}?sheet=${i.sheetId}&row=${i.rowId}`);
  const footer = "You get this email on mornings when something waits on you; on other days there is none. Each item opens the row in Bike.";
  const text = [
    `Good morning ${e.firstName}, here is what waits on you in Bike today.`,
    "",
    ...e.items.map((i) => `${i.capability}  ${i.title}  ${itemLine(i, e.date)}\n${link(i)}`),
    "",
    `Open Bike: ${edition.workspaceUrl(e.subdomain, "/home")}`,
    "",
    footer,
  ].join("\n");

  const rows = e.items
    .map(
      (i) => `<tr>
<td style="padding:10px 0;border-bottom:1px solid #E3E6EA;color:#62748E;white-space:nowrap;padding-right:24px">${esc(i.capability)}</td>
<td style="padding:10px 0;border-bottom:1px solid #E3E6EA;white-space:nowrap;padding-right:24px"><a href="${link(i)}" style="color:#0F172B;text-decoration:none">${esc(i.title)}</a></td>
<td style="padding:10px 0;border-bottom:1px solid #E3E6EA"><a href="${link(i)}" style="color:#0F172B;text-decoration:none">${esc(itemLine(i, e.date))}</a></td>
</tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#0F172B">
<div style="max-width:600px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:28px 32px">
<div style="margin:0 0 20px">${markImg(e.mark)}</div>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">Good morning ${esc(e.firstName)}, here is what waits on you in Bike today.</p>
<table style="width:100%;border-collapse:collapse;font-size:16px;line-height:1.4">${rows}</table>
<a href="${edition.workspaceUrl(e.subdomain, "/home")}" style="display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#1E90FF;color:#FFFFFF;font-size:16px;font-weight:500;text-decoration:none">Open Bike</a>
<p style="margin:20px 0 0;font-size:15px;line-height:1.6;color:#62748E">${footer}</p>
</div>
<p style="margin:24px 0 0;text-align:center;font-size:15px"><a href="https://bikeapp.si/privacy" style="color:#62748E;text-decoration:none">Privacy</a>&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://bikeapp.si/terms" style="color:#62748E;text-decoration:none">Terms</a></p>
</div></body></html>`;
  return { to: e.to, subject, text, html };
}
