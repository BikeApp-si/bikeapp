import { boolean, pgTable, uuid, text, timestamp, jsonb, integer, bigint, index, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { workspaces, people } from "./workspace";

// A capability points at its current file; the files themselves are in capability_versions.
export const capabilities = pgTable("capabilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The sidebar's order: the order capabilities were added to the workspace.
  position: bigint("position", { mode: "number" }).generatedAlwaysAsIdentity(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  // Its icon's colour (0.4, M23): set when it's created, never changed (lib/cap-colors.ts).
  color: text("color").notNull().default("violet"),
  // Its tutorial card (0.4, M24): shown on capabilities created from now on and after a Customize change, which
  // change_title names ("Legal review step").
  introduce: boolean("introduce").notNull().default(true),
  changeTitle: text("change_title"),
  ownerId: uuid("owner_id").references(() => people.id),
  currentVersion: integer("current_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// All or nothing: one change touching one or more capabilities. Insert and select only.
export const changeSets = pgTable("change_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  source: text("source").notNull(), // customize | plan | build | gallery
  kind: text("kind").notNull().default("add"), // add | restructure (M27: it also moved rows)
  setName: text("set_name"), // gallery (G1): the app set added, and its version
  setVersion: integer("set_version"),
  chatId: uuid("chat_id"),
  items: jsonb("items").notNull().default([]), // [{ capabilityId, fromVersion, toVersion }]
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Never updated: a change writes a new row.
export const capabilityVersions = pgTable(
  "capability_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    version: integer("version").notNull(),
    file: jsonb("file").notNull(),
    changeSetId: uuid("change_set_id").references(() => changeSets.id),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capability_versions_cap_version").on(t.capabilityId, t.version)],
);

// Customize's suggestion chips for one version of a capability (6b, 6g), written once by the small model after
// the version is saved. Insert and select only, like the versions.
export const customizeSuggestions = pgTable(
  "customize_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    version: integer("version").notNull(),
    items: jsonb("items").notNull(), // the chips' text, in order
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customize_suggestions_cap_version").on(t.capabilityId, t.version)],
);

// Every sheet's rows. data is keyed by column id; file_version is the version it was last written under.
export const rows = pgTable(
  "rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The order rows were written in: lines keep the order they were entered.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id),
    sheetId: text("sheet_id").notNull(),
    data: jsonb("data").notNull().default({}),
    // A copy of the step column's value, for Waiting on me.
    stepId: text("step_id"),
    fileVersion: integer("file_version").notNull(),
    // Lines point to their document row.
    parentRowId: uuid("parent_row_id").references((): AnyPgColumn => rows.id),
    createdBy: uuid("created_by").references(() => people.id),
    // M31: it came in through an import (an import sends nothing in the Inbox).
    imported: boolean("imported").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("rows_workspace_sheet").on(t.workspaceId, t.capabilityId, t.sheetId),
    index("rows_parent").on(t.parentRowId),
    // rows_data_holds: a GIN index on data (jsonb_path_ops), in 0028_rows_data_index.sql; see server/kernel/holds.ts.
  ],
);
