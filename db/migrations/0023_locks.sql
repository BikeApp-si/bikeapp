-- What the app may never do, refused by the database itself for every user, on top of the grants. On a
-- managed host the app's role can write any table (Fly's "writer" holds pg_write_all_data) and its grants
-- can't be narrowed; these triggers keep the same rules there: the Audit log, AI log and other records are
-- append-only, rows and chats are never deleted outright, and jobs and proposals change only their state.
-- Statement triggers, so a refusal holds even when no row matches (db:check proves it on an empty database).
-- A future migration that must change such a table disables the trigger for that statement.

CREATE FUNCTION bike_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'permission denied for table %: % is not allowed', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

-- Row by row, for tables where only some columns may change: anything else changed is refused.
CREATE FUNCTION bike_only_columns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed text;
BEGIN
  SELECT string_agg(n.key, ', ') INTO changed
  FROM jsonb_each(to_jsonb(NEW)) AS n
  WHERE NOT (n.key = ANY (TG_ARGV)) AND (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'permission denied for table %: % may not change', TG_TABLE_NAME, changed USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DO $$
DECLARE t text; cols text;
BEGIN
  -- Written once, never changed or removed.
  FOREACH t IN ARRAY ARRAY['ai_calls', 'audit_entries', 'capability_versions', 'change_sets', 'customize_suggestions', 'reports', 'rule_runs', 'morning_emails', 'workspace_holidays'] LOOP
    EXECUTE format('CREATE TRIGGER bike_no_update BEFORE UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()', t);
    EXECUTE format('CREATE TRIGGER bike_no_delete BEFORE DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()', t);
    EXECUTE format('CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()', t);
  END LOOP;

  -- Changed, never removed (a deleted row or capability is marked, not erased).
  FOREACH t IN ARRAY ARRAY['capabilities', 'rows', 'chats', 'messages', 'plans', 'coherence_checks', 'ontologies', 'waits', 'outbox', 'ai_steps', 'jobs', 'proposals'] LOOP
    EXECUTE format('CREATE TRIGGER bike_no_delete BEFORE DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()', t);
    EXECUTE format('CREATE TRIGGER bike_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()', t);
  END LOOP;

  -- Jobs change only their state; proposals only their decision. Naming another column in an UPDATE is
  -- refused outright; the row trigger also catches a change to a column added later.
  FOR t, cols IN SELECT * FROM (VALUES ('jobs', 'status,error,started_at,finished_at'), ('proposals', 'status,decided_by,decided_at')) AS v(tbl, allowed) LOOP
    EXECUTE format(
      'CREATE TRIGGER bike_fixed_columns BEFORE UPDATE OF %s ON %I FOR EACH STATEMENT EXECUTE FUNCTION bike_refuse()',
      (SELECT string_agg(quote_ident(column_name), ', ') FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND NOT (column_name = ANY (string_to_array(cols, ',')))),
      t);
    EXECUTE format('CREATE TRIGGER bike_only_columns BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bike_only_columns(%s)',
      t, (SELECT string_agg(quote_literal(c), ', ') FROM unnest(string_to_array(cols, ',')) AS c));
  END LOOP;
END $$;
