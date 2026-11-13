import { chromium } from "playwright-core";
import { ReportChart } from "@/components/chat/report-chart";
import type { ReportView } from "@/server/kernel/report/view";

// 11h: the report as a PDF, printed by headless Chromium from the same chart and table as the panel: title,
// where it comes from, who made it and when, the chart, the table with its total, how it was worked out, and
// the workspace's address at the foot.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function reportHtml(v: ReportView, made: { by: string; workspace: string; address: string }): Promise<string> {
  // Loaded here: Next keeps react-dom/server out of what routes import.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const t = v.print;
  const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  const total = t.total ? `<tr class="total">${t.total.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:22mm 18mm}
body{font-family:Geist,-apple-system,system-ui,sans-serif;color:#0F172B;font-size:11pt;margin:0}
.ws{display:flex;align-items:center;gap:8px;font-weight:600}.ws b{display:inline-flex;width:22px;height:22px;border-radius:5px;background:#0F172B;color:#fff;align-items:center;justify-content:center;font-size:11pt}
h1{font-size:20pt;margin:18px 0 2px}.line{color:#62748E;font-size:10pt;margin-bottom:14px}
table{width:100%;border-collapse:collapse;margin-top:14px}th{text-align:left;font-weight:600;border-bottom:1px solid #90A1B9;padding:6px 8px 6px 0}
td{border-bottom:1px solid #E3E6EA;padding:6px 8px 6px 0}tr.total td{font-weight:600}
.how{margin-top:18px;font-size:10pt;line-height:1.55}.how b{display:block;margin-bottom:2px}
footer{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-between;color:#90A1B9;font-size:8.5pt}
</style></head><body>
<div class="ws"><b>${esc(made.workspace.charAt(0))}</b>${esc(made.workspace)}</div>
<h1>${esc(v.title)}</h1>
<div class="line">${v.period ? `${esc(v.period)} · ` : ""}from ${esc(v.sources)} · made by ${esc(made.by)} on ${esc(v.ranOn)}</div>
${renderToStaticMarkup(<ReportChart chart={v.chart} compact />)}
<table><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table>
<div class="how"><b>How it was worked out</b>${v.how.map((h) => `<div>${esc(h)}</div>`).join("")}</div>
<footer><span>${esc(made.workspace)} · ${esc(made.address)}</span><span>Page 1 of 1</span></footer>
</body></html>`;
}

export async function reportPdf(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return new Uint8Array(await page.pdf({ format: "A4", printBackground: true }));
  } finally {
    await browser.close();
  }
}
