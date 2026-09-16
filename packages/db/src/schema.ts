import type { ColumnType, Generated } from "kysely";

/**
 * Kysely Database interface for the Portikus control plane.
 * Tables match migration 0001_workspaces (SPEC section 26, STACK section 6).
 */
export interface Database {
	workspaces: WorkspacesTable;
	workspace_connections: WorkspaceConnectionsTable;
	audit_events: AuditEventsTable;
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
	last_active_connection_at: ColumnType<Date, string | null, string | null>;
	shutdown_deadline: ColumnType<Date, string | null, string | null>;
	created_at: ColumnType<Date, string | undefined, never>;
	updated_at: ColumnType<Date, string | undefined, string>;
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
