import { expect, test } from "vitest";
import {
	filtersFromSearch,
	fromLocalInput,
	logQueryString,
	sanitizeLogSearch,
	searchFromFilters,
	sinceTime,
	toLocalInput,
} from "./filters.js";

const USER = "11111111-2222-4333-8444-555555555555";
const WS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("an empty URL means Error and Warn, every service, the last day", () => {
	expect(filtersFromSearch({})).toEqual({
		levels: ["error", "warn"],
		services: [],
		since: "1d",
		until: "",
		q: "",
		user: "",
		workspace: "",
	});
});

test("filters survive a trip to the URL and back", () => {
	const filters = {
		levels: ["info" as const, "debug" as const],
		services: ["worker" as const],
		since: "2026-09-26T09:00:00.000Z",
		until: "2026-09-26T10:00:00.000Z",
		q: "boom",
		user: USER,
		workspace: WS,
	};
	const search = searchFromFilters(filters);
	expect(search).toEqual({
		tab: "logs",
		level: "info,debug",
		service: "worker",
		since: "2026-09-26T09:00:00.000Z",
		until: "2026-09-26T10:00:00.000Z",
		q: "boom",
		user: USER,
		workspace: WS,
	});
	expect(filtersFromSearch(search)).toEqual(filters);
});

test("defaults are left out of the URL, and every service is the same as none", () => {
	expect(
		searchFromFilters({
			levels: ["warn", "error"],
			services: ["api", "worker", "controller"],
			since: "1d",
			until: "",
			q: "",
			user: "",
			workspace: "",
		}),
	).toEqual({
		tab: "logs",
		level: undefined,
		service: undefined,
		since: undefined,
		until: undefined,
		q: undefined,
		user: undefined,
		workspace: undefined,
	});
});

test("unknown levels, services, times and over-long text are dropped", () => {
	expect(
		sanitizeLogSearch({
			level: "fatal,warn,<script>",
			service: "dex",
			since: "yesterday",
			until: "2026-13-45T99:00",
			q: "x".repeat(201),
		}),
	).toEqual({
		level: "warn",
		service: undefined,
		since: undefined,
		until: undefined,
		q: undefined,
	});
	expect(sanitizeLogSearch({ since: "7d" }).since).toBe("7d");
	expect(filtersFromSearch({ user: "not-an-id", workspace: 42 })).toMatchObject({
		user: "",
		workspace: "",
	});
});

test("a preset window is resolved to an exact time when the page is fetched", () => {
	const now = Date.parse("2026-09-26T12:00:00.000Z");
	expect(sinceTime("1h", now)).toBe("2026-09-26T11:00:00.000Z");
	expect(sinceTime("7d", now)).toBe("2026-09-19T12:00:00.000Z");
	expect(sinceTime("2026-09-01T00:00:00.000Z", now)).toBe("2026-09-01T00:00:00.000Z");
	const query = new URLSearchParams(
		logQueryString(
			{ ...filtersFromSearch({}), levels: ["debug", "error"], user: USER },
			now,
			"s=1",
		).slice(1),
	);
	expect(Object.fromEntries(query)).toEqual({
		level: "error,debug",
		since: "2026-09-25T12:00:00.000Z",
		user: USER,
		cursor: "s=1",
	});
});

test("custom times convert between the browser's zone and ISO", () => {
	const iso = fromLocalInput("2026-09-26T09:30");
	expect(toLocalInput(iso)).toBe("2026-09-26T09:30");
	expect(fromLocalInput("")).toBe("");
	expect(toLocalInput("nope")).toBe("");
});
