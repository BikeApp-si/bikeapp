import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, index, uniqueIndex, date } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// Chats with Bike. A chat is private to the admin who wrote it: RLS shows a chat, its messages and its plans
// only to its author, and the kernel checks it too.
export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    authorId: uuid("author_id").notNull().references(() => people.id),
    title: text("title"), // written after the first reply
    kind: text("kind").notNull(), // capability | customize | report | build
    capabilityIds: jsonb("capability_ids").notNull().default([]), // the capabilities it touched
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chats_author").on(t.workspaceId, t.authorId, t.updatedAt)],
);

// One message from the person or from Bike: text plus structured parts (tables, plan cards, buttons, a
// Step / Status list). A Bike message is written as it is worked on, so its parts can change until done.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    chatId: uuid("chat_id").notNull().references(() => chats.id),
    from: text("from").notNull(), // person | bike
    text: text("text").notNull().default(""),
    parts: jsonb("parts").notNull().default([]),
    status: text("status").notNull().default("done"), // working | done | failed
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_chat").on(t.chatId, t.seq)],
);

// A plan for a new capability, as the kernel checked it: each reply that changes it makes a new version and
// marks the one before replaced. Nothing in a plan is live until Create.
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    chatId: uuid("chat_id").notNull().references(() => chats.id),
    messageId: uuid("message_id").references(() => messages.id),
    version: integer("version").notNull(),
    draft: jsonb("draft").notNull(),
    status: text("status").notNull().default("waiting"), // waiting | replaced | created
    capabilityId: uuid("capability_id"), // once created
    changeSetId: uuid("change_set_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("plans_version").on(t.chatId, t.version)],
);

// One run of a report (11c–12d): the query prompt 7 wrote (the kernel's schema, never SQL), what came back,
// when and as whom. Run again adds a run; the first stays. Seen through its chat, so only by its author.
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    chatId: uuid("chat_id").notNull().references(() => chats.id),
    messageId: uuid("message_id").notNull().references(() => messages.id),
    firstId: uuid("first_id"), // a Run again's first run
    title: text("title").notNull(),
    query: jsonb("query").notNull(),
    chart: text("chart").notNull(), // bar | line | none
    series: jsonb("series").notNull().default([]), // what the chart draws: [{ column, role: measure | comparison | target }]
    how: jsonb("how").notNull(), // "How it was worked out", line by line
    missing: text("missing"),
    sentence: text("sentence").notNull(),
    result: jsonb("result").notNull(), // columns, rows, sources
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
    ranAs: uuid("ran_as").notNull().references(() => people.id),
  },
  (t) => [index("reports_chat").on(t.chatId, t.ranAt)],
);

// M33: a report its author saved (Reports, under Chats), by its first run; Run again's runs stay with it. every: when
// it's emailed to the author (null: not emailed). Unsaving keeps the row (unsavedAt); saving again clears it. Only its
// author reads it (RLS; the daily job, acting as nobody, reads every one to find what is due).
export const savedReports = pgTable(
  "saved_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    authorId: uuid("author_id").notNull().references(() => people.id),
    chatId: uuid("chat_id").notNull().references(() => chats.id),
    firstId: uuid("first_id").notNull().references(() => reports.id),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
    unsavedAt: timestamp("unsaved_at", { withTimezone: true }),
    every: jsonb("every"), // { unit: day } | { unit: week, weekday: 1–7 } | { unit: month, day: 1–31 }
    everySince: date("every_since"), // the first day it may be sent: the day the schedule was set
    stoppedWhy: text("stopped_why"), // set when Bike stopped emailing it (its author is no longer an admin)
  },
  (t) => [uniqueIndex("saved_reports_first").on(t.workspaceId, t.firstId), index("saved_reports_author").on(t.workspaceId, t.authorId)],
);

// M33: each scheduled email, once per saved report and date: the run it sent, or why it couldn't run.
export const reportSends = pgTable(
  "report_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    savedId: uuid("saved_id").notNull().references(() => savedReports.id),
    onDate: date("on_date").notNull(),
    reportId: uuid("report_id").references(() => reports.id),
    refused: text("refused"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("report_sends_once").on(t.savedId, t.onDate)],
);
