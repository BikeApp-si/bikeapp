import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { people, workspaces } from "./workspace";

// Saved views of a sheet (0.4, M19): its filters, sort and columns under a name. A view with an owner is that person's
// own; one without is shared with everyone who can see the sheet (an admin of the capability shares it).
export const savedViews = pgTable(
  "views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull(),
    sheetId: text("sheet_id").notNull(),
    ownerId: uuid("owner_id").references(() => people.id), // null: shared
    name: text("name").notNull(),
    filters: jsonb("filters").notNull(), // Filter[] (server/kernel/query.ts)
    sort: jsonb("sort"), // Sort | null
    columns: jsonb("columns"), // { order: string[]; hidden: string[] } | null: the person's own columns
    layout: text("layout").notNull().default("table"), // "table" | "board" (0.4, M20)
    groupBy: jsonb("group_by"), // GroupBy | null (server/kernel/query.ts)
    position: integer("position").notNull().default(0),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("views_sheet").on(t.workspaceId, t.capabilityId, t.sheetId)],
);

// How a person arranges a sheet's table (0.4, M19): column order, hidden columns, widths and a frozen first column.
export const tablePrefs = pgTable(
  "table_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    capabilityId: uuid("capability_id").notNull(),
    sheetId: text("sheet_id").notNull(),
    columns: jsonb("columns").notNull(), // { order: string[]; hidden: string[]; widths: Record<string, number>; frozen: boolean }
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("table_prefs_person_sheet").on(t.workspaceId, t.personId, t.capabilityId, t.sheetId)],
);
