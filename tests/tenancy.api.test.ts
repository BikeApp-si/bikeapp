// Done when, by API: kernel and auth calls made for Fernwood never reach Acme's rows, codes or sessions.
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema";
import { seed } from "@/seed";
import { outbox } from "@/server/email/send";
import { withWorkspace } from "@/server/kernel/tx";
import { workspaceBySubdomain, type Workspace } from "@/server/kernel/workspaces";
import { importPeople } from "@/server/kernel/people";
import { checkSignInCode, requestSignInCode } from "@/server/auth/signin";
import { createHandoff, HANDOFF_TTL_MS, personForSession, redeemHandoff } from "@/server/auth/session";
import { lastCode, meta } from "./helpers";

let fernwood: Workspace;
let acme: Workspace;
let samId: string;
let wadeId: string;

beforeAll(async () => {
  await seed();
  fernwood = (await workspaceBySubdomain("fernwood"))!;
  acme = (await workspaceBySubdomain("acme"))!;
  samId = (await withWorkspace({ workspaceId: acme.id }, (tx) => tx.select().from(people).where(eq(people.email, "sam@acme.test"))))[0]!.id;
  wadeId = (await withWorkspace({ workspaceId: fernwood.id }, (tx) => tx.select().from(people).where(eq(people.email, "wade@fernwood.dev"))))[0]!.id;
});

async function signIn(ws: Workspace, email: string) {
  await requestSignInCode(ws, email, meta("10.7.0.1"));
  const r = await checkSignInCode(ws, email, lastCode(email), meta("10.7.0.1"));
  if (!r.ok) throw new Error("sign in failed");
  return r.sessionToken;
}

describe("kernel reads", () => {
  it("can't find an Acme person by id from Fernwood", async () => {
    const found = await withWorkspace({ workspaceId: fernwood.id }, (tx) => tx.select().from(people).where(eq(people.id, samId)));
    expect(found).toEqual([]);
  });

  it("can't link a Fernwood person to an Acme manager by email", async () => {
    const ctx = { workspaceId: fernwood.id, personId: wadeId };
    const r = await withWorkspace(ctx, (tx) =>
      importPeople(tx, ctx, "wade@fernwood.dev", [{ name: "Tess", email: `tess${Date.now()}@fernwood.dev`, managerEmail: "sam@acme.test" }], "test"),
    );
    expect(r.flagged).toBe(1);
  });
});

describe("sign in", () => {
  it("Fernwood's address won't send a code to an Acme person", async () => {
    outbox().splice(0);
    await requestSignInCode(fernwood, "sam@acme.test", meta("10.7.0.2"));
    expect(outbox()).toEqual([]);
  });

  it("an Acme code doesn't work on Fernwood's address", async () => {
    await requestSignInCode(acme, "sam@acme.test", meta("10.7.0.3"));
    const r = await checkSignInCode(fernwood, "sam@acme.test", lastCode("sam@acme.test"), meta("10.7.0.3"));
    expect(r.ok).toBe(false);
  });

  it("a Fernwood session isn't accepted by Acme", async () => {
    const token = await signIn(fernwood, "wade@fernwood.dev");
    expect((await personForSession(fernwood.id, token))?.email).toBe("wade@fernwood.dev");
    expect(await personForSession(acme.id, token)).toBeNull();
  });
});

describe("handoff tokens", () => {
  it("work once, on their own workspace, within 60 seconds", async () => {
    const make = () => withWorkspace({ workspaceId: fernwood.id }, (tx) => createHandoff(tx, { workspaceId: fernwood.id, personId: wadeId }));

    const wrongHost = await make();
    expect(await redeemHandoff(acme.id, wrongHost)).toBeNull();

    const once = await make();
    expect(await redeemHandoff(fernwood.id, once)).not.toBeNull();
    expect(await redeemHandoff(fernwood.id, once)).toBeNull();

    const late = await make();
    expect(await redeemHandoff(fernwood.id, late, new Date(Date.now() + HANDOFF_TTL_MS + 1000))).toBeNull();
  });
});
