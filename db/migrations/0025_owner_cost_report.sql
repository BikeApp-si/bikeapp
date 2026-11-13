-- The AI cost report (pnpm ai:cost) reads, as the owner, every workspace's AI log and the chats, plans and
-- capability names a build cost is set against. On a managed host the owner is held by row-level security
-- (these tables force it), so it may read them, and nothing more; the app's role isn't the owner.
DO $$
DECLARE t text; owner text := (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = 'workspace_by_subdomain');
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_calls', 'chats', 'plans', 'capabilities'] LOOP
    EXECUTE format('CREATE POLICY owner_cost_report ON %I FOR SELECT TO %I USING (true)', t, owner);
  END LOOP;
END $$;
