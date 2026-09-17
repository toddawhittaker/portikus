import type { ColumnType, Generated } from "kysely";

/**
 * Kysely Database interface for the Portikus control plane.
 * Tables match migrations 0001_workspaces, 0002_users_sessions,
 * 0003_terminals, and 0004_projects
 * (SPEC section 26, STACK section 6).
 */
export interface Database {
	users: UsersTable;
	sessions: SessionsTable;
	workspaces: WorkspacesTable;
	workspace_connections: WorkspaceConnectionsTable;
	terminals: TerminalsTable;
	projects: ProjectsTable;
	audit_events: AuditEventsTable;
}

export interface UsersTable {
	id: Generated<string>;
	oidc_issuer: string;
	oidc_subject: string;
	email: string | null;
	display_name: string;
	role: string;
	disabled_at: ColumnType<Date | null, string | null, string | null>;
	last_login_at: ColumnType<Date | null, string | null, string | null>;
	created_at: ColumnType<Date, string | undefined, never>;
	updated_at: ColumnType<Date, string | undefined, string>;
}

export interface SessionsTable {
	id: string;
	user_id: string;
	created_at: ColumnType<Date, string | undefined, never>;
	expires_at: ColumnType<Date, string, string>;
}

export interface WorkspacesTable {
	id: Generated<string>;
	owner_user_id: string;
	incus_instance_name: string | null;
	state: string;
	desired_state: Generated<string>;
	image_version: string | null;
	quota_config: ColumnType<
		{ homeGiB: number; dockerGiB: number } | null,
		string | null,
		string | null
	>;
	error_code: string | null;
	error_message: string | null;
	last_active_connection_at: ColumnType<Date | null, string | null, string | null>;
	shutdown_deadline: ColumnType<Date | null, string | null, string | null>;
	agent_token: string | null;
	agent_address: string | null;
	created_at: ColumnType<Date, string | undefined, never>;
	updated_at: ColumnType<Date, string | undefined, string>;
}

export interface TerminalsTable {
	id: Generated<string>;
	workspace_id: string;
	name: string;
	cwd: string;
	position: Generated<number>;
	project_id: string | null;
	created_at: ColumnType<Date, string | undefined, never>;
	ended_at: ColumnType<Date | null, string | null, string | null>;
}

export interface ProjectsTable {
	id: Generated<string>;
	workspace_id: string;
	slug: string;
	name: string;
	path: string;
	state: Generated<string>;
	source: string;
	layout: ColumnType<Record<string, unknown> | null, string | null, string | null>;
	created_at: ColumnType<Date, string | undefined, never>;
	archived_at: ColumnType<Date | null, string | null, string | null>;
}

export interface WorkspaceConnectionsTable {
	id: Generated<string>;
	workspace_id: string;
	connected_at: ColumnType<Date, string | undefined, never>;
	last_seen_at: ColumnType<Date, string | undefined, string>;
}

export interface AuditEventsTable {
	id: Generated<number>;
	actor: string;
	target: string;
	action: string;
	at: ColumnType<Date, string | undefined, never>;
	result: string;
	metadata: ColumnType<Record<string, unknown> | null, string | null, string | null>;
}
