import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, people } from "@/db/schema";
import { outbox } from "@/server/email/send";
import { withWorkspace } from "@/server/kernel/tx";
import { checkSignInCode, codeLogLine, requestSignInCode } from "./signin";
import { personForSession } from "./session";
import { freshWorkspace, lastCode, meta } from "@/tests/helpers";

const T0 = new Date("2026-10-26T22:34:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const wrong = (code: string) => (code.startsWith("A") ? "B" : "A") + code.slice(1);

beforeEach(() => void outbox().splice(0));

describe("sign in by email code", () => {
  it("emails a code as on 1e and signs in once with it", async () => {
    const { ws, email } = await freshWorkspace();
    expect(await requestSignInCode(ws, email, meta(), T0)).toEqual({ ok: true });
    const mail = outbox().at(-1)!;
    expect(mail.subject).toMatch(/^Your Bike code: \w{3}-\w{3}$/);
    expect(mail.text).toContain(`Hi Ada, here is your code to sign in to ${ws.name}:`);
    expect(mail.text).toContain("It expires in 10 minutes and works once. Sign-in from Chrome on macOS, at 5:34 pm.");
    expect(mail.text).toContain("Not you? You can ignore this email; nobody can sign in without the code.");

    const code = lastCode(email);
    const ok = await checkSignInCode(ws, email.toUpperCase(), code.toLowerCase(), meta(), later(60_000));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((await personForSession(ws.id, ok.sessionToken, later(60_000)))?.email).toBe(email);

    // One use.
    expect((await checkSignInCode(ws, email, code, meta(), later(70_000))).ok).toBe(false);
  });

  it("expires after 10 minutes", async () => {
    const { ws, email } = await freshWorkspace();
    await requestSignInCode(ws, email, meta(), T0);
    const r = await checkSignInCode(ws, email, lastCode(email), meta(), later(10 * 60_000 + 1));
    expect(r).toEqual({ ok: false, triesLeft: null, newCodeSent: false });
  });

  it("counts tries down and sends a new code after the fifth wrong one", async () => {
    const { ws, email } = await freshWorkspace();
    await requestSignInCode(ws, email, meta(), T0);
    const first = lastCode(email);
    const left = [];
    for (let i = 0; i < 4; i++) left.push((await checkSignInCode(ws, email, wrong(first), meta(), later(i * 1000))) as { triesLeft: number });
    expect(left.map((r) => r.triesLeft)).toEqual([4, 3, 2, 1]);
    expect(await checkSignInCode(ws, email, wrong(first), meta(), later(5000))).toEqual({ ok: false, triesLeft: 0, newCodeSent: true });

    // The old code no longer works; the new one does.
    expect((await checkSignInCode(ws, email, first, meta(), later(6000))).ok).toBe(false);
    expect((await checkSignInCode(ws, email, lastCode(email), meta(), later(7000))).ok).toBe(true);

    const events = await withWorkspace({ workspaceId: ws.id }, (tx) => tx.select({ e: auditEntries.event }).from(auditEntries));
    // Five on the first code, one when the old code was tried against the new one.
    expect(events.filter((e) => e.e === "auth.code_failed")).toHaveLength(6);
    expect(events.filter((e) => e.e === "auth.code_sent")).toHaveLength(2);
    expect(events.filter((e) => e.e === "auth.signin")).toHaveLength(1);
  });

  it("sends nothing to an email that isn't in People, and says the same", async () => {
    const { ws } = await freshWorkspace();
    expect(await requestSignInCode(ws, "stranger@else.dev", meta(), T0)).toEqual({ ok: true });
    expect(outbox()).toHaveLength(0);
  });

  it("limits codes to 5 per email in 15 minutes", async () => {
    const { ws, email } = await freshWorkspace();
    for (let i = 0; i < 5; i++) expect((await requestSignInCode(ws, email, meta(`10.1.0.${i}`), later(i * 60_000))).ok).toBe(true);
    expect(await requestSignInCode(ws, email, meta("10.1.0.9"), later(5 * 60_000))).toEqual({ ok: false, retryInMinutes: 10 });
    // The window slides: the first request falls out after 15 minutes.
    expect((await requestSignInCode(ws, email, meta("10.1.0.9"), later(15 * 60_000 + 1))).ok).toBe(true);
  });

  it("limits codes to 20 per IP in 15 minutes, across emails", async () => {
    const { ws, workspaceId } = await freshWorkspace();
    const emails = Array.from({ length: 21 }, (_, i) => `p${i}@ip.dev`);
    await withWorkspace({ workspaceId }, (tx) => tx.insert(people).values(emails.map((e) => ({ workspaceId, name: e, email: e }))));
    const ip = `10.2.${Date.now() % 250}.1`;
    for (let i = 0; i < 20; i++) expect((await requestSignInCode(ws, emails[i]!, meta(ip), T0)).ok).toBe(true);
    expect((await requestSignInCode(ws, emails[20]!, meta(ip), T0)).ok).toBe(false);
  });

  it("an expired session signs nobody in", async () => {
    const { ws, email } = await freshWorkspace();
    await requestSignInCode(ws, email, meta(), T0);
    const r = await checkSignInCode(ws, email, lastCode(email), meta(), T0);
    if (!r.ok) throw new Error("sign in failed");
    expect(await personForSession(ws.id, r.sessionToken, later(31 * 24 * 3600_000))).toBeNull();
  });
});

describe("people lookups stay inside the workspace", () => {
  it("finds the person case-insensitively", async () => {
    const { ws, workspaceId } = await freshWorkspace();
    await withWorkspace({ workspaceId }, (tx) => tx.update(people).set({ email: "Mixed@Case.dev" }).where(eq(people.workspaceId, workspaceId)));
    await requestSignInCode(ws, "mixed@case.dev", meta(), T0);
    expect(outbox()).toHaveLength(1);
  });
});

// The open Bike before it has a mail relay: an admin's code goes to the log once; anyone else gets nothing, and
// the reply is the same for both (1c can't tell who is an admin).
describe("sign in without a mail relay", () => {
  it("writes an admin's code to the log, which signs them in", async () => {
    const { ws, email } = await freshWorkspace();
    vi.stubEnv("EMAIL_PROVIDER", "none");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await requestSignInCode(ws, email, meta(), T0)).toEqual({ ok: true });
      expect(outbox()).toHaveLength(0);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]![0]);
      const code = line.match(/: (\w{3}-\w{3}) /)![1]!;
      expect(line).toBe(codeLogLine(email, code.replace("-", "")));
      expect(line).toMatch(new RegExp(`^Sign-in code for ${email}: \\w{3}-\\w{3} \\(expires in 10 minutes\\)$`));
      expect((await checkSignInCode(ws, email, code, meta(), later(60_000))).ok).toBe(true);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("logs nothing for someone who isn't an admin, and answers the same", async () => {
    const { ws, workspaceId } = await freshWorkspace();
    await withWorkspace({ workspaceId }, (tx) => tx.insert(people).values({ workspaceId, name: "Maya Employee", email: "maya@here.dev" }));
    vi.stubEnv("EMAIL_PROVIDER", "none");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await requestSignInCode(ws, "maya@here.dev", meta(), T0)).toEqual({ ok: true });
      expect(log).not.toHaveBeenCalled();
      expect(outbox()).toHaveLength(0);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
