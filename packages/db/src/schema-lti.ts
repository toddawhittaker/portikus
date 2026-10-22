import type { ColumnType, Generated } from "kysely";

/** The tables for LTI course launches and the account links they make (SPEC.md section 8, ADR 0058). */

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
	/** A `CourseProfile` from @portikus/contracts (ADR 0066). */
	profile: Generated<string>;
	/** The tool's client id at this platform, from the latest launch (ADR 0058). */
	platform_client_id: ColumnType<
		string | null,
		string | null | undefined,
		string | null
	>;
	/** The NRPS memberships URL from the latest launch's claim. */
	nrps_url: ColumnType<string | null, string | null | undefined, string | null>;
	roster_synced_at: ColumnType<Date | null, string | null | undefined, string | null>;
	/** A `RosterSyncResult` from @portikus/contracts; null before the first sync. */
	roster_sync_result: ColumnType<
		string | null,
		string | null | undefined,
		string | null
	>;
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

/** One person on a course's NRPS roster, replaced on each sync; never an email (ADR 0058). */
export interface LtiRosterMembersTable {
	context_id: string;
	/** The LTI subject at that course's platform. */
	subject: string;
	display_name: string;
	role: string;
}

/** A pending Deep Linking picker: ten minutes, single use (ADR 0058). */
export interface LtiDeepLinkRequestsTable {
	/** SHA-256 of the handle the picker page carries. */
	state_hash: string;
	/** The plain platform issuer, without `lti:`. */
	platform_issuer: string;
	/** The instructor's LTI subject, for the audit actor (SPEC.md §24.11). */
	subject: string | null;
	client_id: string;
	deployment_id: string;
	return_url: string;
	/** The request's opaque `data`, echoed back in the response. */
	data: string | null;
	expires_at: ColumnType<Date, string, string>;
}

/** A student's launch of a picked link, consumed when the project opens (ADR 0058). */
export interface LtiStarterLaunchesTable {
	id: Generated<string>;
	user_id: string;
	project_name: string;
	/** Exactly one of template and repository_url is set. */
	template: string | null;
	repository_url: string | null;
	created_at: ColumnType<Date, string | undefined, never>;
	expires_at: ColumnType<Date, string, string>;
}

/** A retired course account and the SSO account its launches now sign into. */
export interface AccountLinksTable {
	course_user_id: string;
	user_id: string;
	/** The plain LTI platform issuer, without `lti:`. */
	platform_issuer: string;
	/** The `archived_at` this link wrote on the course workspace, or null when it archived nothing. */
	archived_at: ColumnType<Date | null, string | null, string | null>;
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
