import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { morningEmails, workspaces } from "@/db/schema";
import { outbox as sent } from "@/server/email/send";
import { createRow } from "@/server/kernel/rows";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import { kernelWorkspace } from "@/tests/kernel";
import { sendOutbox, tick } from "./tick";
import { edition } from "@/edition";

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
let only: { workspaceId: string };

const file = (): CapabilityFile => ({
  name: "Time off",
  icon: "calendar-days",
  sheets: [
    {
      id: "requests",
      name: "Requests",
      kind: "list",
      titleColumn: "who",
      row: { one: "request", many: "requests" },
      columns: [{ id: "who", name: "Who", type: "person", default: { kind: "creator" } }, { id: "status", name: "Status", type: "step" }],
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "approved", name: "Approved" }, { id: "taken", name: "Taken", end: "final" }],
    },
  ],
  roles: [{ id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], scope: "team", scopeColumns: { requests: { column: "who" } } }],
  rules: [
    {
      id: "to_manager",
      text: "Requests go to the person’s manager.",
      reading: { when: "w", then: "t" },
      trigger: { kind: "enters_step", sheet: "requests", step: "submitted" },
      actions: [{ kind: "ask_person", managerOf: "who", step: "submitted", label: "Approve or decline" }, { kind: "notify", columns: ["who"], message: "Your request is with your manager." }],
      enabled: true,
    },
  ],
  later: [],
});

// Times in Chicago (CDT, UTC−5).
const at = (local: string) => new Date(`${local}-05:00`);

beforeAll(async () => {
  k = await kernelWorkspace();
  only = { workspaceId: k.workspaceId };
  const cap = await k.create(file());
  await k.as("maya", (tx, c) => createRow(tx, c, cap, "requests", { values: {} }), at("2026-10-26T15:00:00"));
});

const priyaMail = () => sent().filter((m) => m.to === k.email("priya"));

describe("the hourly tick and the outbox", () => {
  it("sends a rule's notify email once the write has committed", async () => {
    await sendOutbox(only);
    expect(sent().filter((m) => m.to === k.email("maya")).map((m) => m.subject)).toEqual(["Time off · Maya Chen"]);
    await sendOutbox(only);
    expect(sent().filter((m) => m.to === k.email("maya"))).toHaveLength(1);
  });

  it("queues no morning email before 07:00 in the workspace's time zone", async () => {
    await tick(at("2026-10-27T06:30:00"), only);
    await sendOutbox(only);
    expect(priyaMail()).toEqual([]);
  });

  it("runs every workspace when none is named", async () => {
    await expect(tick(at("2026-10-27T05:00:00"))).resolves.toBeUndefined();
  });

  it("from 07:00, emails each person what waits on them, once a day, and nobody with nothing", async () => {
    await tick(at("2026-10-27T07:05:00"), only);
    await tick(at("2026-10-27T08:05:00"), only);
    await sendOutbox(only);
    const [mail] = priyaMail();
    expect(priyaMail()).toHaveLength(1);
    const [ws] = await k.as("ada", (tx) => tx.select().from(workspaces));
    expect(mail!.subject).toBe(`1 thing waits on you at ${ws!.name}`);
    expect(mail!.text).toContain("Good morning Priya, here is what waits on you in Bike today.");
    expect(mail!.text).toContain("Time off  Maya Chen  Submitted · approve or decline");
    expect(mail!.html).toContain(edition.workspaceUrl(ws!.subdomain, "/c/"));
    const logged = await k.as("ada", (tx) => tx.select().from(morningEmails).where(eq(morningEmails.personId, k.id.priya)));
    expect(logged.map((l) => [l.onDate, l.items])).toEqual([["2026-10-27", 1]]);
    expect(sent().some((m) => m.to === k.email("ada") && m.subject.includes("wait"))).toBe(false);
  });
});
