import { pgTable, uuid, text, timestamp, jsonb, integer, date, index, uniqueIndex, real, boolean } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";
import { capabilities, rows } from "./kernel";

// A row waiting on one person because a rule asked them (ask_person). It ends when the row leaves the step,
// when the column it waits for is filled, or when the person decides. Never deleted: cleared_at says when.
export const waits = pgTable(
  "waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    rowId: uuid("row_id").notNull().references(() => rows.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    ruleSource: text("rule_source").notNull(), // where the rule came from (rule-set.ts): "capability:<id>"
    ruleId: text("rule_id").notNull(),
    stepId: text("step_id"), // waits while the row is at this step
    untilColumn: text("until_column"), // waits until this column is filled
    label: text("label"), // what they are asked to do ("Your scorecard")
    why: text("why"), // "you are Maya Chen's manager"
    decision: jsonb("decision"), // { column, approve, decline } when they are asked to decide
    decided: text("decided"), // the option written: approve or decline
    decidedBy: uuid("decided_by").references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [index("waits_person_open").on(t.workspaceId, t.personId, t.clearedAt), index("waits_row").on(t.rowId)],
);

// A date rule runs at most once per row and date.
export const ruleRuns = pgTable(
  "rule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    ruleSource: text("rule_source").notNull(), // where the rule came from (rule-set.ts): "capability:<id>"
    ruleId: text("rule_id").notNull(),
    rowId: uuid("row_id").notNull().references(() => rows.id),
    // The date the rule counts from (the notice date, or the day the row was added): once per row and base
    // date, so a rule moved earlier doesn't remind a row twice for the same notice date.
    baseDate: date("base_date").notNull(),
    onDate: date("on_date").notNull(), // the date the rule counts to, not the day it ran
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("rule_runs_once").on(t.ruleSource, t.ruleId, t.rowId, t.baseDate)],
);

// M32: a repeating rule adds its rows at most once per date of its schedule. It has no row to start from, so
// its runs are kept here rather than in rule_runs.
export const repeatRuns = pgTable(
  "repeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    ruleSource: text("rule_source").notNull(), // where the rule came from (rule-set.ts): "capability:<id>"
    ruleId: text("rule_id").notNull(),
    onDate: date("on_date").notNull(), // the date of the schedule it added for, not the day it ran
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("repeat_runs_once").on(t.workspaceId, t.ruleSource, t.ruleId, t.onDate)],
);

// Emails written in a transaction and sent after it commits, so a write that is rolled back sends nothing.
export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  kind: text("kind").notNull(), // notify, morning, ready, report (M33)
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// AI steps a rule queued; milestone 7 runs them and turns each answer into a Proposal.
export const aiSteps = pgTable("ai_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
  ruleSource: text("rule_source").notNull(),
  ruleId: text("rule_id").notNull(),
  rowId: uuid("row_id").notNull().references(() => rows.id),
  question: text("question").notNull(),
  columnId: text("column_id"),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// One morning email per person per day, at most.
export const morningEmails = pgTable(
  "morning_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    onDate: date("on_date").notNull(),
    items: integer("items").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("morning_emails_once").on(t.personId, t.onDate)],
);

// A value an AI step suggested for a row (8h): never written into the row until a person confirms it or
// changes it. Its confidence is kept; "sure" is 0.8 or more (one kernel constant).
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    rowId: uuid("row_id").notNull().references(() => rows.id),
    columnId: text("column_id").notNull(),
    aiStepId: uuid("ai_step_id").notNull().references(() => aiSteps.id),
    value: jsonb("value").notNull(), // as the column stores it (a choice's id)
    reason: text("reason").notNull(),
    confidence: real("confidence").notNull(),
    personId: uuid("person_id").references(() => people.id), // who confirms; none, whoever can edit the row
    status: text("status").notNull().default("waiting"), // waiting | confirmed | changed
    decidedBy: uuid("decided_by").references(() => people.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("proposals_row").on(t.rowId), index("proposals_waiting").on(t.workspaceId, t.personId, t.status)],
);

// The Monday email (0.5, M34): at most one per admin and week, the week named by its Monday.
export const weeklyEmails = pgTable(
  "weekly_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    weekOf: date("week_of").notNull(),
    quiet: boolean("quiet").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("weekly_emails_once").on(t.personId, t.weekOf)],
);
