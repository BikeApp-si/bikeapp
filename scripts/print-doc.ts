// Prints an HTML document in docs/ to a PDF beside it, A4, as the browser would (the page's own @page margins).
// Usage: pnpm exec tsx scripts/print-doc.ts docs/sales/infrastructure.html docs/sales/bike-infrastructure.pdf
import path from "node:path";
import { chromium } from "@playwright/test";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Usage: tsx scripts/print-doc.ts <file.html> <file.pdf>");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${path.resolve(from)}`);
await page.pdf({ path: to, format: "A4", preferCSSPageSize: true, printBackground: true });
await browser.close();
console.log(`→ ${to}`);
