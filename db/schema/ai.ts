import { pgTable, uuid, text, timestamp, integer, numeric, boolean, index } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// Every AI call, for the cost report per prompt and the monthly budget. Append-only.
export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    prompt: text("prompt").notNull(), // capability-designer
    version: integer("version").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    cacheRead: integer("cache_read").notNull().default(0),
    cacheWrite: integer("cache_write").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    credits: integer("credits").notNull().default(0), // what the company is charged (P1): creditsFor(costUsd)
    ms: integer("ms").notNull(),
    personId: uuid("person_id").references(() => people.id),
    capabilityId: uuid("capability_id"),
    chatId: uuid("chat_id"),
    attempt: integer("attempt").notNull().default(1), // 2 for the one retry
    passed: boolean("passed").notNull(), // the output passed the schema and the kernel's checks
    problem: text("problem"), // why it didn't, in the kernel's words
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_calls_workspace_at").on(t.workspaceId, t.at)],
);

// Top-ups the Bike team grants (P1; agreed in writing until there's a checkout). Append-only.
export const aiCreditGrants = pgTable(
  "ai_credit_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    credits: integer("credits").notNull(),
    kind: text("kind").notNull(), // top_up | adjust
    note: text("note"),
    by: text("by").notNull(), // who on the Bike team
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_credit_grants_workspace_at").on(t.workspaceId, t.at)],
);
