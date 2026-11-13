import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, index } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// Append-only: bike_app may INSERT and SELECT, nothing else.
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The order entries were written in, for entries with the same time.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // A person's email, or rule:<id> / ai_step:<id>.
    who: text("who").notNull(),
    whoLabel: text("who_label"),
    capabilityId: uuid("capability_id"),
    event: text("event").notNull(),
    details: jsonb("details").notNull().default({}),
    changeSetId: uuid("change_set_id"),
    chatId: uuid("chat_id"),
    // The rows an entry is about (0.4, M22), so a row's History can read it back.
    rowIds: uuid("row_ids").array(),
  },
  (t) => [index("audit_entries_workspace_at").on(t.workspaceId, t.at), index("audit_entries_rows").using("gin", t.rowIds)],
);

export const uploads = pgTable("uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  uploadedBy: uuid("uploaded_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
