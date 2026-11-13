import { describe, expect, it } from "vitest";
import { checkAddress, shortName, suggestAddress } from "./address";

describe("workspace address rules", () => {
  it.each(["fernwood", "abc", "a-b-c", "acme2", "x".repeat(30)])("accepts %s", (s) => {
    expect(checkAddress(s).ok).toBe(true);
  });
  it.each([
    ["ab", "at least 3"],
    ["x".repeat(31), "at most 30"],
    ["Fernwood", "lowercase"],
    ["fern_wood", "lowercase"],
    ["fern.wood", "lowercase"],
    ["-fern", "hyphen"],
    ["fern-", "hyphen"],
  ])("refuses %s", (s, why) => {
    const r = checkAddress(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
  });
  it.each(["app", "api", "admin", "www", "mail", "help", "status", "docs"])("refuses reserved %s", (s) => {
    expect(checkAddress(s)).toEqual({ ok: false, reason: "That address is reserved." });
  });
  it("suggests an address and a short name from the company name", () => {
    expect(suggestAddress("Fernwood Labs")).toBe("fernwood");
    expect(suggestAddress("Acme & Sons, Inc.")).toBe("acme-sons");
    expect(suggestAddress("Café Noir")).toBe("cafe-noir");
    expect(shortName("Fernwood Labs")).toBe("Fernwood");
    expect(shortName("Labs")).toBe("Labs");
  });
});
