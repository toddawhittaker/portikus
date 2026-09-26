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
import { AuditTab, filtersFromSearch, resultTagClass, shortId } from "./AuditTab.js";
import { auditQueryString } from "./queries.js";

afterEach(() => vi.unstubAllGlobals());

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

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

test("a workspace link asks the API for that workspace and shows the rows", async () => {
	const fetch = stubFetch(() =>
		json(200, {
			events: [event(7, { metadata: { from: 10, to: 20, reason: "grow" } })],
			nextBefore: null,
		}),
	);

	renderTab(`/admin?tab=audit&workspace=${WORKSPACE_ID}`);

	const row = within(await screen.findByTestId("audit-row-7"));
	expect(row.getByText("Carol Admin")).toBeDefined();
	expect(row.getByText("workspace.stop_requested")).toBeDefined();
	expect(row.getByText("reason:")).toBeDefined();
	expect(row.getByText("grow")).toBeDefined();
	expect(row.getByText("20")).toBeDefined();
	expect(String(fetch.mock.calls[0]?.[0])).toBe(
		`/admin/audit?workspace=${WORKSPACE_ID}`,
	);
	expect((screen.getByTestId("audit-filter-workspace") as HTMLInputElement).value).toBe(
		WORKSPACE_ID,
	);
	// Named for accessibility; the table has a caption.
	expect(
		screen.getByRole("table", { name: /Audit events, newest first/ }),
	).toBeDefined();
});

test("Older and Newer page by id", async () => {
	const fetch = stubFetch((url) => {
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
	expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
		"/admin/audit",
		"/admin/audit?before=59",
	]);
});

test("applying filters starts again from the newest page", async () => {
	const fetch = stubFetch((url) => {
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

	fireEvent.change(screen.getByTestId("audit-filter-user"), {
		target: { value: ` ${USER_ID} ` },
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

test("an ID that is not a full ID is refused before any request", async () => {
	const fetch = stubFetch(() => json(200, { events: [], nextBefore: null }));

	renderTab("/admin?tab=audit");
	await screen.findByText("No audit events match.");
	fireEvent.change(screen.getByTestId("audit-filter-workspace"), {
		target: { value: "ws-alice" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	// The error is tied to the field at fault.
	const field = screen.getByRole("textbox", { name: "Target ID" });
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
	const described = document.getElementById(
		field.getAttribute("aria-describedby") ?? "",
	);
	expect(described?.textContent).toContain("Enter a full ID");
	expect(
		screen.getByRole("textbox", { name: "User ID" }).getAttribute("aria-invalid"),
	).toBe(null);
	expect(fetch).toHaveBeenCalledTimes(1);

	// A fixed value clears the error at the start of the next Apply.
	fireEvent.change(field, { target: { value: "" } });
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe(null));
});

test("an API error is announced", async () => {
	stubFetch(() =>
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
	stubFetch(() =>
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
	stubFetch(() =>
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
	stubFetch(() => json(200, { events: [event(1)], nextBefore: null }));

	renderTab("/admin?tab=audit");

	const table = await screen.findByTestId("audit-table");
	const headers = within(table).getAllByRole("columnheader");
	expect(headers).toHaveLength(6);
	for (const header of headers) expect(header.getAttribute("scope")).toBe("col");
});
