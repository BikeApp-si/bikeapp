import { describe, expect, it } from "vitest";
import { dateLines, stamp } from "./chat-list";

// The times a chat list and a chat show (12a, 12b, 12c, 12e), in the workspace's time zone.
const TZ = "America/Chicago";
const now = new Date("2026-10-27T15:00:00Z"); // Oct 27, 10:00 in Austin

describe("chat times", () => {
  it("says Today with the time, or the date", () => {
    expect(stamp(new Date("2026-10-27T14:15:00Z"), TZ, "2026-10-27")).toEqual({ when: "Today, 09:15", day: "09:15" });
    expect(stamp(new Date("2026-10-23T21:40:00Z"), TZ, "2026-10-27")).toEqual({ when: "Oct 23, 16:40", day: "Oct 23" });
  });

  it("puts a date line above the first message of each day, once a chat isn't all from today", () => {
    const at = (id: string, iso: string) => ({ id, at: new Date(iso) });
    expect(dateLines([at("a", "2026-10-27T14:00:00Z"), at("b", "2026-10-27T14:01:00Z")], TZ, now)).toEqual({});
    expect(
      dateLines([at("a", "2026-10-22T19:51:00Z"), at("b", "2026-10-22T19:52:00Z"), at("c", "2026-10-27T14:15:00Z"), at("d", "2026-10-27T14:16:00Z")], TZ, now),
    ).toEqual({ a: "Oct 22, 14:51", c: "Today, 09:15" });
  });
});
