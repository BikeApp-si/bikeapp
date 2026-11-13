import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { people, workspaces } from "./workspace";

// A note on a row (0.4, M22): a person's short text with its time, fixed once posted (bike_app may only add and read).
export const rowNotes = pgTable(
  "row_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull(),
    rowId: uuid("row_id").notNull(),
    authorId: uuid("author_id").notNull().references(() => people.id),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("row_notes_row").on(t.workspaceId, t.rowId)],
);
