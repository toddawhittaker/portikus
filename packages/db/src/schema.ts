import type { ColumnType, Generated } from "kysely";

/**
 * Kysely Database interface for the Portikus control plane.
 * Tables match migrations 0001_workspaces, 0002_users_sessions,
 * 0003_terminals, 0004_projects, 0005_settings, 0006_log_level,
 * 0007_editor_settings, 0008_preview, 0009_project_directory_id, and
 * 0010_terminal_theme, 0011_terminal_agent, 0012_profile, 0013_recovery, 0014_admin, 0015_lti, and 0016_account_links
 * (SPEC section 26, STACK section 6).
 */
export interface Database {
	users: UsersTable;
	sessions: SessionsTable;
	workspaces: WorkspacesTable;
	workspace_connections: WorkspaceConnectionsTable;
	terminals: TerminalsTable;
	projects: ProjectsTable;
	settings: SettingsTable;
	audit_events: AuditEventsTable;
	preview_grants: PreviewGrantsTable;
	preview_sessions: PreviewSessionsTable;
	recovery_points: RecoveryPointsTable;
	health_samples: HealthSamplesTable;
	lti_login_states: LtiLoginStatesTable;
	lti_contexts: LtiContextsTable;
	lti_memberships: LtiMembershipsTable;
	account_links: AccountLinksTable;
	account_link_intents: AccountLinkIntentsTable;
}

export interface UsersTable {
	id: Generated<string>;
	oidc_issuer: string;
	oidc_subject: string;
	email: string | null;
	display_name: string;
	/** The effective role every check reads: the higher of the two below. */
	role: string;
	/** The role this account's own sign-in gave last time; defaults to `role` on insert. */
	provider_role: ColumnType<string, string | undefined, string>;
	/** Null, instructor or administrator, stored by Portikus; never on an `lti:` account. */
	granted_role: ColumnType<string | null, string | null | undefined, string | null>;
	/** The `preferred_username` claim; the workspace label comes from it. */
	preferred_username: string | null;
	disabled_at: ColumnType<Date | null, string | null, string | null>;
	/** Per-user grace period override; null means use the global setting. */
	shutdown_grace_seconds: number | null;
	/** Editor preferences the user has changed; the API fills in the rest. */
	editor_settings: ColumnType<Record<string, unknown>, string | undefined, string>;
	last_login_at: ColumnType<Date | null, string | null, string | null>;
	/** Optional profile links (issue #300); never used for authorization. */
	profile_github: string | null;
	profile_website: string | null;
	/** The profile picture, png or jpeg, capped by the API. */
	picture: Buffer | null;
	picture_type: string | null;
	picture_updated_at: ColumnType<Date | null, string | null, string | null>;
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
	/** DNS label naming the container hostname and preview hosts (Epic 8). */
	label: string;
	incus_instance_name: string | null;
	state: string;
	desired_state: Generated<string>;
	image_version: string | null;
	quota_config: ColumnType<
		{ homeGiB: number; dockerGiB: number; recoveryGiB?: number } | null,
		string | null,
		string | null
	>;
	error_code: string | null;
	error_message: string | null;
	last_active_connection_at: ColumnType<Date | null, string | null, string | null>;
	shutdown_deadline: ColumnType<Date | null, string | null, string | null>;
	disconnected_at: ColumnType<Date | null, string | null, string | null>;
	agent_token: string | null;
	agent_address: string | null;
	/** "reset-docker", "rebuild" or "rebuild-reset-docker" (ADR 0021). */
	pending_operation: string | null;
	pending_operation_at: ColumnType<Date | null, string | null, string | null>;
	/** The user id that asked for the operation. */
	pending_operation_by: string | null;
	/** Set while an administrator has the workspace archived. */
	archived_at: ColumnType<Date | null, string | null, string | null>;
	/** The sizes the worker last applied to the volumes. */
	quota_applied: ColumnType<
		{ homeGiB: number; dockerGiB: number } | null,
		string | null,
		string | null
	>;
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
	/** This terminal's own colour scheme, "dark" or "light" (issue #268). */
	theme: Generated<string>;
	/** "claude" or "codex" when a launcher started it; null for a shell. */
	agent: string | null;
	/** `git stash create` object for this agent session (SPEC.md §10.9). */
	baseline_object_id: string | null;
	/** HEAD at the moment that baseline was taken (SPEC.md §10.9, §12.7). */
	baseline_head: string | null;
	/** Recovery point made before this agent session (SPEC.md §10.9). */
	recovery_point_id: string | null;
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
	/**
	 * The identity of the directory this project lives in, as the agent
	 * reports it (issue #238). Null until a listing fills it in.
	 */
	directory_id: string | null;
	layout: ColumnType<Record<string, unknown> | null, string | null, string | null>;
	created_at: ColumnType<Date, string | undefined, never>;
	archived_at: ColumnType<Date | null, string | null, string | null>;
	/** When the worker last checked this project for a periodic point. */
	recovery_checked_at: ColumnType<Date | null, string | null, string | null>;
}

