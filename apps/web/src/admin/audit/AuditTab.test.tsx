import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { AuditTab, filtersFromSearch } from "./AuditTab.js";
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
	expect((newer as HTMLButtonElement).disabled).toBe(true);

	fireEvent.click(older);
	await screen.findByTestId("audit-row-3");
	expect(screen.queryByTestId("audit-row-60")).toBeNull();
	await waitFor(() => expect((older as HTMLButtonElement).disabled).toBe(true));
	expect((newer as HTMLButtonElement).disabled).toBe(false);

	fireEvent.click(newer);
	await screen.findByTestId("audit-row-60");
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
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	await screen.findByText("user.disabled");
	expect(fetch).toHaveBeenLastCalledWith(
		`/admin/audit?user=${USER_ID}&action=user.`,
		expect.anything(),
	);
	expect(
		(screen.getByRole("button", { name: "Newer audit events" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
});

test("an ID that is not a full ID is refused before any request", async () => {
	const fetch = stubFetch(() => json(200, { events: [], nextBefore: null }));

	renderTab("/admin?tab=audit");
	await screen.findByText("No audit events match.");
	fireEvent.change(screen.getByTestId("audit-filter-workspace"), {
		target: { value: "ws-alice" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

	expect((await screen.findByRole("alert")).textContent).toContain("must be a full ID");
	expect(fetch).toHaveBeenCalledTimes(1);
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
