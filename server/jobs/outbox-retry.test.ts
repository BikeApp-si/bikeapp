import { beforeAll, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import { outbox } from "@/db/schema";
import { createRow } from "@/server/kernel/rows";
import type { CapabilityFile } from "@/server/kernel/schema/file";
import { kernelWorkspace } from "@/tests/kernel";

// The outbox with an email the provider refuses (Postmark before approval, or a bad address): that one stays
// unsent and is tried again on the next run; the emails after it still go out.

const refused = new Set<string>();
const delivered: string[] = [];
vi.mock("@/server/email/send", async (orig) => {
  const real = await orig<typeof import("@/server/email/send")>();
  return {
    ...real,
    send: async (email: { to: string }) => {
      if (refused.has(email.to)) throw new real.EmailError("Postmark refused the email (422, 412)");
      delivered.push(email.to);
    },
  };
});
const { sendOutbox } = await import("./tick");

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
      steps: [{ id: "submitted", name: "Submitted", start: true }, { id: "taken", name: "Taken", end: "final" }],
    },
  ],
  roles: [{ id: "everyone", name: "Everyone", members: { kind: "everyone" }, can: ["see", "add"], scope: "own", scopeColumns: { requests: { column: "who" } } }],
  rules: [
    {
      id: "tell",
      text: "Tell the person their request is in.",
      reading: { when: "w", then: "t" },
      trigger: { kind: "row_created", sheet: "requests" },
      actions: [{ kind: "notify", columns: ["who"], message: "Your request is in." }],
      enabled: true,
    },
  ],
  later: [],
});

let k: Awaited<ReturnType<typeof kernelWorkspace>>;
beforeAll(async () => {
  k = await kernelWorkspace();
  const cap = await k.create(file());
  for (const n of ["maya", "omar"] as const) await k.as(n, (tx, c) => createRow(tx, c, cap, "requests", { values: {} }));
});

describe("the outbox with a refused email", () => {
  it("sends the rest, keeps the refused one, and sends it once it's accepted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refused.add(k.email("maya"));
    await sendOutbox({ workspaceId: k.workspaceId });
    expect(delivered).toEqual([k.email("omar")]);
    const waiting = () => k.as("ada", (tx) => tx.select({ id: outbox.id }).from(outbox).where(isNull(outbox.sentAt)));
    expect(await waiting()).toHaveLength(1);

    refused.clear();
    await sendOutbox({ workspaceId: k.workspaceId });
    expect(delivered).toEqual([k.email("omar"), k.email("maya")]);
    expect(await waiting()).toHaveLength(0);
  });
});
