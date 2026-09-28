import type { AdminUser } from "@portikus/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { shortTime } from "../shortTime.js";
import {
	AuditTab,
	filtersFromSearch,
	resolvePerson,
	resultTagClass,
	shortId,
	suggestionValue,
	targetLabel,
} from "./AuditTab.js";
import { auditQueryString } from "./queries.js";

afterEach(() => vi.unstubAllGlobals());

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ALICE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ALICE_ID = "44444444-4444-4444-8444-444444444444";

function person(id: string, displayName: string, email: string | null) {
	return {
		id,
		displayName,
		email,
		role: "student" as const,
		providerRole: "student" as const,
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		dexLocal: false,
		preferredUsername: null,
		issuer: null,
		lastLoginAt: null,
		markers: {
			disabled: false,
			archived: false,
			duplicateEmail: false,
			stale: false,
			linked: false,
		},
		workspace: null,
	};
}

const PEOPLE = [
	person(USER_ID, "Carol Admin", "carol@example.edu"),
	person(ALICE_ID, "Alice Student", "alice@example.edu"),
];

/** Answers the people list, and every other request with `audit`. */
function stubAudit(audit: (url: string) => Response) {
	return stubFetch((url) => {
		if (url === "/admin/users") return json(200, { users: PEOPLE, dexUsers: false });
		return audit(url);
	});
}

/** The audit requests made so far, leaving out the people list. */
function auditCalls(fetch: ReturnType<typeof stubFetch>): string[] {
	return fetch.mock.calls
		.map((call) => String(call[0]))
		.filter((url) => url.startsWith("/admin/audit"));
}

function event(id: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		at: "2026-09-22T10:00:00.000Z",
		actor: `user:${USER_ID}`,
		actorName: "Carol Admin",
		action: "workspace.stop_requested",
		target: `workspace:${WORKSPACE_ID}`,
		result: "success",
		metadata: null,
		...overrides,
	};
}

/** Renders the tab under a router at `path`, as the admin page does. */
function renderTab(path: string) {
	const rootRoute = createRootRoute({ component: AuditTab });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one
	renderWithQuery(<RouterProvider router={router as any} />);
}

test("filters come from the search parameters", () => {
	expect(
		filtersFromSearch({ tab: "audit", workspace: WORKSPACE_ID, action: "user." }),
	).toEqual({ workspace: WORKSPACE_ID, user: "", action: "user." });
	expect(filtersFromSearch({ workspace: 5 })).toEqual({
		workspace: "",
		user: "",
		action: "",
	});
});

test("the query string leaves out empty filters", () => {
	expect(auditQueryString({ workspace: "", user: "", action: "" }, null)).toBe("");
	expect(
		auditQueryString({ workspace: WORKSPACE_ID, user: "", action: "a." }, 40),
	).toBe(`?workspace=${WORKSPACE_ID}&action=a.&before=40`);
});

test("a target link asks the API for that target and names it above the table", async () => {
	const fetch = stubAudit(() =>
		json(200, {
			events: [event(7, { metadata: { from: 10, to: 20, reason: "grow" } })],
			nextBefore: null,
		}),
	);

	renderTab(`/admin?tab=audit&workspace=${ALICE_ID}`);

	const row = within(await screen.findByTestId("audit-row-7"));
	expect(row.getByText("Carol Admin")).toBeDefined();
	expect(row.getByText("workspace.stop_requested")).toBeDefined();
	expect(row.getByText("reason:")).toBeDefined();
	expect(row.getByText("grow")).toBeDefined();
	expect(row.getByText("20")).toBeDefined();
	expect(auditCalls(fetch)).toEqual([`/admin/audit?workspace=${ALICE_ID}`]);
	await waitFor(() =>
		expect(screen.getByTestId("audit-filter-target").textContent).toContain(
			"Only events about Alice Student",
		),
	);
	// The target is not a person filter, so the Person field stays empty.
	expect((screen.getByTestId("audit-filter-person") as HTMLInputElement).value).toBe(
		"",
	);
	// Named for accessibility; the table has a caption.
	expect(
		screen.getByRole("table", { name: /Audit events, newest first/ }),
	).toBeDefined();
});

