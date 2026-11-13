// Makes the two policy PDFs the Step 5 screens attach (5e, 5j): synthetic Fernwood documents, until real
// document packs arrive. Usage: pnpm exec tsx tests/files/make-policies.ts
import { chromium } from "@playwright/test";

const page = (title: string, body: string) => `<section><h2>${title}</h2>${body}</section>`;
const doc = (title: string, pages: string[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Georgia,serif;font-size:13pt;line-height:1.55;margin:0;color:#111}
section{break-after:page}section:last-child{break-after:auto}h1{font-size:20pt}h2{font-size:15pt;margin-top:0}p,li{margin:0 0 8pt}
</style></head><body>${pages.map((p, i) => (i ? p : p.replace("<section>", `<section><h1>${title}</h1>`))).join("")}</body></html>`;

const CONTRACTS = doc("Fernwood Labs — Customer contract policy", [
  page(
    "1. Customer tiers and notice",
    `<p>Every customer contract is either <b>Standard</b> or <b>Enterprise</b>. Enterprise customers are those on a yearly value of $50,000 or more, or with a signed Enterprise order form.</p>
<p>Notice periods: Enterprise contracts need 90 days' notice before they renew or end. Standard contracts need 30 days' notice.</p>
<p>Every contract has one owner at Fernwood, who looks after the customer and the renewal.</p>`,
  ),
  page(
    "2. Approvals and renewals",
    `<p>Contracts over $50,000 a year go to legal review before they are signed. Lena Ortiz does the legal review and approves it or sends it back.</p>
<p>The owner is reminded 90 days before a contract's notice date, so there is time to agree the renewal.</p>
<p>Ending a contract over $50,000 needs the founder's approval before it is ended.</p>`,
  ),
  page(
    "3. New customers",
    `<p>Before a new customer signs, we run a credit check through our credit bureau service, and the result is kept with the contract.</p>
<p>Questions about this policy go to Krishna in Operations.</p>`,
  ),
]);

const PURCHASING = doc("Fernwood Labs — Purchasing policy", [
  page("1. Scope", `<p>This policy covers everything Fernwood buys from suppliers: equipment, software and services. It applies to every team.</p><p>Each purchase is requested in Spend and approved before it is ordered.</p>`),
  page(
    "2. Matching bills",
    `<p>When goods or services arrive, Spend records the quantity received on each purchase line.</p>
<p>Every supplier bill is matched to the purchase it pays for and to what we received. If every line agrees with the purchase and what was received within 2%, the bill is matched.</p>
<p>When a line doesn't match exactly, Finance (Lena Ortiz) finds the closest purchase line, notes why, and confirms the match.</p>`,
  ),
  page(
    "3. Approving and paying",
    `<p>Bills over $2,000 are approved by Krishna before they can be paid. Bills of $2,000 or less are paid once matched.</p>
<p>Nothing is paid until it matches. A received purchase waits at a Billed step until its bill is paid; then it moves to Billed, and the amount counts against the budget it belongs to.</p>`,
  ),
  page("4. Budgets", `<p>Each team has a quarterly budget in Tools and budgets. Paid bills count against the team's budget for the quarter in which they are paid.</p>`),
  page("5. Suppliers", `<p>New suppliers are added by Finance. We prefer suppliers who bill electronically and quote a purchase number on each bill.</p>`),
  page("6. Records", `<p>Bills and receipts are kept for seven years. Questions about this policy go to Lena Ortiz.</p>`),
]);

const browser = await chromium.launch();
const tab = await browser.newPage();
for (const [file, html] of [["tests/files/Fernwood-contract-policy.pdf", CONTRACTS], ["tests/files/Purchasing policy.pdf", PURCHASING]] as const) {
  await tab.setContent(html);
  await tab.pdf({ path: file, format: "A4", margin: { top: "20mm", bottom: "20mm", left: "20mm", right: "20mm" } });
  console.log(`Wrote ${file}`);
}
await browser.close();
