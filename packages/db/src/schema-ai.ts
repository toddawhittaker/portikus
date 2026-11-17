import type { ColumnType, Generated } from "kysely";

/** The tables for the built-in AI: settings, conversations, usage and prices (SPEC.md section 20.4). */

/** A timestamp column that may be null, set from a Date or an ISO string. */
type NullableTimestamp = ColumnType<
	Date | null,
	Date | string | null | undefined,
	Date | string | null
>;

/** A big count or a price: PostgreSQL returns it as a string, and a number goes in. */
type Count = ColumnType<string, number | string | undefined, number | string>;

/** A price or ratio with no default: PostgreSQL returns a string, and a number goes in. */
type Price = ColumnType<string, number | string, number | string>;

/** The one row of built-in AI settings (SPEC.md section 20.4); the migration inserts it. */
export interface AiSettingsTable {
	id: ColumnType<number, number | undefined, never>;
	enabled: Generated<boolean>;
	provider_kind: ColumnType<
		"openai-compatible" | "anthropic" | null,
		string | null | undefined,
		string | null
	>;
	base_url: ColumnType<string | null, string | null | undefined, string | null>;
	model: ColumnType<string | null, string | null | undefined, string | null>;
	/** The key sealed with `sealSecret`; never sent to a browser. */
	key_sealed: ColumnType<string | null, string | null | undefined, string | null>;
	/** The last four characters of the key, for display. */
	key_hint: ColumnType<string | null, string | null | undefined, string | null>;
	monthly_token_cap: ColumnType<string, number | string | undefined, number | string>;
	conversation_token_budget: Generated<number>;
	/** The privacy notice version an administrator accepted. */
	notice_version: ColumnType<number | null, number | null | undefined, number | null>;
	notice_accepted_by: ColumnType<
		string | null,
		string | null | undefined,
		string | null
	>;
	notice_accepted_at: NullableTimestamp;
	/** Web addresses the weekly price check reads. */
	price_sources: ColumnType<string[], string[] | undefined, string[]>;
	/** Whether new warning and danger administrator alerts get a model's explanation. */
	triage_enabled: Generated<boolean>;
	/** The most explanations written in one UTC day. */
	triage_daily_limit: Generated<number>;
	/** Whether forwarded email and Pushover alerts carry the explanation. */
	triage_forward: Generated<boolean>;
	updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
	updated_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface AssistantConversationsTable {
	id: Generated<string>;
	user_id: string;
	/** The course the conversation was opened from, if any. */
	course_id: ColumnType<string | null, string | null | undefined, string | null>;
	/** What a Diagnose conversation looks at; null for an ordinary one. */
	context: ColumnType<
		Record<string, unknown> | null,
		string | null | undefined,
		string | null
	>;
	read_only: Generated<boolean>;
	title: ColumnType<string | null, string | null | undefined, string | null>;
	tokens_used: Count;
	created_at: Generated<Date>;
	last_active_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** One chat wire event of a conversation, in order by `seq`. */
export interface AssistantEventsTable {
	conversation_id: string;
	seq: number;
	event: ColumnType<unknown, string, string>;
	created_at: Generated<Date>;
}

/** A change or destructive tool call waiting for, or given, a person's answer. */
export interface AssistantApprovalsTable {
	id: Generated<string>;
	conversation_id: string;
	tool_call_id: string;
	operation: string;
	input: ColumnType<unknown, string, string>;
	risk: "change" | "destructive";
	/** The text a person must type for a destructive call. */
	confirm_text: ColumnType<string | null, string | null | undefined, string | null>;
	status: ColumnType<
		"pending" | "approved" | "denied" | "expired",
		string | undefined,
		string
	>;
	created_at: Generated<Date>;
	decided_at: NullableTimestamp;
}

/** Built-in AI tokens per UTC day, person, purpose and model. */
export interface AiUsageDaysTable {
	/** The UTC day, as YYYY-MM-DD on insert. */
	day: ColumnType<Date, string, string>;
	/** Null for a deleted person or a system call. */
	user_id: ColumnType<string | null, string | null | undefined, string | null>;
	purpose: "assistant" | "pricing" | "triage";
	model: string;
	input_tokens: Count;
	output_tokens: Count;
	cache_read_tokens: Count;
	cache_write_tokens: Count;
}

/** The price figures a model row and a proposed row share (migration 0064). */
interface PriceColumns {
	provider: "anthropic" | "openai";
	/** Matched as a substring of the model id. */
	model: string;
	/** Dollars per million input tokens. */
	input_price_per_million: Price;
	/** Dollars per million output tokens; null on rows saved before it was asked for. */
	output_price_per_million: ColumnType<
		string | null,
		number | string | null | undefined,
		number | string | null
	>;
	/** A cache read, as a multiple of the input price; above 0 and at most 1. */
	cache_read_ratio: Price;
	/** A cache write for the default lifetime, as a multiple of the input price. */
	cache_write_ratio: Price;
	/** The one-hour cache write, where the provider sells one. */
	cache_write_one_hour_ratio: ColumnType<
		string | null,
		number | string | null | undefined,
		number | string | null
	>;
	/** The default cache lifetime that `cache_write_ratio` goes with. */
	cache_ttl_seconds: number;
	/** Every price multiplies by `surcharge_factor` past this context size; null for none. */
	surcharge_above_tokens: ColumnType<
		number | null,
		number | null | undefined,
		number | null
	>;
	surcharge_factor: ColumnType<
		string | null,
		number | string | null | undefined,
		number | string | null
	>;
	/** The page the figures were read from, and the sentence or table cell. */
	source_url: string;
	source_quote: string;
}

export interface ModelPricesTable extends PriceColumns {
	id: Generated<string>;
	/** When the figures were last confirmed against their source. */
	checked_at: ColumnType<Date, Date | string | undefined, Date | string>;
	updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
	updated_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface PriceRunsTable {
	id: Generated<string>;
	trigger: "manual" | "weekly";
	started_at: Generated<Date>;
	finished_at: NullableTimestamp;
	status: ColumnType<"running" | "done" | "failed", string | undefined, string>;
	error_code: ColumnType<string | null, string | null | undefined, string | null>;
	/** Null for the weekly timer. */
	started_by: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface PriceProposalsTable extends PriceColumns {
	id: Generated<string>;
	run_id: string;
	status: ColumnType<"pending" | "accepted" | "rejected", string | undefined, string>;
	decided_by: ColumnType<string | null, string | null | undefined, string | null>;
	decided_at: NullableTimestamp;
}