test("Older and Newer page by id", async () => {
	const fetch = stubAudit((url) => {
		if (url === "/admin/audit") {
			return json(200, { events: [event(60), event(59)], nextBefore: 59 });
		}
		if (url === "/admin/audit?before=59") {
			return json(200, { events: [event(3)], nextBefore: null });
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderTab("/admin?tab=audit");

	await screen.findByTestId("audit-row-60");
	const newer = screen.getByRole("button", { name: "Newer audit events" });
	const older = screen.getByRole("button", { name: "Older audit events" });
	expect(newer.getAttribute("aria-disabled")).toBe("true");

	await waitFor(() =>
		expect(screen.getByTestId("audit-page").textContent).toBe("Page 1, 2 events"),
	);
	expect(screen.getByTestId("audit-page").getAttribute("role")).toBe("status");

	// A paging button that becomes unavailable keeps focus (Gate E).
	older.focus();
	fireEvent.click(older);
	await screen.findByTestId("audit-row-3");
	expect(screen.queryByTestId("audit-row-60")).toBeNull();
	await waitFor(() => expect(older.getAttribute("aria-disabled")).toBe("true"));
	expect(newer.getAttribute("aria-disabled")).toBe(null);
	expect(document.activeElement).toBe(older);
	expect(older.hasAttribute("disabled")).toBe(false);
	expect(screen.getByTestId("audit-page").textContent).toBe("Page 2, 1 event");

	// Clicking the unavailable button does nothing.
	fireEvent.click(older);

	newer.focus();
	fireEvent.click(newer);
	await screen.findByTestId("audit-row-60");
	expect(document.activeElement).toBe(newer);
	expect(newer.hasAttribute("disabled")).toBe(false);
	expect(auditCalls(fetch)).toEqual(["/admin/audit", "/admin/audit?before=59"]);
});

test("applying filters starts again from the newest page", async () => {
	const fetch = stubAudit((url) => {
		if (url === "/admin/audit") {
			return json(200, { events: [event(60)], nextBefore: 60 });
		}
		if (url === "/admin/audit?before=60") {
			return json(200, { events: [event(2)], nextBefore: null });
		}
		if (url === `/admin/audit?user=${USER_ID}&action=user.`) {
			return json(200, {
				events: [event(9, { action: "user.disabled" })],
				nextBefore: null,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});

	renderTab("/admin?tab=audit");
	await screen.findByTestId("audit-row-60");
	fireEvent.click(screen.getByRole("button", { name: "Older audit events" }));
	await screen.findByTestId("audit-row-2");

	// A name in any case finds the person; the request carries their ID.
	await waitFor(() =>
		expect(document.querySelectorAll("#audit-people option")).toHaveLength(2),
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Person" }), {
		target: { value: " carol admin " },
	});
	fireEvent.change(screen.getByTestId("audit-filter-action"), {
		target: { value: "user." },
	});
	const apply = screen.getByRole("button", { name: "Apply filters" });
	apply.focus();
	fireEvent.click(apply);

	await screen.findByText("user.disabled");
	// Only the results re-key, so the focused Apply button is the same node.
	expect(document.activeElement).toBe(apply);
	expect(fetch).toHaveBeenLastCalledWith(
		`/admin/audit?user=${USER_ID}&action=user.`,
		expect.anything(),
	);
	expect(
		screen
			.getByRole("button", { name: "Newer audit events" })
			.getAttribute("aria-disabled"),
	).toBe("true");
});

test("a name that matches nobody is refused at the field, before any request", async () => {
	const fetch = stubAudit(() => json(200, { events: [], nextBefore: null }));

	renderTab("/admin?tab=audit");
	await screen.findByText("No audit events match.");
	await waitFor(() =>
		expect(document.querySelectorAll("#audit-people option")).toHaveLength(2),
	);
	const field = screen.getByRole("combobox", { name: "Person" });
	fireEvent.change(field, { target: { value: "Bob" } });
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	// The error is tied to the field.
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
	const described = document.getElementById(
		field.getAttribute("aria-describedby") ?? "",
	);
	expect(described?.textContent).toContain('No one matches "Bob"');
	expect(auditCalls(fetch)).toEqual(["/admin/audit"]);

	// A name from the list clears the error on the next Apply.
	fireEvent.change(field, { target: { value: "Alice Student" } });
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe(null));
	await waitFor(() =>
		expect(auditCalls(fetch)).toContain(`/admin/audit?user=${ALICE_ID}`),
	);
	// Once applied, the field shows the person's name from the address.
	expect((field as HTMLInputElement).value).toBe("Alice Student");
});

test("a person is found by name, email or username in any case, or by a pasted ID", () => {
	const people = [
		{ ...PEOPLE[0], preferredUsername: "carol" },
		PEOPLE[1],
	] as AdminUser[];
	expect(resolvePerson("", people)).toEqual({ id: "" });
	expect(resolvePerson("  ALICE student ", people)).toEqual({ id: ALICE_ID });
	expect(resolvePerson("carol@example.edu", people)).toEqual({ id: USER_ID });
	expect(resolvePerson("Carol", people)).toEqual({ id: USER_ID });
	expect(resolvePerson(WORKSPACE_ID.toUpperCase(), people)).toEqual({
		id: WORKSPACE_ID,
	});
	expect(resolvePerson("Bob", people)).toEqual({
		error: 'No one matches "Bob". Choose a name from the list.',
	});
	expect(resolvePerson("Alice", undefined)).toEqual({
		error: "The list of people is still loading. Try again in a moment.",
	});
	const twins = [
		...people,
		person(OTHER_ALICE_ID, "Alice Student", "alice2@example.edu"),
	] as AdminUser[];
	expect(resolvePerson("Alice Student", twins)).toEqual({
		error: 'More than one person matches "Alice Student". Type their email instead.',
	});
	expect(resolvePerson("alice2@example.edu", twins)).toEqual({ id: OTHER_ALICE_ID });
});

test("a shared name is suggested as the email, so each suggestion names one person", () => {
	const twins = [
		...PEOPLE,
		person(OTHER_ALICE_ID, "Alice Student", null),
	] as AdminUser[];
	expect(suggestionValue(twins[0] as AdminUser, twins)).toBe("Carol Admin");
	expect(suggestionValue(twins[1] as AdminUser, twins)).toBe("alice@example.edu");
	expect(suggestionValue(twins[2] as AdminUser, twins)).toBe(OTHER_ALICE_ID);
});

test("a target is named as a person or as their workspace", () => {
	const users = [
		PEOPLE[0],
		{ ...PEOPLE[1], workspace: { id: WORKSPACE_ID } },
	] as AdminUser[];
	expect(targetLabel(USER_ID, users)).toBe("Carol Admin");
	expect(targetLabel(WORKSPACE_ID, users)).toBe("Alice Student's workspace");
	expect(targetLabel(OTHER_ALICE_ID, users)).toBeNull();
	expect(targetLabel(USER_ID, undefined)).toBeNull();
});

test("an API error is announced", async () => {
	stubAudit(() =>
		json(400, {
			code: "VALIDATION_FAILED",
			message: "The workspace filter is not valid.",
		}),
	);

	renderTab("/admin?tab=audit&workspace=nope");

	expect((await screen.findByRole("alert")).textContent).toBe(
		"The workspace filter is not valid.",
	);
});

test("IDs shorten to their first 8 characters, keeping a prefix", () => {
	expect(shortId(WORKSPACE_ID)).toBe("22222222");
	expect(shortId(`user:${USER_ID}`)).toBe("user:11111111");
	expect(shortId("worker")).toBe("worker");
	expect(shortId("subject:not-a-uuid")).toBe("subject:not-a-uuid");
});

test("the short time names month, day, hour and minute but not the year", () => {
	const text = shortTime("2026-09-22T10:00:00.000Z");
	expect(text).toMatch(/Sep/);
	expect(text).not.toMatch(/2026/);
});

test("ok and success are neutral tags; anything else is an error tag", () => {
	expect(resultTagClass("ok")).toBe("pk-tag");
	expect(resultTagClass("success")).toBe("pk-tag");
	expect(resultTagClass("denied")).toBe("pk-tag pk-tag--error");
	expect(resultTagClass("failure")).toBe("pk-tag pk-tag--error");
	expect(resultTagClass("failed")).toBe("pk-tag pk-tag--error");
});

test("a row shows short IDs with the full ID kept for titles and screen readers", async () => {
	stubAudit(() =>
		json(200, {
			events: [
				event(8, {
					actorName: null,
					target: WORKSPACE_ID,
					result: "denied",
					metadata: { note: "x".repeat(200) },
				}),
			],
			nextBefore: null,
		}),
	);

	renderTab("/admin?tab=audit");

	const row = within(await screen.findByTestId("audit-row-8"));
	const link = row.getByRole("link", { name: new RegExp(WORKSPACE_ID) });
	expect(link.textContent).toBe("22222222");
	expect(link.getAttribute("title")).toBe(WORKSPACE_ID);
	expect(link.getAttribute("href")).toContain(`workspace=${WORKSPACE_ID}`);
	expect(row.getByText(`user:${USER_ID}`).className).toBe("sr-only");
	expect(row.getByText("denied").className).toBe("pk-tag pk-tag--error");
	const short = row.getByText(shortTime("2026-09-22T10:00:00.000Z"));
	expect(short.getAttribute("aria-hidden")).toBe("true");
	const time = short.closest("time");
	expect(time?.getAttribute("dateTime")).toBe("2026-09-22T10:00:00.000Z");
	// Screen readers hear the full date and time, not the short form.
	const full = new Date("2026-09-22T10:00:00.000Z").toLocaleString();
	expect(row.getByText(full).className).toBe("sr-only");
	// The whole detail value stays in the page even though it is clipped.
	expect(row.getAllByText("x".repeat(200)).length).toBeGreaterThan(0);
	// A clipped value can be read in full by opening a native disclosure.
	const details = row.getByTestId("audit-details-full");
	expect(details.tagName).toBe("DETAILS");
	expect(within(details).getByText("Show full details").tagName).toBe("SUMMARY");
	expect(within(details).getByText("x".repeat(200))).toBeDefined();
});

test("a row with only short details has no disclosure", async () => {
	stubAudit(() =>
		json(200, {
			events: [event(9, { metadata: { note: "short" } })],
			nextBefore: null,
		}),
	);

	renderTab("/admin?tab=audit");

	const row = within(await screen.findByTestId("audit-row-9"));
	expect(row.getByText("short")).toBeDefined();
	expect(row.queryByTestId("audit-details-full")).toBeNull();
});

test("every column header is scoped to its column", async () => {
	stubAudit(() => json(200, { events: [event(1)], nextBefore: null }));

	renderTab("/admin?tab=audit");

	const table = await screen.findByTestId("audit-table");
	const headers = within(table).getAllByRole("columnheader");
	expect(headers).toHaveLength(6);
	for (const header of headers) expect(header.getAttribute("scope")).toBe("col");
});

test("a target with a known owner shows their name, with the short ID under it", async () => {
	stubAudit(() =>
		json(200, {
			events: [event(10, { target: WORKSPACE_ID, targetName: "Alice Student" })],
			nextBefore: null,
		}),
	);

	renderTab("/admin?tab=audit");

	const row = within(await screen.findByTestId("audit-row-10"));
	const link = row.getByRole("link", {
		name: `Show events for target Alice Student, ${WORKSPACE_ID}`,
	});
	expect(link.textContent).toBe("Alice Student");
	// A long name is clipped to one line, so the title carries it in full.
	expect(link.getAttribute("title")).toBe(`Alice Student, ${WORKSPACE_ID}`);
	const short = row.getByText("22222222");
	expect(short.getAttribute("aria-hidden")).toBe("true");
});
