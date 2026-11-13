import { formatCode } from "@/server/auth/code";
import type { Email } from "../send";
import { markImg } from "./header";

export type CodeEmail = {
  to: string;
  firstName: string;
  company: string;
  code: string;
  browser: string | null;
  os: string | null;
  city: string | null;
  at: Date;
  timeZone: string;
  mark: string; // markUrl(): the company's logo, or Bike's B
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// "Sign-in from Chrome on macOS, Austin, TX, at 5:34 pm."
export function signInFrom(e: Pick<CodeEmail, "browser" | "os" | "city" | "at" | "timeZone">): string {
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: e.timeZone })
    .format(e.at)
    .replace(/\s?AM$/, " am")
    .replace(/\s?PM$/, " pm");
  const device = [e.browser, e.os].filter(Boolean).join(" on ");
  const where = [device, e.city].filter(Boolean).join(", ");
  return where ? `Sign-in from ${where}, at ${time}.` : `Sign-in at ${time}.`;
}

// Screen 1e.
export function codeEmail(e: CodeEmail): Email {
  const code = formatCode(e.code);
  const from = signInFrom(e);
  const text = [
    `Hi ${e.firstName}, here is your code to sign in to ${e.company}:`,
    "",
    code,
    "",
    `It expires in 10 minutes and works once. ${from}`,
    "Not you? You can ignore this email; nobody can sign in without the code.",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#F8FAFC;font-family:Geist,Inter,system-ui,sans-serif;color:#09090B">
<div style="max-width:520px;margin:0 auto;padding:32px 16px">
<div style="background:#FFFFFF;border:1px solid #E3E6EA;border-radius:12px;padding:32px">
${markImg(e.mark)}
<p style="margin:24px 0 0;font-size:16px;line-height:1.5">Hi ${esc(e.firstName)}, here is your code to sign in to <b style="font-weight:500">${esc(e.company)}</b>:</p>
<div style="display:inline-block;margin:20px 0 0;padding:14px 20px;border-radius:8px;background:#F1F5F9;font-family:'Geist Mono',ui-monospace,monospace;font-size:32px;font-weight:500;letter-spacing:.18em">${code}</div>
<p style="margin:20px 0 0;font-size:15px;line-height:1.6;color:#62748E">It expires in 10 minutes and works once. ${esc(from)}<br>Not you? You can ignore this email; nobody can sign in without the code.</p>
</div></div></body></html>`;

  return { to: e.to, subject: `Your Bike code: ${code}`, text, html };
}
