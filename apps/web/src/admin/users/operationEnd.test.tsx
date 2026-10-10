import type { AdminUser, AuditEvent, PendingOperation } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../../api/queryClient.js";
import { json, renderApp, stubFetch } from "../../test-utils.js";
import {
	endToasts,
	OperationEndToasts,
	OUTCOME_RETRY_MS,
	operationOutcome,
	outcomeToast,
	readOutcomes,
	useOperationEndToasts,
} from "./operationEnd.js";
import { ADMIN_ME, isUsersList, listed, summary, usersBody, uuid } from "./testRows.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const WORKSPACE_ID = uuid(5);

function auditEvent(
	id: number,
	action: string,
	metadata: Record<string, unknown> | null = null,
	target = WORKSPACE_ID,
): AuditEvent {
	return {
		id,
		at: "2026-09-22T10:00:00.000Z",
		actor: "worker",
		actorName: null,
		action,
		target,
		result: action.endsWith("_failed") ? "failed" : "ok",
		metadata,
	};
}

test("operationOutcome reads a result only when it is newer than the last request", () => {
	const requested = auditEvent(8, "workspace.rebuild_requested");
	const failed = auditEvent(9, "workspace.rebuild_failed", {
		errorCode: "CONTROLLER_TIMEOUT",
	});
	expect(operationOutcome([failed, requested])).toEqual({
		operation: "rebuild",
		ok: false,
		detail: "CONTROLLER_TIMEOUT",
	});
	// The worker has not audited yet: the result is a poll away.
	expect(operationOutcome([requested])).toBeNull();
	// An older result belongs to an earlier operation.
	expect(
		operationOutcome([
			auditEvent(10, "workspace.docker_reset_requested"),
			auditEvent(6, "workspace.docker_reset"),
		]),
	).toBeNull();
	// Other rows in between do not hide the result.
	expect(
		operationOutcome([
			auditEvent(12, "workspace.started"),
			auditEvent(11, "workspace.docker_reset"),
			auditEvent(10, "workspace.docker_reset_requested"),
		]),
	).toEqual({ operation: "reset-docker", ok: true, detail: null });
	// The request has scrolled out of the panel's rows; the result is still read.
	expect(operationOutcome([auditEvent(20, "workspace.home_replaced")])).toEqual({
		operation: "replace-home",
		ok: true,
		detail: null,
	});
	expect(
		operationOutcome([
			auditEvent(21, "workspace.home_replace_failed", {
				error: "the host could not import the home: no space",
			}),
			auditEvent(20, "workspace.home_replace_requested"),
		]),
	).toEqual({
		operation: "replace-home",
		ok: false,
		detail: "the host could not import the home: no space",
	});
});

test("outcomeToast says what finished or failed, and what to do next", () => {
	expect(
		outcomeToast({ operation: "rebuild", ok: true, detail: null }, "Alice"),
	).toEqual({ tone: "success", title: "Rebuild of Alice's workspace finished" });
	expect(
		outcomeToast(
			{ operation: "reset-docker", ok: false, detail: "INCUS_ERROR" },
			"Alice",
		),
	).toEqual({
		tone: "danger",
		title: "Docker reset of Alice's workspace failed",
		children:
			"The workspace is in error (INCUS_ERROR). Try again, or look for the error in the Logs tab.",
	});
	expect(
		outcomeToast({ operation: "replace-home", ok: true, detail: null }, "Alice"),
	).toEqual({ tone: "success", title: "Home folder replace for Alice finished" });
	expect(
		outcomeToast(
			{
				operation: "replace-home",
				ok: false,
				detail: "the restore request is missing",
			},
			"Alice",
		),
	).toEqual({
		tone: "danger",
		title: "Home folder replace for Alice failed",
		children:
			"The restore request is missing. Look for the error in the Logs tab, then try again from the Backups tab.",
	});
});

function Watcher({ users }: { users: AdminUser[] | undefined }) {
	useOperationEndToasts(users);
	return null;
}

function rows(pending: PendingOperation | null): AdminUser[] {
	return [
		listed(1, "Alice Example", {
			workspace: summary({ id: WORKSPACE_ID, pendingOperation: pending }),
		}),
		listed(2, "Bob Student"),
	];
}

