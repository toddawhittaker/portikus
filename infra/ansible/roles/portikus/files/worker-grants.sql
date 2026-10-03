-- The worker's database privileges, and nothing more (SPEC.md section 24.9,
-- docs/adr/0044-backups-on-the-server.md).  Run as postgres after the
-- migrations by setup, the package's postinst and restore, with psql and
-- ON_ERROR_STOP but without --single-transaction: the file has its own.
-- It revokes everything first, so the grants below are the whole list.
-- A worker query on a new table or with a new verb needs a line here;
-- apps/worker/src/grants.test.ts fails until it has one.
-- Never grant anything on sessions, preview_grants, preview_sessions, the
-- lti_ and account_link tables, or write on users: with those a worker
-- could sign itself in as an administrator.

-- Releases up to 0.1.676 made the worker a member of portikus.  This runs
-- on its own, before the transaction, so it holds even if a grant fails.
DO $$ BEGIN
	IF EXISTS (
		SELECT FROM pg_auth_members m
		JOIN pg_roles g ON g.oid = m.roleid
		JOIN pg_roles w ON w.oid = m.member
		WHERE g.rolname = 'portikus' AND w.rolname = 'portikus-worker'
	) THEN
		REVOKE portikus FROM "portikus-worker";
	END IF;
END $$;

BEGIN;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "portikus-worker";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "portikus-worker";

GRANT SELECT ON users TO "portikus-worker";
GRANT SELECT ON egress_entries, egress_blocked_entries TO "portikus-worker";
GRANT INSERT ON audit_events TO "portikus-worker";

-- Seeds the first row; changes only the egress apply outcome after that.
GRANT SELECT ON settings TO "portikus-worker";
GRANT INSERT (id, shutdown_grace_seconds) ON settings TO "portikus-worker";
GRANT UPDATE (egress_applied_version, egress_applied_at, egress_apply_error,
	controller_checked_at)
	ON settings TO "portikus-worker";

GRANT SELECT, UPDATE ON workspaces, terminals, projects, backup_status
	TO "portikus-worker";
GRANT DELETE ON terminals TO "portikus-worker";
GRANT SELECT, UPDATE, DELETE ON workspace_process_snapshots TO "portikus-worker";
GRANT SELECT, INSERT, UPDATE ON backup_requests, package_survey_counts
	TO "portikus-worker";
GRANT SELECT, INSERT, DELETE ON notifications, recovery_points,
	workspace_usage_samples TO "portikus-worker";
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_connections, health_samples,
	egress_blocked_names, package_survey_days TO "portikus-worker";

-- Shared Docker pull storage (ADR 0045): seed jobs, the seed and usage.
GRANT SELECT, UPDATE, DELETE ON docker_seed_jobs TO "portikus-worker";
GRANT SELECT, INSERT, DELETE ON docker_image_presence TO "portikus-worker";
GRANT SELECT, INSERT, UPDATE, DELETE ON docker_seed TO "portikus-worker";
GRANT SELECT, INSERT, UPDATE, DELETE ON docker_image_pulls TO "portikus-worker";

GRANT USAGE ON SEQUENCE audit_events_id_seq, health_samples_id_seq,
	workspace_usage_samples_id_seq TO "portikus-worker";

COMMIT;
