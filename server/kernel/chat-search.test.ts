import { beforeAll, describe, expect, it } from "vitest";
import { kernelWorkspace } from "@/tests/kernel";
import { searchChats, searchQuery } from "./chat-list";
import { addMessage, startChat, touchChat } from "./chats";
import { addAdmin } from "./settings";

// M33 · Searching chats (m33-f): full-text over the titles and messages of an admin's own chats, with the line that
// matched. Another admin's chats, an employee and another workspace find nothing.

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let spend: string;
let starters: string;

beforeAll(async () => {
  k = await kernelWorkspace();
  await k.as("ada", (tx, c) => addAdmin(tx, c, k.id.priya));
  ({ chatId: spend } = await k.as("ada", (tx, c) => startChat(tx, c, "report", { text: "Show spend by team this quarter against each team's budget." })));
  await k.as("ada", (tx, c) => touchChat(tx, c, spend, { title: "Spend by team, Q4" }));
  await k.as("ada", (tx, c) => addMessage(tx, c, spend, { from: "bike", text: "This quarter so far, teams have spent **$95,300** of $140,000. Marketing has used 87% and Engineering 82%, with two months to go." }));
  ({ chatId: starters } = await k.as("ada", (tx, c) => startChat(tx, c, "report", { text: "Who starts in November?" })));
  await k.as("ada", (tx, c) => touchChat(tx, c, starters, { title: "November starters" }));
  await k.as("priya", (tx, c) => startChat(tx, c, "report", { text: "Engineering hiring plan" }));
});

describe("searching chats", () => {
  it("finds words in messages, with the line that matched and the word marked", async () => {
    const found = await k.as("ada", (tx, c) => searchChats(tx, c, "engineering"));
    expect(found.map((f) => f.title)).toEqual(["Spend by team, Q4"]);
    const line = found[0]!.match!;
    expect(line.filter((p) => p.bold).map((p) => p.text)).toEqual(["Engineering"]);
    expect(line.map((p) => p.text).join("")).not.toContain("**");
  });

  it("finds titles, word stems and the start of the last word", async () => {
    expect((await k.as("ada", (tx, c) => searchChats(tx, c, "November"))).map((f) => f.title)).toEqual(["November starters"]);
    expect((await k.as("ada", (tx, c) => searchChats(tx, c, "teams budgets"))).map((f) => f.title)).toEqual(["Spend by team, Q4"]);
    expect((await k.as("ada", (tx, c) => searchChats(tx, c, "engin"))).map((f) => f.title)).toEqual(["Spend by team, Q4"]);
    expect(await k.as("ada", (tx, c) => searchChats(tx, c, "payroll"))).toEqual([]);
  });

  it("reads typed symbols as nothing but words, and an empty search finds nothing", async () => {
    expect(searchQuery("  ")).toBeNull();
    expect(searchQuery("spend & !(team) | x:*")).toBe("spend & team & x:*");
    expect(await k.as("ada", (tx, c) => searchChats(tx, c, "!&|"))).toEqual([]);
  });

  it("never finds another admin's chats, nor anything for an employee or in another workspace", async () => {
    expect((await k.as("priya", (tx, c) => searchChats(tx, c, "engineering"))).map((f) => f.title)).toEqual(["Engineering hiring plan"]);
    expect((await k.as("ada", (tx, c) => searchChats(tx, c, "hiring"))).map((f) => f.title)).toEqual([]);
    await expect(k.as("maya", (tx, c) => searchChats(tx, c, "engineering"))).rejects.toThrow("Only admins can do that.");
    const other = await kernelWorkspace();
    expect(await other.as("ada", (tx, c) => searchChats(tx, c, "engineering"))).toEqual([]);
  });
});
