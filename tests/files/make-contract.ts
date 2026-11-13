// Makes the signed contract 7c's "Drop the signed PDF" reads: a synthetic Fernwood customer agreement, one
// page. Deterministic. Usage: pnpm exec tsx tests/files/make-contract.ts
import { chromium } from "@playwright/test";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Georgia,serif;font-size:12.5pt;line-height:1.55;margin:0;color:#111}h1{font-size:19pt}td{padding:3pt 14pt 3pt 0;vertical-align:top}
</style></head><body>
<h1>Subscription agreement</h1>
<p>This agreement is between <b>Fernwood Labs, Inc.</b>, 210 Congress Ave, Austin, TX ("Fernwood") and <b>Juniper Health</b>, 41 Mill Street, Denver, CO ("the Customer").</p>
<table>
<tr><td>Customer</td><td>Juniper Health</td></tr>
<tr><td>Annual subscription fee</td><td>$42,000 per year, billed yearly in advance</td></tr>
<tr><td>Start date</td><td>November 1, 2026</td></tr>
<tr><td>Initial term</td><td>12 months, renewing for further 12-month terms</td></tr>
<tr><td>Notice to end</td><td>60 days before the end of a term, in writing</td></tr>
<tr><td>Fernwood account owner</td><td>Krishna Iyer</td></tr>
</table>
<p>The Customer may use Fernwood CI for up to 40 seats. Fees are due within 30 days of each invoice.</p>
<p>Signed for Fernwood Labs: Wade Wilson, Founder, October 24, 2026.<br>Signed for Juniper Health: Dana Ruiz, COO, October 24, 2026.</p>
</body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.setContent(HTML);
await tab.pdf({ path: "tests/files/Juniper Health signed contract.pdf", format: "A4", margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" } });
console.log("Wrote tests/files/Juniper Health signed contract.pdf");
await browser.close();
