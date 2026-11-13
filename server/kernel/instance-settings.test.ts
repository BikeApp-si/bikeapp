import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { auditEntries, instanceSettings } from "@/db/schema";
import { kernelWorkspace } from "@/tests/kernel";
import { edition } from "@/edition";
import { withRoot } from "./tx";
import { aiCap, aiKey, aiKeyView, forgetAiSettings, hasModel, KEY_REFUSED, removeAiKey, setAiCap, setAiKey } from "./instance-settings";

// The open Bike's AI settings: the key set in Settings › AI (sealed), else .env's; the cap; admins only, audited.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
const KEY = "sk-ant-api03-test-key-abcdefghijklmnop-4f2a";
const ok = async () => "ok" as const;
const clear = () => withRoot((tx) => tx.update(instanceSettings).set({ aiKeySealed: null, aiKeyLast4: null, aiCapUsd: null }).where(eq(instanceSettings.id, 1)));
const lastEvent = (event: string) =>
  k.as("ada", (tx) => tx.select().from(auditEntries).where(eq(auditEntries.event, event)).orderBy(desc(auditEntries.seq)).limit(1)).then((r) => r[0]);

beforeAll(async () => {
  k = await kernelWorkspace();
});
beforeEach(async () => {
  process.env.BIKE_MODE = "single";
  await clear();
  forgetAiSettings();
});
afterEach(() => void delete process.env.BIKE_MODE);
afterAll(async () => {
  await clear();
  forgetAiSettings();
});

describe("the AI key", () => {
  it("is the one set here, else .env's, else none", async () => {
    expect(await aiKey({})).toBeNull();
    expect(await hasModel({})).toBe(false);
    expect(await aiKey({ ANTHROPIC_API_KEY: "sk-ant-from-env-1234" })).toEqual({ key: "sk-ant-from-env-1234", source: "env", last4: "1234" });
    await k.as("ada", (tx, c) => setAiKey(tx, c, ` ${KEY} `, ok));
    expect(await aiKey({ ANTHROPIC_API_KEY: "sk-ant-from-env-1234" })).toEqual({ key: KEY, source: "settings", last4: "4f2a" });
    expect(await hasModel({})).toBe(true);
    expect(await aiKeyView({})).toEqual({ source: "settings", last4: "4f2a", broken: false, cap: null });
    // Stored sealed, never as written.
    const [row] = await withRoot((tx) => tx.select().from(instanceSettings));
    expect(row!.aiKeySealed).not.toContain("sk-ant");
    expect(row!.aiKeyLast4).toBe("4f2a");
    // The Audit log has its last four characters only.
    expect((await lastEvent("ai.key_set"))?.details).toEqual({ key: "…4f2a" });
    await k.as("ada", (tx, c) => removeAiKey(tx, c));
    expect(await aiKey({})).toBeNull();
    expect((await lastEvent("ai.key_removed"))?.details).toEqual({ key: "…4f2a" });
  });

  it("is saved only when Anthropic accepts it, and only by an admin", async () => {
    await expect(k.as("ada", (tx, c) => setAiKey(tx, c, "not-a-key", ok))).rejects.toThrow("starts with sk-ant-");
    await expect(k.as("ada", (tx, c) => setAiKey(tx, c, KEY, async () => "refused"))).rejects.toThrow(KEY_REFUSED.refused);
    await expect(k.as("ada", (tx, c) => setAiKey(tx, c, KEY, async () => "unreachable"))).rejects.toThrow(KEY_REFUSED.unreachable);
    await expect(k.as("maya", (tx, c) => setAiKey(tx, c, KEY, ok))).rejects.toThrow("Only admins");
    await expect(k.as("maya", (tx, c) => setAiCap(tx, c, 10))).rejects.toThrow("Only admins");
    expect(await aiKey({})).toBeNull();
  });

  it("is .env's only on the hosted service, which has no AI settings", async () => {
    delete process.env.BIKE_MODE;
    if (edition.oneCompany()) return; // the open tree has no hosted service
    await expect(k.as("ada", (tx, c) => setAiKey(tx, c, KEY, ok))).rejects.toThrow("company’s own Bike");
    expect(await aiKey({ ANTHROPIC_API_KEY: "sk-ant-from-env-1234" })).toMatchObject({ source: "env" });
    expect(await aiCap()).toBeNull();
  });
});

describe("the monthly cap", () => {
  it("is set, changed and removed, in dollars, with Audit entries", async () => {
    await k.as("ada", (tx, c) => setAiCap(tx, c, 50));
    expect(await aiCap()).toBe(50);
    expect((await lastEvent("ai.cap_changed"))?.details).toEqual({ from: null, to: 50 });
    await k.as("ada", (tx, c) => setAiCap(tx, c, 12.345));
    expect(await aiCap()).toBe(12.35);
    await k.as("ada", (tx, c) => setAiCap(tx, c, null));
    expect(await aiCap()).toBeNull();
    await expect(k.as("ada", (tx, c) => setAiCap(tx, c, 0))).rejects.toThrow("above 0");
    await expect(k.as("ada", (tx, c) => setAiCap(tx, c, -5))).rejects.toThrow("above 0");
  });
});