export interface SettingsTable {
	id: number;
	shutdown_grace_seconds: number;
	/** Runtime log level for every service; null means use each LOG_LEVEL. */
	log_level: string | null;
	updated_at: ColumnType<Date, string | undefined, string>;
	updated_by: string | null;
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

export interface PreviewGrantsTable {
	id: Generated<string>;
	user_id: string;
	/** The main Portikus session the preview session will live with. */
	session_id: string;
	workspace_id: string;
	port: number;
	preview_host: string;
	presentation: string;
	ticket_hash: string;
	expires_at: ColumnType<Date, string, string>;
	consumed_at: ColumnType<Date | null, string | null, string | null>;
	created_at: ColumnType<Date, string | undefined, never>;
}

export interface PreviewSessionsTable {
	id: Generated<string>;
	token_hash: string;
	user_id: string;
	session_id: string;
	workspace_id: string;
	port: number;
	preview_host: string;
	created_at: ColumnType<Date, string | undefined, never>;
	revoked_at: ColumnType<Date | null, string | null, string | null>;
}

export interface RecoveryPointsTable {
	id: string;
	project_id: string;
	workspace_id: string;
	reason: string;
	created_at: ColumnType<Date, string | undefined, never>;
	/** A user id, or "worker". */
	created_by: string;
	/** Postgres returns bigint as a string. */
	size_bytes: ColumnType<string, number | string, number | string>;
	sha256: string;
	fingerprint: string;
	expires_at: ColumnType<Date, string, string>;
}

export interface HealthSamplesTable {
	id: Generated<string>;
	observed_at: ColumnType<Date, string | undefined, never>;
	/** A HealthSample from @portikus/contracts. */
	sample: ColumnType<Record<string, unknown>, string, never>;
}

/** Pending LTI third-party logins; `platform_issuer` is the plain issuer, without `lti:`. */
export interface LtiLoginStatesTable {
	state_hash: string;
	nonce: string;
	platform_issuer: string;
	client_id: string;
	expires_at: ColumnType<Date, string, string>;
}

/** An LMS course (LTI "context"). */
export interface LtiContextsTable {
	id: Generated<string>;
	platform_issuer: string;
	context_id: string;
	title: ColumnType<string, string | undefined, string>;
	platform_name: string;
	created_at: ColumnType<Date, string | undefined, never>;
	updated_at: ColumnType<Date, string | undefined, string>;
}

/** A user's role in one course, refreshed on every launch. */
export interface LtiMembershipsTable {
	context_id: string;
	user_id: string;
	role: string;
	last_launch_at: ColumnType<Date, string, string>;
}

/** A retired course account and the SSO account its launches now sign into. */
export interface AccountLinksTable {
	course_user_id: string;
	user_id: string;
	/** The plain LTI platform issuer, without `lti:`. */
	platform_issuer: string;
	/** True when linking archived the course account's workspace. */
	archived_workspace: boolean;
	created_at: ColumnType<Date, string | undefined, never>;
}

/** A pending link: single use, bound to one course session. */
export interface AccountLinkIntentsTable {
	state_hash: string;
	session_id: string;
	course_user_id: string;
	/** The SSO account, set by the OIDC callback. */
	user_id: string | null;
	expires_at: ColumnType<Date, string, string>;
}
