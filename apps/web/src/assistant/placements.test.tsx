import type { AssistantStatus, SiteJobView } from "@portikus/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { HealthTab } from "../admin/health/HealthTab.js";
import { SiteJobLine } from "../admin/site-job.js";
import { NotificationsDialog } from "../notifications/NotificationsDialog.js";
import { json, renderWithQuery, stubFetch, USER } from "../test-utils.js";
import { AssistantProvider, useAssistant } from "./AssistantContext.js";

/** Where the Diagnose buttons sit: the Health tab, a failed site job line, and warning or danger notifications (SPEC.md section 20.5). */

const ADMIN = { ...USER, role: "administrator" as const };
const ON: AssistantStatus = { enabled: true, reason: null };
const NOTIFICATION = "77777777-7777-4777-8777-777777777777";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function stub(status: AssistantStatus = ON, extra: Record<string, unknown> = {}) {
	return stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/assistant/status") return json(200, status);
		if (url === "/me/notifications" || url.startsWith("/me/notifications?")) {
			return json(200, {
				notifications: [
					note(NOTIFICATION, "danger", "Backup failed"),
					note("88888888-8888-4888-8888-888888888888", "warning", "Disk is filling"),
					note("99999999-9999-4999-8999-999999999999", "success", "Link copied"),
					note("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "neutral", "FYI"),
				],
				unreadCount: 4,
			});
		}
		return extra[url]
			? json(200, extra[url])
			: json(500, { code: "INTERNAL", message: "x" });
	});
}

function note(id: string, tone: string, title: string) {
	return {
		id,
		tone,
		title,
		body: "",
		createdAt: "2026-11-15T10:00:00.000Z",
		readAt: null,
	};
}

function job(overrides: Partial<SiteJobView>): SiteJobView {
	return {
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		kind: "proxy-hosts",
		state: "failed",
		code: "proxy_config_rejected",
		requestedAt: null,
		startedAt: null,
		finishedAt: null,
		trialEndsAt: null,
		...overrides,
	};
}

/** Shows what the Diagnose button asked the assistant to open. */
function Opened() {
	const { pending } = useAssistant();
	return <p data-testid="opened">{JSON.stringify(pending?.context ?? null)}</p>;
}

function inProvider(ui: ReactElement) {
	return (
		<AssistantProvider>
			{ui}
			<Opened />
		</AssistantProvider>
	);
}

test("a failed site job offers Diagnose with the job's kind, and a finished or unnamed one does not", async () => {
	stub();
	renderWithQuery(inProvider(<SiteJobLine job={job({})} />));
	fireEvent.click(await screen.findByTestId("diagnose-job"));
	expect(screen.getByTestId("opened").textContent).toBe(
		JSON.stringify({ kind: "job", id: "site:proxy-hosts" }),
	);
	cleanup();

	renderWithQuery(inProvider(<SiteJobLine job={job({ kind: null })} />));
	await screen.findByText(/did not accept|was not applied|refused/);
	expect(screen.queryByTestId("diagnose-job")).toBeNull();
	cleanup();

	renderWithQuery(inProvider(<SiteJobLine job={job({ state: "done", code: null })} />));
	await screen.findByText(/Saved/);
	expect(screen.queryByTestId("diagnose-job")).toBeNull();
});

test("a failed job line shows no Diagnose button while the assistant is off", async () => {
	stub({ enabled: false, reason: "off" });
	renderWithQuery(inProvider(<SiteJobLine job={job({})} />));
	await screen.findByText(/proxy refused/);
	await waitFor(() => expect(screen.queryByTestId("diagnose-job")).toBeNull());
});

test("warning and danger notifications offer Diagnose, and it closes the list as it opens the assistant", async () => {
	stub();
	const onClose = vi.fn();
	renderWithQuery(inProvider(<NotificationsDialog onClose={onClose} />));
	const buttons = await screen.findAllByTestId("diagnose-alert");
	expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
		'Diagnose: "Backup failed"',
		'Diagnose: "Disk is filling"',
	]);
	fireEvent.click(buttons[0] as HTMLElement);
	expect(screen.getByTestId("opened").textContent).toBe(
		JSON.stringify({ kind: "alert", id: NOTIFICATION }),
	);
	expect(onClose).toHaveBeenCalledTimes(1);
});

test("the notifications list on a page with no assistant shows no Diagnose buttons", async () => {
	stub();
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);
	await screen.findByText("Backup failed");
	expect(screen.queryByTestId("diagnose-alert")).toBeNull();
});

test("the Health tab offers Diagnose, even when the report itself cannot be loaded", async () => {
	stub();
	const rootRoute = createRootRoute({
		component: () => inProvider(<HealthTab />),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/admin/health"] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one
	renderWithQuery(<RouterProvider router={router as any} />);
	fireEvent.click(await screen.findByRole("button", { name: "Diagnose site health" }));
	expect(screen.getByTestId("opened").textContent).toBe(
		JSON.stringify({ kind: "health" }),
	);
});
