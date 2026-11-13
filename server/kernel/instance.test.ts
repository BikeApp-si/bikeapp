import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEntries, instanceSettings, instanceSetup, people } from "@/db/schema";
import { aiKey, forgetAiSettings, KEY_REFUSED } from "./instance-settings";
import { withRoot, withWorkspace } from "./tx";
import { workspaceBySubdomain } from "./workspaces";
import { ALREADY_SET_UP, createFirstCompany, ensureSetupCode, SETUP_CODE_USED_UP, setupCodeLine, storedAddress, WRONG_SETUP_CODE } from "./instance";

// The open Bike's first run: the setup code from the log, five tries, one company.

const none = async () => 0;
let lines: string[] = [];
const log = (l: string) => void lines.push(l);
const codeIn = (line: string) => line.match(/: (\w{3}-\w{3})\./)![1]!;
const lastCode = () => codeIn(lines.at(-1)!);
let n = 0;
const company = () => `Juniper ${Date.now().toString(36)}${n++} Labs`;
const input = (code: string, name = company()) => ({ code, company: name, name: "Rita Founder", email: `Rita@${name.split(" ")[1]}.dev`, timeZone: "Europe/Ljubljana" });

// Each test starts as a fresh Bike: no first run done, a new code in the log.
beforeEach(async () => {
  lines = [];
  await withRoot((tx) => tx.update(instanceSetup).set({ doneAt: null }).where(eq(instanceSetup.id, 1)));
  await ensureSetupCode({ fresh: true, log, companies: none });
});

describe("first run", () => {
  it("writes a setup code to the log, and a new one each start", async () => {
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(setupCodeLine(lastCode().replace("-", "")));
    await ensureSetupCode({ log, companies: none }); // the page opening: the waiting code stays
    expect(lines).toHaveLength(1);
    await ensureSetupCode({ fresh: true, log, companies: none });
    expect(lines).toHaveLength(2);
    expect(lastCode()).not.toBe(codeIn(lines[0]!));
  });

  it("writes no code once a company exists", async () => {
    lines = [];
    await ensureSetupCode({ fresh: true, log, companies: async () => 1 });
    expect(lines).toEqual([]);
  });

  it("creates the company with its first admin from the right code", async () => {
    const name = company();
    const result = await createFirstCompany(input(lastCode().toLowerCase(), name), { log, companies: none });
    const email = `rita@${name.split(" ")[1]}.dev`;
    expect(result).toEqual({ ok: true, email });
    const ws = (await workspaceBySubdomain(storedAddress(name)))!;
    expect(ws).toMatchObject({ name, timeZone: "Europe/Ljubljana" });
    await withWorkspace({ workspaceId: ws.id }, async (tx) => {
      expect(await tx.select({ email: people.email, isAdmin: people.isAdmin }).from(people)).toEqual([{ email, isAdmin: true }]);
      expect((await tx.select({ event: auditEntries.event }).from(auditEntries)).map((e) => e.event)).toEqual(["workspace.created"]);
    });
    // Done: the code no longer works, and no second company is made.
    expect(await createFirstCompany(input(lastCode()), { log, companies: none })).toEqual({ ok: false, error: ALREADY_SET_UP });
  });

  it("counts wrong codes down, and after the fifth writes a new one", async () => {
    const first = lastCode();
    const wrong = (first.startsWith("A") ? "B" : "A") + first.slice(1);
    for (const left of [4, 3, 2, 1]) expect(await createFirstCompany(input(wrong), { log, companies: none })).toEqual({ ok: false, error: WRONG_SETUP_CODE(left), codeWrong: true });
    expect(await createFirstCompany(input(wrong), { log, companies: none })).toEqual({ ok: false, error: SETUP_CODE_USED_UP, codeWrong: true });
    expect(lines).toHaveLength(2);
    expect(await createFirstCompany(input(first), { log, companies: none })).toMatchObject({ ok: false, codeWrong: true });
    expect((await createFirstCompany(input(lastCode()), { log, companies: none })).ok).toBe(true);
  });

  it("refuses when a company is already in the database", async () => {
    expect(await createFirstCompany(input(lastCode()), { log, companies: async () => 1 })).toEqual({ ok: false, error: ALREADY_SET_UP });
  });

  it("checks the details before the code, so a typo costs no try", async () => {
    expect(await createFirstCompany({ ...input(lastCode()), company: " " }, { log, companies: none })).toEqual({ ok: false, error: "Please enter your company name." });
    expect(await createFirstCompany({ ...input(lastCode()), email: "rita" }, { log, companies: none })).toEqual({ ok: false, error: "Please enter your work email." });
    expect(await createFirstCompany({ ...input(lastCode()), timeZone: "Mars/Olympus" }, { log, companies: none })).toEqual({ ok: false, error: "Please pick a time zone." });
    const wrong = lastCode().startsWith("A") ? "B" + lastCode().slice(1) : "A" + lastCode().slice(1);
    expect(await createFirstCompany(input(wrong), { log, companies: none })).toEqual({ ok: false, error: WRONG_SETUP_CODE(4), codeWrong: true });
  });

  it("takes the company's Anthropic key if given, checked before the code", async () => {
    process.env.BIKE_MODE = "single";
    try {
      const refused = await createFirstCompany({ ...input(lastCode()), aiKey: "sk-ant-api03-refused-key-000000000000" }, { log, companies: none, checkKey: async () => "refused" });
      expect(refused).toEqual({ ok: false, error: KEY_REFUSED.refused });
      expect(await createFirstCompany({ ...input(lastCode()), aiKey: "nope" }, { log, companies: none })).toMatchObject({ ok: false, error: expect.stringContaining("sk-ant-") });
      // Neither cost a try.
      const name = company();
      expect((await createFirstCompany({ ...input(lastCode(), name), aiKey: "sk-ant-api03-first-run-key-00000000abcd" }, { log, companies: none, checkKey: async () => "ok" })).ok).toBe(true);
      expect(await aiKey({})).toMatchObject({ source: "settings", last4: "abcd" });
    } finally {
      delete process.env.BIKE_MODE;
      await withRoot((tx) => tx.update(instanceSettings).set({ aiKeySealed: null, aiKeyLast4: null }).where(eq(instanceSettings.id, 1)));
      forgetAiSettings();
    }
  });

  it("two at once make one company", async () => {
    const code = lastCode();
    const results = await Promise.all([createFirstCompany(input(code), { log, companies: none }), createFirstCompany(input(code), { log, companies: none })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: ALREADY_SET_UP });
  });

  it("keeps an address the database accepts, whatever the name", () => {
    expect(storedAddress("Fernwood Labs")).toBe("fernwood");
    expect(storedAddress("株式会社")).toBe("company");
    expect(storedAddress("Docs")).toBe("company");
    expect(storedAddress("AB")).toBe("company");
  });
});
