import nodemailer, { type Transporter } from "nodemailer";
import { edition } from "@/edition";

// replyTo: where a reply goes; the edition's address unless the email says otherwise (an application: the applicant).
// attachments: files sent with it (a scheduled report's PDF).
export type Attachment = { name: string; mime: string; content: Uint8Array };
export type Email = { to: string; subject: string; text: string; html: string; replyTo?: string; attachments?: Attachment[] };

const memory = globalThis as unknown as { bikeOutbox?: Email[] };

// Emails sent while EMAIL_PROVIDER=memory (tests).
export function outbox(): Email[] {
  return (memory.bikeOutbox ??= []);
}

let transport: Transporter | undefined;

const FROM = () => process.env.EMAIL_FROM ?? "Bike <bike@bikeapp.si>";
// A reply reaches a person, not the sending address (hosted: pilot@bikeapp.si; the open Bike: the sender).
const REPLY_TO = () => edition.replyTo() ?? undefined;

// The one way Bike sends email: postmark in production, smtp (Mailpit) in dev, memory in tests. A refused or
// failed send throws EmailError, so callers can say so plainly.
export class EmailError extends Error {}

// A code-sending action's own reply when the send failed: logged here, worded by the caller.
export async function orUnsent<T>(run: () => Promise<T>, unsent: () => T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof EmailError)) throw e;
    console.error(`Code email not sent: ${e.message}`);
    return unsent();
  }
}

// How Bike sends email. The open Bike with no SMTP_URL has no mail relay ("none"): nothing is sent, and admins'
// sign-in codes go to the log (server/auth/signin.ts). The hosted service and dev default to Mailpit.
export function emailProvider(env: Record<string, string | undefined> = process.env, oneCompany = edition.oneCompany()): string {
  if (env.EMAIL_PROVIDER) return env.EMAIL_PROVIDER;
  return oneCompany && !env.SMTP_URL ? "none" : "smtp";
}
export const mailRelay = (env: Record<string, string | undefined> = process.env, oneCompany = edition.oneCompany()) => emailProvider(env, oneCompany) !== "none";
export const NO_RELAY = "No mail relay is set.";

export async function send(email: Email): Promise<void> {
  const provider = emailProvider();
  if (provider === "memory") return void outbox().push(email);
  if (provider === "none") throw new EmailError(NO_RELAY);
  if (provider === "postmark") return postmark(email);
  if (provider !== "smtp") throw new Error(`Email provider ${provider} isn't set up`);
  transport ??= nodemailer.createTransport(process.env.SMTP_URL ?? "smtp://localhost:1025");
  const { replyTo, attachments, ...rest } = email;
  const files = attachments?.map((a) => ({ filename: a.name, contentType: a.mime, content: Buffer.from(a.content) }));
  await transport.sendMail({ from: FROM(), replyTo: replyTo ?? REPLY_TO(), ...rest, ...(files ? { attachments: files } : {}) }).catch((e: Error) => Promise.reject(new EmailError(e.message)));
}

// Postmark's email API, on the transactional (outbound) stream, with the server's token (EMAIL_API_KEY).
async function postmark(email: Email): Promise<void> {
  const token = process.env.EMAIL_API_KEY;
  if (!token) throw new Error("Set EMAIL_API_KEY (the Postmark server token)");
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: FROM(), ReplyTo: email.replyTo ?? REPLY_TO(), To: email.to, Subject: email.subject, TextBody: email.text, HtmlBody: email.html, MessageStream: "outbound",
      ...(email.attachments ? { Attachments: email.attachments.map((a) => ({ Name: a.name, ContentType: a.mime, Content: Buffer.from(a.content).toString("base64") })) } : {}),
    }),
  }).catch((e: Error) => Promise.reject(new EmailError(`Postmark unreachable: ${e.message}`)));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
    throw new EmailError(`Postmark refused the email (${res.status}${body.ErrorCode ? `, ${body.ErrorCode}` : ""}): ${body.Message ?? ""}`);
  }
}
