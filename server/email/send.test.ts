import { afterEach, describe, expect, it, vi } from "vitest";
import { edition } from "@/edition";
import { EmailError, emailProvider, mailRelay, NO_RELAY, orUnsent, send } from "./send";

// Postmark in production, with a stand-in for its API: what is sent, and a refusal as an EmailError that a
// code-sending action turns into plain words.

const EMAIL = { to: "maya@fernwood.dev", subject: "Your Bike code: K7P-2QX", text: "K7P-2QX", html: "<b>K7P-2QX</b>" };
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("sending email through Postmark", () => {
  it("posts the email to Postmark's API on the outbound stream, with the server token", async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "server-token", EMAIL_FROM: "Bike <bike@bikeapp.si>" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 0, Message: "OK" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await send(EMAIL);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("server-token");
    expect(JSON.parse(String(init.body))).toEqual({ From: "Bike <bike@bikeapp.si>", ...(edition.replyTo() ? { ReplyTo: edition.replyTo() } : {}), To: EMAIL.to, Subject: EMAIL.subject, TextBody: EMAIL.text, HtmlBody: EMAIL.html, MessageStream: "outbound" });
  });

  it("sends attachments (a scheduled report's PDF) as Postmark's base64 Attachments", async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "server-token" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 0, Message: "OK" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await send({ ...EMAIL, attachments: [{ name: "Spend by team.pdf", mime: "application/pdf", content: new TextEncoder().encode("%PDF-1.7") }] });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).Attachments).toEqual([{ Name: "Spend by team.pdf", ContentType: "application/pdf", Content: Buffer.from("%PDF-1.7").toString("base64") }]);
  });

  it("a refusal (an account still waiting for approval) is an EmailError, and a code action says so plainly", async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "server-token" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 412, Message: "Your account is pending approval." }), { status: 422 })));
    await expect(send(EMAIL)).rejects.toThrow(EmailError);
    await expect(send(EMAIL)).rejects.toThrow("(422, 412): Your account is pending approval.");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await orUnsent(() => send(EMAIL).then(() => "sent"), () => "unsent")).toBe("unsent");
  });

  it("Postmark out of reach is an EmailError too; other errors aren't hidden", async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "server-token" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(send(EMAIL)).rejects.toThrow("Postmark unreachable: fetch failed");
    await expect(orUnsent(() => Promise.reject(new Error("a bug")), () => "unsent")).rejects.toThrow("a bug");
  });
});

// The open Bike with no SMTP_URL has no mail relay: nothing is sent, and the caller is told plainly.
describe("no mail relay", () => {
  it("is the open Bike without SMTP_URL; the hosted service and dev keep Mailpit", () => {
    expect(emailProvider({}, true)).toBe("none");
    expect(emailProvider({ SMTP_URL: "" }, true)).toBe("none");
    expect(emailProvider({ SMTP_URL: "smtp://mail.acme.com:587" }, true)).toBe("smtp");
    expect(emailProvider({}, false)).toBe("smtp");
    expect(emailProvider({ EMAIL_PROVIDER: "postmark" }, true)).toBe("postmark");
    expect(mailRelay({}, true)).toBe(false);
    expect(mailRelay({ EMAIL_PROVIDER: "memory" }, true)).toBe(true);
  });

  it("sends nothing and says so, as an EmailError", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "none");
    await expect(send({ to: "a@b.dev", subject: "s", text: "t", html: "h" })).rejects.toThrow(new EmailError(NO_RELAY));
    vi.unstubAllEnvs();
  });
});
