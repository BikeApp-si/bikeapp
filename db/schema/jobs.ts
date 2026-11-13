import { pgTable, uuid, text, timestamp, jsonb, index, bigint } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// Work that runs in the worker, not in the request: a plan, Create, an import, Build all, an AI step, the
// Ontology. The app adds a job in the same transaction as the messages it shows; a notify on insert wakes the
// worker, which runs it through the kernel as the person who asked (or as the system).
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    personId: uuid("person_id").references(() => people.id), // who asked; none for the system
    kind: text("kind").notNull(), // design | import | import-into | create | build-read | build | ai-step | ontology
    payload: jsonb("payload").notNull(),
    messageId: uuid("message_id"), // Bike's reply it writes to, if any
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(), // the order queued, when the time is the same
  },
  (t) => [index("jobs_queued").on(t.workspaceId, t.status, t.createdAt), index("jobs_message").on(t.messageId)],
);
