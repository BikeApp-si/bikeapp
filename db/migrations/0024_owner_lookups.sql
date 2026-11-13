-- The address lookups (workspace_by_subdomain, subdomain_taken) and the worker's list of workspaces
-- (all_workspaces) run as the owner of those functions (SECURITY DEFINER), across every workspace. A
-- superuser owner (dev) isn't held by row-level security; a managed host's owner (Fly's schema_admin) is,
-- since workspaces forces RLS. So the owner may read workspaces, and nothing more: the app's role isn't the
-- owner and gains nothing.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY owner_lookups ON workspaces FOR SELECT TO %I USING (true)',
    (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = 'workspace_by_subdomain'));
END $$;
