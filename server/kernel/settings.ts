import { forgetSetup } from "./setup-cache";
import { and, eq } from "drizzle-orm";
import { people, uploads, workspaces } from "@/db/schema";
import { shortName } from "@/lib/address";
import { record } from "./audit";
import { mustBeAdmin } from "./admin";
import { KernelError, type KernelCtx } from "./context";
import type { Tx } from "./tx";
import { getFile } from "@/server/files/storage";
import { formatDate, formatNumber, formatsOf } from "@/lib/format";
import { isCountry, isCurrency } from "@/lib/places";
import { bareWebsite, DOMAIN } from "./setup/organization";

// Settings (9b; fuller in M26): the company logo and name, its website and address, how it writes money, numbers
// and dates, and who the admins are. Admins only, checked here.
// The person who created the workspace is its Owner: always an admin. The last admin can't be removed.

export async function getSettings(tx: Tx, ctx: KernelCtx) {
  await mustBeAdmin(tx, ctx);
  const [ws] = await tx.select().from(workspaces);
  if (!ws) throw new KernelError("No workspace.");
  const [logo] = ws.logoKey ? await tx.select({ id: uploads.id }).from(uploads).where(eq(uploads.key, ws.logoKey)) : [];
  const admins = await tx
    .select({ id: people.id, name: people.name, title: people.title })
    .from(people)
    .where(eq(people.isAdmin, true))
    .orderBy(people.seq);
  // The Owner first, then the others in People's order.
  const ordered = [...admins.filter((a) => a.id === ws.ownerId), ...admins.filter((a) => a.id !== ws.ownerId)];
  const f = formatsOf(ws);
  return {
    name: ws.name,
    logoUploadId: logo?.id ?? null,
    website: ws.website ?? "",
    street: ws.street ?? "",
    city: ws.city ?? "",
    addressRegion: ws.addressRegion ?? "",
    country: ws.country,
    currency: f.currency,
    numberGrouping: f.grouping,
    dateStyle: f.dates,
    fiscalYearStart: f.yearStart,
    admins: ordered.map((a) => ({ ...a, owner: a.id === ws.ownerId })),
  };
}

