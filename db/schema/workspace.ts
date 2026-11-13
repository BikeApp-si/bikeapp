import { pgTable, uuid, text, timestamp, boolean, date, bigint, integer, jsonb, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The address. Kept in one column so a later rename is a small change.
  subdomain: text("subdomain").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  logoKey: text("logo_key"),
  trial: text("trial"), // the trial link it was created from (its label), or null (M10b)
  // P1: the plan and when its paid months started; Enterprise's monthly credits are agreed. A new company is on its
  // free trial until trial_ends_at, and paid from paid_at (set by the Bike team), when its months start.
  plan: text("plan").notNull().default("business"), // business | education | enterprise
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  planStartedAt: timestamp("plan_started_at", { withTimezone: true }).notNull().defaultNow(),
  planMonthlyCredits: integer("plan_monthly_credits"),
  timeZone: text("time_zone").notNull(),
  region: text("region").notNull().default("sin"),
  // The person who created the workspace (9b: "Owner"). Always an admin; can't be removed.
  ownerId: uuid("owner_id").references((): AnyPgColumn => people.id),
  // From setup 2c (prompt 8 reads them; "Set from your address" is the kernel's); Settings shows them (M26).
  street: text("street"),
  city: text("city"),
  addressRegion: text("address_region"), // state or province ("TX"); `region` above is where Bike runs
  country: text("country"), // ISO 3166 alpha-2
  website: text("website"),
  whatItDoes: text("what_it_does"),
  businessModel: text("business_model"),
  products: text("products").array(),
  currency: text("currency"),
  holidayCountry: text("holiday_country"),
  fiscalYearStart: integer("fiscal_year_start"), // 1 = January
  numberGrouping: text("number_grouping"), // standard (1,234,567) | indian (12,34,567); empty is standard
  dateStyle: text("date_style"), // mdy ("Nov 14, 2026") | dmy ("14 Nov 2026"); empty is mdy
  // The setup conversation while it runs (2b–2e); cleared when setup is done. Not a chat.
  setup: jsonb("setup"),
  setupDoneAt: timestamp("setup_done_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The order people were added in (7f lists them so).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    title: text("title"),
    team: text("team"),
    managerId: uuid("manager_id").references((): AnyPgColumn => people.id),
    // Set when an import named a manager who isn't in People ("No manager" on 7f).
    managerFlag: text("manager_flag"),
    startDate: date("start_date"),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Founder, Team lead, Ops, Finance or Member, set at setup (2e). A label only: access never reads it.
    setupRole: text("setup_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // M31: when they last opened the Inbox's Updates; later entries read as new. Null until the first time.
    inboxSeenAt: timestamp("inbox_seen_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("people_workspace_email").on(t.workspaceId, sql`lower(${t.email})`)],
);

// Public holidays a company's policies list, kept by a build with where they came from (4d, the Ontology).
// None listed, none stored: Bike has no holiday list of its own.
export const workspaceHolidays = pgTable(
  "workspace_holidays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    date: date("date").notNull(),
    name: text("name").notNull(),
    file: text("file").notNull(), // the document that lists it
    page: integer("page"), // its page there, when the document has pages
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("workspace_holidays_date").on(t.workspaceId, t.date)],
);

// The Ontology (4e): the current version per workspace; every version is also kept in ontology_versions (M34). What prompt 6 wrote, checked by
// the kernel, with the hash of what it was written from, so the same inputs aren't written twice.
export const ontologies = pgTable("ontologies", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  version: integer("version").notNull(),
  inputHash: text("input_hash").notNull(),
  written: jsonb("written").notNull(), // { intro, paragraphs[], sentences{}, phrases{}, worth[] }
  writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
  writtenBy: uuid("written_by").references((): AnyPgColumn => people.id),
});

// Every version of the Ontology (0.5, M34), written once and kept: what prompt 6 wrote, when and by whom, and the
// app versions it read ({ id, name, version }). Shown read only on the Ontology's Versions; never restored.
export const ontologyVersions = pgTable(
  "ontology_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    version: integer("version").notNull(),
    inputHash: text("input_hash").notNull(),
    written: jsonb("written").notNull(),
    read: jsonb("read").notNull(), // [{ id, name, version }]
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
    writtenBy: uuid("written_by").references((): AnyPgColumn => people.id),
  },
  (t) => [uniqueIndex("ontology_versions_once").on(t.workspaceId, t.version)],
);

// The coherence check (prompt 4's coherence mode): gaps and contradictions across the capability files, shown
// on the Ontology under Worth a look. One current result per workspace, with the hash of the texts it read.
export const coherenceChecks = pgTable("coherence_checks", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  inputHash: text("input_hash").notNull(),
  items: jsonb("items").notNull(), // [{ text, capabilities[] }]
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});
