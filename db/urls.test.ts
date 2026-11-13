import { describe, expect, it } from "vitest";
import { direct } from "./urls";

describe("the direct connection", () => {
  it("swaps the pooler's host for the direct one, keeping user, password and database", () => {
    const pooled = "postgres://bike_app:s3cret@pgbouncer.abc.flympg.net:5432/fly-db";
    expect(direct(pooled, { DATABASE_DIRECT_HOST: "direct.abc.flympg.net" })).toBe("postgres://bike_app:s3cret@direct.abc.flympg.net:5432/fly-db");
    expect(direct(pooled, {})).toBe(pooled);
  });
});
