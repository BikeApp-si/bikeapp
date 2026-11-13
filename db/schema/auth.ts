import { pgTable, uuid, text, timestamp, integer, index, smallint, numeric } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// A sign up on the root host, before its workspace exists. Only visible with no workspace set.
export const signups = pgTable("signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company").notNull(),
  invite: text("invite"), // the trial link's code it came through (M10b)
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One emailed code. Sign in: workspace + person. Sign up: signup, no workspace.
export const authCodes = pgTable(
  "auth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    personId: uuid("person_id").references(() => people.id),
    signupId: uuid("signup_id").references(() => signups.id),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    triesLeft: integer("tries_left").notNull().default(5),
    usedAt: timestamp("used_at", { withTimezone: true }),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_codes_email").on(t.email, t.createdAt)],
);

// Sliding-window rate limits by IP and by email. Holds no workspace data.
export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limit_events_key_at").on(t.key, t.at)],
);

export const sessions = pgTable("sessions", {
  // sha256 of the cookie value; the raw value is never stored.
  id: text("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Sign up → the new subdomain: 60 seconds, one use.
export const handoffTokens = pgTable("handoff_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// The open Bike's first run (O2): one row, the setup code written to Bike's log. Only visible with no workspace set.
export const instanceSetup = pgTable("instance_setup", {
  id: smallint("id").primaryKey().default(1),
  codeHash: text("code_hash").notNull(),
  triesLeft: integer("tries_left").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  doneAt: timestamp("done_at", { withTimezone: true }),
});

// The open Bike's own settings (O3): the company's Anthropic key, sealed, and the monthly AI cap. One row, only
// visible with no workspace set.
export const instanceSettings = pgTable("instance_settings", {
  id: smallint("id").primaryKey().default(1),
  aiKeySealed: text("ai_key_sealed"),
  aiKeyLast4: text("ai_key_last4"),
  aiCapUsd: numeric("ai_cap_usd", { precision: 10, scale: 2 }),
  // O4: the newest release GitHub named, its page, and when Bike last asked (UPDATE_CHECK=off: never).
  latestVersion: text("latest_version"),
  latestUrl: text("latest_url"),
  releaseCheckedAt: timestamp("release_checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
