import { sql, type SQL } from "drizzle-orm";
import { rows } from "@/db/schema";

// A row whose data holds this id in this column (a link to a row, or a person). Written as containment so the
// index on rows.data serves it (0028_rows_data_index.sql); the same rows as data->>column = id, for ids are
// always stored as text (M12, docs/kernel-study.md).
export const holds = (column: string, id: string): SQL => sql`${rows.data} @> ${JSON.stringify({ [column]: id })}::jsonb`;