/** Answers the workspace's audit rows with whatever `audit` holds at the time. */
function stubAudit(audit: () => AuditEvent[]) {
	const asked: string[] = [];
	stubFetch((url) => {
		asked.push(url);
		if (url.startsWith("/admin/audit?action=workspace.")) {
			return json(200, { events: audit(), nextBefore: null });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return asked;
}

function renderWatcher(users: AdminUser[]) {
	const client = createQueryClient();
	const view = (next: AdminUser[]) => (
		<QueryClientProvider client={client}>
			<ToastProvider>
				<Watcher users={next} />
			</ToastProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(view(users));
	return (next: AdminUser[]) => rerender(view(next));
}

test.each([
	[
		"rebuild",
		"workspace.rebuild_requested",
		"workspace.rebuilt",
		"Rebuild of Alice Example's workspace finished",
	],
	[
		"replace-home",
		"workspace.home_replace_requested",
		"workspace.home_replaced",
		"Home folder replace for Alice Example finished",
	],
] as const)(
	"a %s that ends with no panel open is announced once",
	async (operation, requested, action, title) => {
		const asked = stubAudit(() => [auditEvent(9, action), auditEvent(8, requested)]);
		const update = renderWatcher(rows(operation));
		// Nothing is fetched while the operation is pending.
		expect(asked).toEqual([]);

		update(rows(null));
		expect(await screen.findByText(title)).toBeTruthy();
		// A later list with nothing pending says nothing more.
		update(rows(null));
		update(rows(null));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getAllByText(title)).toHaveLength(1);
		expect(asked).toHaveLength(1);
	},
);

test("an operation pending when the view opens is still announced", async () => {
	stubAudit(() => [auditEvent(9, "workspace.docker_reset_failed", { errorCode: "X" })]);
	const update = renderWatcher(rows("reset-docker"));
	update(rows(null));
	expect(
		await screen.findByText("Docker reset of Alice Example's workspace failed"),
	).toBeTruthy();
});

test("nothing is announced for a workspace that was never seen pending", async () => {
	const asked = stubAudit(() => [auditEvent(9, "workspace.rebuilt")]);
	const update = renderWatcher(rows(null));
	update(rows(null));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(asked).toEqual([]);
	expect(screen.queryByText(/workspace finished/)).toBeNull();
});

test("a result audited a poll after the operation cleared is read on a retry", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const requested = auditEvent(8, "workspace.rebuild_requested");
	let audit = [requested];
	const asked = stubAudit(() => audit);
	const update = renderWatcher(rows("rebuild"));
	update(rows(null));
	await waitFor(() => expect(asked).toHaveLength(1));

	audit = [auditEvent(9, "workspace.rebuilt"), requested];
	await vi.advanceTimersByTimeAsync(OUTCOME_RETRY_MS);
	expect(
		await screen.findByText("Rebuild of Alice Example's workspace finished"),
	).toBeTruthy();
	expect(asked).toHaveLength(2);
});

test("a retry stops for a workspace that is pending again, so a later result is not claimed", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const first = auditEvent(8, "workspace.rebuild_requested");
	let audit = [first];
	const asked = stubAudit(() => audit);
	const update = renderWatcher(rows("rebuild"));
	update(rows(null));
	await waitFor(() => expect(asked).toHaveLength(1));

	// A second rebuild starts before the first loop retries, and its result lands.
	update(rows("rebuild"));
	audit = [
		auditEvent(10, "workspace.rebuilt"),
		auditEvent(9, "workspace.rebuild_requested"),
		first,
	];
	await vi.advanceTimersByTimeAsync(OUTCOME_RETRY_MS * 7);
	expect(asked).toHaveLength(1);
	expect(screen.queryByText(/workspace finished/)).toBeNull();

	// The second rebuild's own end is announced once, by its own loop.
	update(rows(null));
	expect(
		await screen.findByText("Rebuild of Alice Example's workspace finished"),
	).toBeTruthy();
	expect(asked).toHaveLength(2);
});

test("a retry drops a workspace whose next operation started and ended between retries", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const first = auditEvent(8, "workspace.rebuild_requested");
	let audit = [first];
	const asked = stubAudit(() => audit);
	const update = renderWatcher(rows("rebuild"));
	update(rows(null));
	await waitFor(() => expect(asked).toHaveLength(1));

	// A second rebuild is seen pending and ends before the first loop retries.
	update(rows("rebuild"));
	audit = [
		auditEvent(10, "workspace.rebuilt"),
		auditEvent(9, "workspace.rebuild_requested"),
		first,
	];
	update(rows(null));
	expect(
		await screen.findByText("Rebuild of Alice Example's workspace finished"),
	).toBeTruthy();
	await vi.advanceTimersByTimeAsync(OUTCOME_RETRY_MS * 7);
	// Only the second loop read the result; the first did not claim it too.
	expect(
		screen.getAllByText("Rebuild of Alice Example's workspace finished"),
	).toHaveLength(1);
	expect(asked).toHaveLength(2);
});

/** Three accounts, each with a workspace and the same pending operation. */
function many(pending: PendingOperation | null): AdminUser[] {
	return [1, 2, 3].map((n) =>
		listed(n, `Owner ${n}`, {
			workspace: summary({ id: uuid(10 + n), pendingOperation: pending }),
		}),
	);
}

test("operations that end in the same poll share one summary toast and one audit read", async () => {
	const asked = stubAudit(() => [
		auditEvent(23, "workspace.rebuild_failed", { errorCode: "X" }, uuid(13)),
		auditEvent(22, "workspace.rebuilt", null, uuid(12)),
		auditEvent(21, "workspace.rebuilt", null, uuid(11)),
	]);
	const update = renderWatcher(many("rebuild"));
	update(many(null));
	const toast = await screen.findByText("Rebuild finished for 2 workspaces; 1 failed");
	expect(toast.closest('[role="alert"]')).not.toBeNull();
	expect(
		screen.getByText("Failed: Owner 3. Look for the errors in the Logs tab."),
	).toBeTruthy();
	expect(asked).toEqual(["/admin/audit?action=workspace.rebuil"]);
});