export type SettingsChange = {
  name?: string;
  logoUploadId?: string;
  website?: string;
  street?: string;
  city?: string;
  addressRegion?: string;
  country?: string | null;
  currency?: string;
  numberGrouping?: "standard" | "indian";
  dateStyle?: "mdy" | "dmy";
  fiscalYearStart?: number;
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SAMPLE = 1_234_567;
const SAMPLE_DAY = "2026-11-14";
const numbersText = (g: string | null) => formatNumber(SAMPLE, formatsOf({ numberGrouping: g }));
const datesText = (d: string | null) => formatDate(SAMPLE_DAY, formatsOf({ dateStyle: d }));
const text = (v: string | undefined, max: number, what: string) => {
  const t = (v ?? "").trim();
  if (t.length > max) throw new KernelError(`The ${what} is longer than ${max} characters.`);
  return t || null;
};

export async function updateSettings(tx: Tx, ctx: KernelCtx, change: SettingsChange) {
  await mustBeAdmin(tx, ctx);
  const [ws] = await tx.select().from(workspaces);
  if (!ws) throw new KernelError("No workspace.");
  const set: Partial<typeof workspaces.$inferInsert> = {};
  const details: Record<string, unknown> = {};
  if (change.name !== undefined) {
    const name = change.name.trim();
    if (!name) throw new KernelError("The company needs a name.");
    if (name.length > 80) throw new KernelError("The name is longer than 80 characters.");
    if (name !== ws.name) {
      set.name = name;
      set.shortName = shortName(name);
      details.name = { from: ws.name, to: name };
    }
  }
  if (change.logoUploadId !== undefined) {
    const [u] = await tx
      .select({ key: uploads.key, name: uploads.name, mime: uploads.mime })
      .from(uploads)
      .where(and(eq(uploads.id, change.logoUploadId), eq(uploads.uploadedBy, ctx.actor.id)));
    if (!u) throw new KernelError("Upload the logo first.");
    if (!u.mime.startsWith("image/")) throw new KernelError("The logo must be a PNG or JPG.");
    set.logoKey = u.key;
    details.logo = u.name;
  }
  // Each field that changed, in words for the Audit log: "currency USD → INR".
  const put = <K extends keyof typeof set>(key: K, to: (typeof set)[K], label: string, shown: (v: unknown) => unknown = (v) => v ?? "") => {
    const from = shown(ws[key as keyof typeof ws]);
    if (from === shown(to)) return; // the same as read, e.g. an empty grouping and "standard"
    set[key] = to;
    details[label] = { from, to: shown(to) };
  };
  if (change.website !== undefined) {
    const site = change.website.trim() ? bareWebsite(change.website) : null;
    if (site && !DOMAIN.test(site)) throw new KernelError("The website isn't a web address, like fernwood.dev.");
    put("website", site, "website");
  }
  if (change.street !== undefined) put("street", text(change.street, 120, "street"), "street");
  if (change.city !== undefined) put("city", text(change.city, 80, "city"), "city");
  if (change.addressRegion !== undefined) put("addressRegion", text(change.addressRegion, 80, "state or region"), "state");
  if (change.country !== undefined) {
    if (change.country !== null && !isCountry(change.country)) throw new KernelError("Pick a country from the list.");
    put("country", change.country, "country");
  }
  if (change.currency !== undefined) {
    if (!isCurrency(change.currency)) throw new KernelError("Pick a currency from the list.");
    put("currency", change.currency, "currency", (v) => v ?? "USD");
  }
  if (change.numberGrouping !== undefined) {
    if (change.numberGrouping !== "standard" && change.numberGrouping !== "indian") throw new KernelError("Pick how numbers are written.");
    put("numberGrouping", change.numberGrouping, "numbers", (v) => numbersText(v as string | null));
  }
  if (change.dateStyle !== undefined) {
    if (change.dateStyle !== "mdy" && change.dateStyle !== "dmy") throw new KernelError("Pick how dates are written.");
    put("dateStyle", change.dateStyle, "dates", (v) => datesText(v as string | null));
  }
  if (change.fiscalYearStart !== undefined) {
    const m = change.fiscalYearStart;
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new KernelError("Pick the month the year starts in.");
    put("fiscalYearStart", m, "yearStarts", (v) => MONTH_NAMES[((v as number | null) ?? 1) - 1]);
  }
  if (!Object.keys(set).length) return { changed: false };
  await tx.update(workspaces).set(set).where(eq(workspaces.id, ctx.workspaceId));
  forgetSetup();
  await record(tx, ctx, { who: ctx.actor.email, event: "settings.updated", details, at: ctx.now });
  return { changed: true };
}

async function personIn(tx: Tx, personId: string) {
  const [p] = await tx.select({ id: people.id, email: people.email, isAdmin: people.isAdmin }).from(people).where(eq(people.id, personId));
  if (!p) throw new KernelError("That person isn't in People.");
  return p;
}

export async function addAdmin(tx: Tx, ctx: KernelCtx, personId: string) {
  await mustBeAdmin(tx, ctx);
  const p = await personIn(tx, personId);
  if (p.isAdmin) return { changed: false };
  await tx.update(people).set({ isAdmin: true }).where(eq(people.id, p.id));
  forgetSetup();
  await record(tx, ctx, { who: ctx.actor.email, event: "admin.added", details: { person: p.email }, at: ctx.now });
  return { changed: true };
}

export async function removeAdmin(tx: Tx, ctx: KernelCtx, personId: string) {
  await mustBeAdmin(tx, ctx);
  const p = await personIn(tx, personId);
  if (!p.isAdmin) return { changed: false };
  const [ws] = await tx.select({ ownerId: workspaces.ownerId }).from(workspaces);
  if (ws?.ownerId === p.id) throw new KernelError("The owner stays an admin.");
  const admins = await tx.select({ id: people.id }).from(people).where(eq(people.isAdmin, true)).for("update");
  if (admins.length <= 1) throw new KernelError("The workspace needs at least one admin.");
  await tx.update(people).set({ isAdmin: false }).where(eq(people.id, p.id));
  forgetSetup();
  await record(tx, ctx, { who: ctx.actor.email, event: "admin.removed", details: { person: p.email }, at: ctx.now });
  return { changed: true };
}

// The logo's upload, for the sidebar (everyone sees it); null when the workspace has none.
export async function workspaceLogo(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ id: uploads.id }).from(workspaces).innerJoin(uploads, eq(uploads.key, workspaces.logoKey));
  return row?.id ?? null;
}

// The logo for anyone, signed in or not: the company's sign-in pages, its browser-tab icon and its emails show
// it. Only the logo, and only when it is an image; anything else answers as no logo.
export async function publicLogo(tx: Tx): Promise<{ mime: string; body: Uint8Array } | null> {
  const [row] = await tx.select({ key: uploads.key, mime: uploads.mime }).from(workspaces).innerJoin(uploads, eq(uploads.key, workspaces.logoKey));
  if (!row || !/^image\/(png|jpeg)$/.test(row.mime)) return null;
  const file = await getFile(row.key);
  return file ? { mime: row.mime, body: file.body } : null;
}
