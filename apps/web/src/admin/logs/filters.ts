import {
	LOG_LEVELS,
	LOG_SERVICES,
	LOG_TEXT_MAX,
	type LogLevel,
	type LogService,
} from "@portikus/contracts";
import { UUID } from "../../links.js";

/** The preset time windows; anything else in `since` is an exact time. */
export const LOG_WINDOWS = ["1h", "1d", "7d"] as const;
export type LogWindow = (typeof LOG_WINDOWS)[number];

const WINDOW_MS: Record<LogWindow, number> = {
	"1h": 60 * 60_000,
	"1d": 24 * 60 * 60_000,
	"7d": 7 * 24 * 60 * 60_000,
};

export const WINDOW_LABELS: Record<LogWindow, string> = {
	"1h": "Last hour",
	"1d": "Last day",
	"7d": "Last 7 days",
};

export const DEFAULT_LEVELS: readonly LogLevel[] = ["error", "warn"];
export const DEFAULT_WINDOW: LogWindow = "1d";

/**
 * The Logs tab's filters (docs/EPIC-19.md ruling 32). `since` is a preset
 * window or an ISO time; `until` is an ISO time or empty for "now". Empty
 * `services` means every service; empty strings mean "any".
 */
export interface LogFilters {
	levels: LogLevel[];
	services: LogService[];
	since: string;
	until: string;
	q: string;
	user: string;
	workspace: string;
}

/** The URL's search keys for the Logs tab; undefined leaves a key out. */
export type LogSearch = {
	level?: string;
	service?: string;
	since?: string;
	until?: string;
	q?: string;
	user?: string;
	workspace?: string;
};

function isIsoTime(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Known items of a comma list, in the list's own order; undefined when none. */
function knownList<T extends string>(value: unknown, known: readonly T[]): T[] {
	if (typeof value !== "string") return [];
	const parts = value.split(",");
	return known.filter((item) => parts.includes(item));
}

/** Clean the Logs keys of a URL; the router calls this, so bad values vanish. */
export function sanitizeLogSearch(search: Record<string, unknown>): LogSearch {
	const levels = knownList(search.level, LOG_LEVELS);
	const services = knownList(search.service, LOG_SERVICES);
	const since = typeof search.since === "string" ? search.since : "";
	const until = typeof search.until === "string" ? search.until : "";
	const q = typeof search.q === "string" ? search.q : "";
	return {
		level: levels.length > 0 ? levels.join(",") : undefined,
		service: services.length > 0 ? services.join(",") : undefined,
		since:
			LOG_WINDOWS.includes(since as LogWindow) || isIsoTime(since) ? since : undefined,
		until: isIsoTime(until) ? until : undefined,
		q: q.length > 0 && q.length <= LOG_TEXT_MAX ? q : undefined,
	};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The filters a link such as `/admin?tab=logs&level=error&user=<id>` asks for. */
export function filtersFromSearch(search: Record<string, unknown>): LogFilters {
	const clean = sanitizeLogSearch(search);
	const user = text(search.user);
	const workspace = text(search.workspace);
	return {
		levels: clean.level ? knownList(clean.level, LOG_LEVELS) : [...DEFAULT_LEVELS],
		services: knownList(clean.service, LOG_SERVICES),
		since: clean.since ?? DEFAULT_WINDOW,
		until: clean.until ?? "",
		q: clean.q ?? "",
		user: UUID.test(user) ? user : "",
		workspace: UUID.test(workspace) ? workspace : "",
	};
}

/** The URL keys for these filters, leaving out the defaults. */
export function searchFromFilters(filters: LogFilters): LogSearch & { tab: "logs" } {
	const levels = LOG_LEVELS.filter((level) => filters.levels.includes(level));
	const isDefault =
		levels.length === DEFAULT_LEVELS.length &&
		DEFAULT_LEVELS.every((level) => levels.includes(level));
	const services = LOG_SERVICES.filter((service) => filters.services.includes(service));
	return {
		tab: "logs",
		level: isDefault ? undefined : levels.join(",") || undefined,
		// Every service ticked is the same as none: all of them.
		service:
			services.length === 0 || services.length === LOG_SERVICES.length
				? undefined
				: services.join(","),
		since: filters.since === DEFAULT_WINDOW ? undefined : filters.since || undefined,
		until: filters.until || undefined,
		q: filters.q || undefined,
		user: filters.user || undefined,
		workspace: filters.workspace || undefined,
	};
}

/** The exact start time a filter means at `now`. */
export function sinceTime(since: string, now: number): string {
	const window = LOG_WINDOWS.find((item) => item === since);
	return window ? new Date(now - WINDOW_MS[window]).toISOString() : since;
}

/** The query string for `GET /admin/logs`; a preset window is resolved at `now`. */
export function logQueryString(
	filters: LogFilters,
	now: number,
	cursor: string | null,
): string {
	const params = new URLSearchParams();
	params.set("level", LOG_LEVELS.filter((l) => filters.levels.includes(l)).join(","));
	if (filters.services.length > 0) params.set("service", filters.services.join(","));
	params.set("since", sinceTime(filters.since, now));
	if (filters.until) params.set("until", filters.until);
	if (filters.q) params.set("q", filters.q);
	if (filters.user) params.set("user", filters.user);
	if (filters.workspace) params.set("workspace", filters.workspace);
	if (cursor) params.set("cursor", cursor);
	return `?${params.toString()}`;
}

/** An ISO time as a `datetime-local` value in the browser's zone. */
export function toLocalInput(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as an ISO time; empty for an empty or bad value. */
export function fromLocalInput(value: string): string {
	if (value === "") return "";
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? "" : new Date(time).toISOString();
}