test("the outcome read pages until every workspace has its newest row", async () => {
	const pages: Record<string, { events: AuditEvent[]; nextBefore: number | null }> = {
		"/admin/audit?action=workspace.docker_reset": {
			events: [auditEvent(30, "workspace.docker_reset", null, uuid(11))],
			nextBefore: 30,
		},
		"/admin/audit?action=workspace.docker_reset&before=30": {
			events: [auditEvent(20, "workspace.docker_reset", null, uuid(12))],
			nextBefore: 20,
		},
	};
	const asked: string[] = [];
	stubFetch((url) => {
		asked.push(url);
		const page = pages[url];
		if (page) return json(200, page);
		throw new Error(`unexpected request: ${url}`);
	});
	const outcomes = await readOutcomes([
		{ workspaceId: uuid(11), ownerName: "A", operation: "reset-docker" },
		{ workspaceId: uuid(12), ownerName: "B", operation: "reset-docker" },
	]);
	expect([...outcomes.keys()].sort()).toEqual([uuid(11), uuid(12)]);
	// Both are found by the second page, so the third is never asked for.
	expect(asked).toHaveLength(2);
});

test("endToasts keeps a single end as it is and sums up several", () => {
	const end = (ownerName: string, ok: boolean) => ({
		ownerName,
		outcome: { operation: "rebuild" as const, ok, detail: null },
	});
	expect(endToasts([end("Ann", true)])).toEqual([
		{ tone: "success", title: "Rebuild of Ann's workspace finished" },
	]);
	expect(endToasts([end("Ann", true), end("Ben", true)])).toEqual([
		{ tone: "success", title: "Rebuild finished for 2 workspaces" },
	]);
	expect(endToasts([end("Ann", false), end("Ben", false)])).toEqual([
		{
			tone: "danger",
			title: "Rebuild failed for 2 workspaces",
			children: "Failed: Ann, Ben. Look for the errors in the Logs tab.",
		},
	]);
	const failures = ["A", "B", "C", "D", "E", "F", "G"].map((name) => end(name, false));
	expect(endToasts([end("Ok", true), ...failures])[0]).toEqual({
		tone: "danger",
		title: "Rebuild finished for 1 workspace; 7 failed",
		children: "Failed: A, B, C, D, E and 2 more. Look for the errors in the Logs tab.",
	});
	// Different operations get a toast each.
	expect(
		endToasts([
			end("Ann", true),
			{
				ownerName: "Ben",
				outcome: { operation: "replace-home", ok: true, detail: null },
			},
		]),
	).toHaveLength(2);
});

test("the Users view announces a rebuild that ends while no panel is open", async () => {
	let pending: PendingOperation | null = "rebuild";
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) return usersBody(url, rows(pending), false);
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		if (url.startsWith("/admin/audit?")) {
			return json(200, {
				events: [
					auditEvent(9, "workspace.rebuild_failed", { errorCode: "INCUS_ERROR" }),
					auditEvent(8, "workspace.rebuild_requested"),
				],
				nextBefore: null,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/admin");
	const row = await screen.findByTestId(`account-row-${uuid(1)}`);
	expect(within(row).getByText("Rebuilding…")).toBeTruthy();

	pending = null;
	const toast = await screen.findByText(
		"Rebuild of Alice Example's workspace failed",
		{},
		{ timeout: 8000 },
	);
	expect(toast.closest('[role="alert"]')).not.toBeNull();
}, 15000);

/** Answers the Users list from `list()`, and counts how often it is asked. */
function stubList(list: () => AdminUser[]) {
	const calls = { users: 0 };
	stubFetch((url) => {
		if (isUsersList(url)) {
			calls.users += 1;
			return usersBody(url, list(), false);
		}
		if (url.startsWith("/admin/audit?")) {
			return json(200, {
				events: [auditEvent(9, "workspace.home_replaced")],
				nextBefore: null,
			});
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return calls;
}

function renderPageWatcher() {
	render(
		<QueryClientProvider client={createQueryClient()}>
			<ToastProvider>
				<OperationEndToasts />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

test("on any admin tab, the list is polled while an operation is pending, and the end announced", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	let pending: PendingOperation | null = "replace-home";
	const calls = stubList(() => rows(pending));
	renderPageWatcher();
	await waitFor(() => expect(calls.users).toBe(1));

	pending = null;
	await vi.advanceTimersByTimeAsync(5000);
	expect(
		await screen.findByText("Home folder replace for Alice Example finished"),
	).toBeTruthy();
	expect(calls.users).toBe(2);
	// Nothing is pending now, so the list is not asked again.
	await vi.advanceTimersByTimeAsync(20_000);
	expect(calls.users).toBe(2);
});

test("with nothing pending, the page's watcher does not poll", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const calls = stubList(() => rows(null));
	renderPageWatcher();
	await waitFor(() => expect(calls.users).toBe(1));
	await vi.advanceTimersByTimeAsync(20_000);
	expect(calls.users).toBe(1);
});
