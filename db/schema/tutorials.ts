import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { people, workspaces } from "./workspace";

// A capability's tutorial (0.4, M24): one per version and kind of access, written once (bike_app adds and reads).
export const tutorials = pgTable(
  "tutorials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    capabilityId: uuid("capability_id").notNull(),
    version: integer("version").notNull(),
    accessHash: text("access_hash").notNull(),
    page: jsonb("page").notNull(), // Tutorial (server/kernel/tutorial.ts)
    stepsHash: text("steps_hash").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tutorials_key").on(t.workspaceId, t.capabilityId, t.version, t.accessHash)],
);

// The tutorial each person last closed on a capability ("Got it").
export const tutorialSeen = pgTable(
  "tutorial_seen",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    capabilityId: uuid("capability_id").notNull(),
    tutorialId: uuid("tutorial_id").notNull(),
    stepsHash: text("steps_hash").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tutorial_seen_person").on(t.workspaceId, t.personId, t.capabilityId)],
);
