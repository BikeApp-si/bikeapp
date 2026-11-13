import { index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { changeSets } from "./kernel";
import { people, workspaces } from "./workspace";

// The company's rules (0.2): the whole list, one row per version, never changed; the newest is current.
export const companyRules = pgTable(
  "company_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    version: integer("version").notNull(),
    rules: jsonb("rules").notNull(), // CompanyRule[] (server/kernel/schema/company.ts)
    changeSetId: uuid("change_set_id").references(() => changeSets.id),
    chatId: uuid("chat_id"),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("company_rules_workspace_version").on(t.workspaceId, t.version), index("company_rules_workspace").on(t.workspaceId)],
);
