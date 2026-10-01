import type { AdminUser, AdminWorkspaceDetail } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	json,
	openToggletip,
	renderApp,
	stubFetch,
	USER,
	WORKSPACE,
} from "../test-utils.js";
import {
	GRACE_ERROR,
	graceDraft,
	graceSeconds,
	graceValueText,
} from "./GraceDialog.js";
import { quotaError } from "./QuotaDialog.js";
import {
	instructorChangeNote,
	roleChangeNote,
} from "./workspace-detail/AccountSection.js";
import {
	effectiveGuardText,
	memoryFlagText,
	throttleText,
} from "./workspace-detail/GuardSection.js";
import { lifecycleActions } from "./workspace-detail/HeadState.js";
import {
	limitsPending,
	limitsText,
	quotaPending,
} from "./workspace-detail/ResourcesSection.js";
import { NOT_AVAILABLE_TEXT, PANEL_HELP } from "./workspace-detail/shared.js";
import {
	capabilityNote,
	operationOutcome,
	outcomeToast,
} from "./workspace-detail/WorkspaceSection.js";

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
	role: "administrator" as const,
};

const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	notSignedInYet: false,
	linked: false,
};
const IMAGE = { label: "2026.09.9", fingerprint: "abc", current: true };

const ALICE_ROW = {
	id: USER.id,
	displayName: USER.displayName,
	email: USER.email,
	role: "student" as const,
	providerRole: "student" as const,
	grantedRole: null,
	disabledAt: null,
	shutdownGraceSeconds: null,
	dexLocal: false,
	preferredUsername: "alice",
	issuer: "https://login.example.edu",
	lastLoginAt: null,
	markers: NONE,
	workspace: {
		id: WORKSPACE.id,
		label: WORKSPACE.label,
		state: "running",
		desiredState: "running",
		activeConnections: 1,
		lastActiveConnectionAt: null,
		quotaConfig: WORKSPACE.quotaConfig,
		quotaApplied: WORKSPACE.quotaConfig,
		image: IMAGE,
		archivedAt: null,
		pendingOperation: null,
		cpuThrottle: null,
		memoryFlag: null,
	},
};

const ADMIN_ROW = {
	id: ADMIN.id,
	displayName: ADMIN.displayName,
	email: ADMIN.email,
	role: "administrator" as const,
	providerRole: "administrator" as const,
	grantedRole: null,
	disabledAt: null,
	shutdownGraceSeconds: null,
	dexLocal: false,
	preferredUsername: null,
	issuer: null,
	lastLoginAt: null,
	markers: NONE,
	workspace: null,
};

function detail(overrides: Partial<AdminWorkspaceDetail> = {}): AdminWorkspaceDetail {
	return {
		workspace: { ...WORKSPACE, archivedAt: null },
		owner: {
			id: USER.id,
			displayName: USER.displayName,
			email: USER.email,
			preferredUsername: "alice",
			disabledAt: null,
		},
		quotaApplied: WORKSPACE.quotaConfig,
		image: IMAGE,
		agent: "answering",
		usage: {
			cpuPercent: 12.5,
			memory: { usedBytes: 1024 ** 3, totalBytes: 4 * 1024 ** 3 },
			disk: { usedBytes: 2 * 1024 ** 3, totalBytes: 10 * 1024 ** 3 },
		},
		storage: null,
		ports: [
			{ port: 5173, command: "node", previewReachability: "reachable", system: false },
		],
		previewSessions: [],
		recentAudit: [
			{
				id: 7,
				at: "2026-09-22T10:00:00.000Z",
				actor: `user:${ADMIN.id}`,
				actorName: "Carol Admin",
				action: "workspace.stop_requested",
				target: `workspace:${WORKSPACE.id}`,
				result: "success",
				metadata: null,
			},
		],
		capabilities: { rebuild: false, resetDocker: false },
		guardConfig: null,
		effectiveGuard: {
			cpuThresholdPercent: 80,
			memoryThresholdPercent: 90,
			windowMinutes: 30,
			throttleSharePercent: 25,
			idleStopMinutes: 60,
		},
		cpuThrottle: null,
		memoryFlag: null,
		limitsConfig: null,
		limitsApplied: null,
		...overrides,
	};
}

const GIB = 1024 ** 3;

/** The site settings, whole, so the panel can read the grace and guard values. */
const SETTINGS = {
	shutdownGraceSeconds: 600,
	logLevel: null,
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 10,
	cpuIdleLiftPercent: 10,
	cpuThrottleHoldAfter: 3,
	cpuThrottleHoldHours: 24,
	keepRunningMaxHours: 12,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
	updatedAt: null,
};

/** The Health report the panel reads the site's profile limits from. */
const HEALTH = {
	sampledAt: "2026-09-22T11:59:30.000Z",
	workerStale: false,
	packageUpdate: null,
	controller: { reachable: true, errorCode: null },
	host: {
		loadAverage: [0.5, 0.4, 0.3],
		cpuCount: 4,
		memory: { usedBytes: 4 * GIB, totalBytes: 16 * GIB },
		pool: { usedBytes: 50 * GIB, totalBytes: 100 * GIB, metadataPercent: 20 },
		profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
		image: { fingerprint: null, serial: null },
	},
	workspacesByState: {},
	agents: { answering: 1, running: 1 },
	last24h: {
		startFailures: 0,
		stopFailures: 0,
		forcedStops: 0,
		provisionFailures: 0,
		controllerOutages: 0,
		signInFailures: 0,
		previewRefusals: 0,
	},
	guard: [],
};

/**
 * Answers the admin reads with one detail; every POST and PUT lands in
 * `writes`. With `hold`, writes never answer, so a request stays in flight.
 */
function stubDetail(
	body: AdminWorkspaceDetail,
	{
		hold = false,
		users = [ALICE_ROW, ADMIN_ROW],
	}: { hold?: boolean; users?: unknown[] } = {},
) {
	const writes: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users, dexUsers: false });
		if (url === "/admin/settings") {
			return json(200, SETTINGS);
		}
		if (url === "/admin/health") return json(200, HEALTH);
		if (init?.method === "POST" || init?.method === "PUT") {
			writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
			if (hold) return new Promise<Response>(() => undefined) as unknown as Response;
			return json(204, null);
		}
		if (url === `/admin/workspaces/${WORKSPACE.id}`) return json(200, body);
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

async function openAlice() {
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", { name: /^Show details for Alice Example, / }),
	);
	const panel = await screen.findByRole("region", { name: "Alice Example" });
	await within(panel).findByTestId("detail-quota");
	return panel;
}

test("a quota is pending until the worker has applied the same sizes", () => {
	const config = { homeGiB: 25, dockerGiB: 20 };
	expect(quotaPending(config, config)).toBe(false);
	expect(quotaPending(config, { homeGiB: 10, dockerGiB: 20 })).toBe(true);
	expect(quotaPending(config, null)).toBe(true);
});

test("the quota form refuses a shrink, a non-number, and too much", () => {
	const from = { homeGiB: 25, dockerGiB: 20 };
	expect(quotaError(from, "20", "20")?.message).toBe("Storage can only be increased.");
	expect(quotaError(from, "big", "20")?.message).toBe("Enter whole numbers of GiB.");
	expect(quotaError(from, "2000", "20")?.message).toBe(
		"Each size can be at most 1024 GiB.",
	);
	expect(quotaError(from, "25", "20")?.message).toBe("Change at least one size.");
	expect(quotaError(from, "30", "20")).toBeNull();
});

test("a quota error points at the field at fault (Gate E)", () => {
	const from = { homeGiB: 25, dockerGiB: 20 };
	const fields = (home: string, docker: string) => {
		const problem = quotaError(from, home, docker);
		return problem ? { home: problem.home, docker: problem.docker } : null;
	};
	expect(fields("20", "20")).toEqual({ home: true, docker: false });
	expect(fields("25", "big")).toEqual({ home: false, docker: true });
	expect(fields("2000", "2000")).toEqual({ home: true, docker: true });
	// The message is about the non-number, so only that field is marked.
	expect(quotaError(from, "abc", "999999")).toEqual({
		message: "Enter whole numbers of GiB.",
		home: true,
		docker: false,
	});
	// "Change at least one size" has no single culprit, so it points at Home.
	expect(fields("25", "20")).toEqual({ home: true, docker: false });
});

test("the capability note names what is missing", () => {
	expect(capabilityNote({ rebuild: false, resetDocker: false })).toBe(
		NOT_AVAILABLE_TEXT,
	);
	expect(capabilityNote({ rebuild: true, resetDocker: false })).toMatch(
		/^Reset Docker/,
	);
	expect(capabilityNote({ rebuild: false, resetDocker: true })).toMatch(/^Rebuild/);
	expect(capabilityNote({ rebuild: true, resetDocker: true })).toBeNull();
});

test("the detail panel is a labelled region with usage, ports and recent audit", async () => {
	stubDetail(detail());

	const panel = await openAlice();

	// Use is one fact per row; the disk shows here only without its meter (Epic 25, S6).
	expect(within(panel).getByTestId("detail-disk-use").textContent).toBe(
		"2.0 GB of 10.0 GB",
	);
	expect(within(panel).getByTestId("detail-cpu-use").textContent).toBe("12.5%");
	expect(within(panel).getByTestId("detail-memory-use").textContent).toBe(
		"1.0 GB of 4.0 GB",
	);
	expect(within(panel).getByTestId("detail-quota").textContent).toBe(
		"Home 10 GiB · Docker 10 GiB",
	);
	expect(within(panel).queryByTestId("detail-quota-pending")).toBeNull();
	expect(within(panel).getByRole("table", { name: "Listening ports" })).toBeDefined();
	expect(within(panel).getByText("workspace.stop_requested")).toBeDefined();
	const allEvents = within(panel).getByTestId("detail-all-events");
	expect(allEvents.getAttribute("href")).toBe(
		`/admin?tab=audit&workspace=${WORKSPACE.id}`,
	);
	// The logs link replaces the printed journalctl command (SPEC.md section 24.11).
	const viewLogs = within(panel).getByRole("link", { name: "Logs for this workspace" });
	expect(viewLogs.getAttribute("href")).toBe(
		`/admin?tab=logs&workspace=${WORKSPACE.id}&since=1h`,
	);
	expect(within(panel).queryByText(/journalctl/)).toBeNull();
	// The account's own logs live in the Account section, not a table column (SPEC.md §20.1).
	const userLogs = within(panel).getByRole("link", { name: "View this user's logs" });
	expect(userLogs.getAttribute("href")).toBe(`/admin?tab=logs&user=${USER.id}`);
	// Styled as a link, not body text (Gate E); primitives.css styles pk-link.
	expect(allEvents.className).toContain("pk-link");
	// The selected row is marked as the current one.
	expect(
		screen.getByTestId(`account-row-${USER.id}`).getAttribute("aria-current"),
	).toBe("true");
});

test("the panel's sections come in the Epic 25 order (R2)", async () => {
	stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "error",
				errorCode: "X",
				errorMessage: "Broken.",
			},
		}),
	);
	const panel = await openAlice();
	const headings = within(panel)
		.getAllByRole("heading")
		.map((heading) => `${heading.tagName} ${heading.textContent}`);
	expect(headings).toEqual([
		"H3 Alice Example",
		"H4 Error",
		"H4 Workspace",
		"H4 Resources",
		"H4 Resource guard",
		"H4 Processes",
		"H4 Ports and connections",
		"H4 Account",
		"H4 Recent audit events",
	]);
});

test("an account without a workspace shows its workspace note, grace and account only", async () => {
	stubDetail(detail(), { users: [{ ...ALICE_ROW, workspace: null }, ADMIN_ROW] });
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", { name: /^Show details for Alice Example, / }),
	);
	const panel = await screen.findByRole("region", { name: "Alice Example" });
	await within(panel).findByText("This account has no workspace.");
	const headings = within(panel)
		.getAllByRole("heading", { level: 4 })
		.map((heading) => heading.textContent);
	expect(headings).toEqual(["Workspace", "Resources", "Account"]);
	expect(within(panel).queryByTestId("detail-quota-edit")).toBeNull();
	expect(within(panel).getByTestId("detail-grace-edit")).toBeDefined();
});

test("every section heading sits in a padded, divided detail section", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const h4s = within(panel)
		.getAllByRole("heading")
		.filter((heading) => heading.tagName === "H4");
	expect(h4s.length).toBeGreaterThan(0);
	for (const heading of h4s) {
		expect(
			heading.closest(".pk-detail-section"),
			heading.textContent ?? "",
		).not.toBeNull();
	}
});

test("a running workspace offers Stop and Restart in the head, under the state badge", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const head = within(panel).getByTestId("detail-state").closest(".pk-detail-head");
	expect(head).not.toBeNull();
	const buttons = within(head as HTMLElement)
		.getAllByRole("button")
		.map((button) => button.getAttribute("aria-label"));
	expect(buttons).toEqual([
		"Stop Alice Example's workspace",
		"Restart Alice Example's workspace",
		"Close details for Alice Example",
	]);
	expect(within(panel).queryByTestId("detail-lifecycle-note")).toBeNull();
});

test.each([
	["running", "running", ["stop", "restart"], null],
	["stopped", "stopped", ["start"], null],
	["error", "running", ["start"], null],
	["error", "stopped", ["start"], null],
	["starting", "running", ["stop", "restart"], "starting"],
	["stopped", "running", ["stop", "restart"], "starting"],
	["running", "stopped", ["start"], "stopping"],
	["stopping", "stopped", ["start"], "stopping"],
	["running", "restarting", ["stop", "restart"], "restarting"],
	["provisioning", "running", ["stop", "restart"], "setting up"],
	["mystery", "running", ["start", "stop", "restart"], null],
])("state %s wanting %s offers %j, waiting %s", (state, desired, actions, waiting) => {
	expect(lifecycleActions(state, desired)).toEqual({ actions, waiting });
});

test.each([
	["starting", "running", "Stop", "stop", "starting"],
	["stopped", "running", "Stop", "stop", "starting"],
	["starting", "running", "Restart", "restart", "starting"],
	["stopping", "stopped", "Start", "start", "stopping"],
] as const)(
	"a workspace %s wanting %s keeps %s on to rescue it, with the waiting note",
	async (state, desiredState, label, action, waiting) => {
		const writes = stubDetail(
			detail({ workspace: { ...WORKSPACE, state, desiredState, archivedAt: null } }),
		);
		const panel = await openAlice();
		const button = within(panel).getByRole("button", {
			name: `${label} Alice Example's workspace`,
		});
		expect(button.getAttribute("aria-disabled")).toBeNull();
		expect(button.getAttribute("aria-describedby")).toBeNull();
		expect(within(panel).getByTestId("detail-lifecycle-note").textContent).toBe(
			`Waiting for the workspace to finish ${waiting}.`,
		);
		fireEvent.click(button);
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.url).toBe(`/workspaces/${WORKSPACE.id}/${action}`);
	},
);

test("an archived workspace that is stopping keeps Start off and says both why", async () => {
	const writes = stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "stopping",
				desiredState: "stopped",
				archivedAt: "2026-09-20T00:00:00.000Z",
			},
		}),
	);
	const panel = await openAlice();
	const start = within(panel).getByRole("button", {
		name: "Start Alice Example's workspace",
	});
	expect(start.getAttribute("aria-disabled")).toBe("true");
	const note = within(panel).getByTestId("detail-lifecycle-note");
	expect(note.textContent).toBe(
		"Waiting for the workspace to finish stopping. An archived workspace cannot start. Unarchive it first.",
	);
	expect(start.getAttribute("aria-describedby")).toBe(note.id);
	fireEvent.click(start);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(writes).toEqual([]);
});

test("a stopped archived workspace offers Start, off, with the reason", async () => {
	stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "stopped",
				desiredState: "stopped",
				archivedAt: "2026-09-20T00:00:00.000Z",
			},
		}),
	);
	const panel = await openAlice();
	const start = within(panel).getByRole("button", {
		name: "Start Alice Example's workspace",
	});
	expect(start.getAttribute("aria-disabled")).toBe("true");
	expect(within(panel).getByTestId("detail-lifecycle-note").textContent).toBe(
		"An archived workspace cannot start. Unarchive it first.",
	);
	expect(within(panel).queryByRole("button", { name: /^Stop / })).toBeNull();
});

test("the panel reads the site limits once and does not poll the health report", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		stubDetail(detail());
		const panel = await openAlice();
		await within(panel).findByTestId("detail-limits-edit");
		const healthCalls = () =>
			vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/admin/health")
				.length;
		expect(healthCalls()).toBe(1);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(healthCalls()).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

test("each section's actions sit in one row after its content (S5)", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const resources = within(panel).getByRole("region", { name: "Resources" });
	const actions = within(resources)
		.getAllByRole("button")
		.filter((button) => !button.getAttribute("aria-label")?.startsWith("About "))
		.map((button) => button.textContent);
	expect(actions).toEqual(["Edit quotas…", "Edit limits…", "Edit disconnect grace…"]);
	const row = within(resources).getByTestId("detail-quota-edit").parentElement;
	expect(row?.className).toContain("pk-actions");
	expect(row?.nextElementSibling).toBeNull();
	for (const heading of within(panel).getAllByRole("heading", { level: 4 })) {
		expect(heading.className).toContain("font-semibold");
		expect(heading.className).not.toContain("pk-text-label");
	}
});

test("the Account section shows source, last sign-in, username and email", async () => {
	const signedIn = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
	stubDetail(detail(), { users: [{ ...ALICE_ROW, lastLoginAt: signedIn }, ADMIN_ROW] });
	const panel = await openAlice();
	const account = within(panel).getByRole("region", { name: "Account" });
	expect(within(account).getByTestId("detail-last-sign-in").textContent).toBe(
		"31 days ago",
	);
	expect(within(account).getByText("Source")).toBeDefined();
	expect(within(account).getByText("alice")).toBeDefined();
	expect(within(account).getByTestId("detail-email").textContent).toBe(USER.email);
});

test("an account that never signed in says Never", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-last-sign-in").textContent).toBe("Never");
});

test("a stopped workspace and a silent agent are said plainly, not as errors", async () => {
	stubDetail(detail({ agent: "stopped", usage: null }));
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-usage").textContent).toBe(
		"Not measured: the workspace is not running",
	);
});

test("an agent that does not answer says so", async () => {
	stubDetail(detail({ agent: "not_answering", usage: null }));
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-usage").textContent).toBe(
		"Not measured: the workspace agent is not answering",
	);
});

test("an unapplied storage change shows as pending", async () => {
	stubDetail(detail({ quotaApplied: { homeGiB: 5, dockerGiB: 10 } }));
	const panel = await openAlice();
	// No worker jargon (S7).
	expect(within(panel).getByTestId("detail-quota-pending").textContent).toBe(
		"Storage saved. It takes effect within a minute.",
	);
});

test("the error sentence comes first, then the technical detail", async () => {
	stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "error",
				errorCode: "STORAGE_FULL",
				errorMessage: "The workspace could not start because its storage is full.",
			},
		}),
	);
	const panel = await openAlice();
	const error = within(panel).getByRole("region", { name: "Error" });
	expect(error.textContent).toContain("STORAGE_FULL");
	expect(error.children[0]?.textContent).toBe("Error");
	expect(error.children[1]?.textContent).toBe(
		"The workspace could not start because its storage is full.",
	);
});

test("without the capability, Rebuild and Reset Docker are off and say why", async () => {
	stubDetail(detail());
	const panel = await openAlice();

	const rebuild = within(panel).getByRole("button", {
		name: "Rebuild workspace for Alice Example",
	}) as HTMLButtonElement;
	const reset = within(panel).getByRole("button", {
		name: "Reset Docker for Alice Example",
	}) as HTMLButtonElement;
	expect(rebuild.getAttribute("aria-disabled")).toBe("true");
	expect(reset.getAttribute("aria-disabled")).toBe("true");
	const note = within(panel).getByTestId("capability-note");
	expect(note.textContent).toBe(NOT_AVAILABLE_TEXT);
	expect(rebuild.getAttribute("aria-describedby")).toBe(note.id);
	expect(reset.getAttribute("aria-describedby")).toBe(note.id);
});

test("a pending operation turns Rebuild and Reset Docker off and says so", async () => {
	stubDetail(
		detail({
			workspace: { ...WORKSPACE, archivedAt: null, pendingOperation: "rebuild" },
			capabilities: { rebuild: true, resetDocker: true },
		}),
	);
	const panel = await openAlice();

	const rebuild = within(panel).getByRole("button", {
		name: "Rebuild workspace for Alice Example",
	}) as HTMLButtonElement;
	const reset = within(panel).getByRole("button", {
		name: "Reset Docker for Alice Example",
	}) as HTMLButtonElement;
	expect(rebuild.getAttribute("aria-disabled")).toBe("true");
	expect(reset.getAttribute("aria-disabled")).toBe("true");
	expect(within(panel).getByTestId("pending-operation").textContent).toMatch(
		/^Rebuilding…/,
	);
	// Still focusable, pointed at the note, and a click opens nothing (Gate E).
	expect(rebuild.disabled).toBe(false);
	expect(rebuild.getAttribute("aria-describedby")).toBe(
		within(panel).getByTestId("pending-operation").id,
	);
	rebuild.focus();
	fireEvent.click(rebuild);
	expect(screen.queryByTestId("rebuild-dialog")).toBeNull();
	expect(document.activeElement).toBe(rebuild);
});

function auditEvent(
	id: number,
	action: string,
	metadata: Record<string, unknown> | null = null,
) {
	return {
		id,
		at: "2026-09-22T10:00:00.000Z",
		actor: "system:worker",
		actorName: null,
		action,
		target: WORKSPACE.id,
		result: action.endsWith("_failed") ? "failed" : "ok",
		metadata,
	};
}

test("operationOutcome reads the newest rebuild or reset result after the watch began", () => {
	const events = [
		auditEvent(9, "workspace.rebuild_failed", { errorCode: "CONTROLLER_TIMEOUT" }),
		auditEvent(8, "workspace.rebuild_requested"),
		auditEvent(5, "workspace.docker_reset"),
	];
	expect(operationOutcome(events, 8)).toEqual({
		rebuild: true,
		ok: false,
		errorCode: "CONTROLLER_TIMEOUT",
	});
	// Nothing after the watch began: the result is a poll away.
	expect(operationOutcome(events, 9)).toBeNull();
	// An older result is not this operation's.
	expect(operationOutcome(events.slice(1), 5)).toBeNull();
	expect(operationOutcome([auditEvent(6, "workspace.docker_reset")], 5)).toEqual({
		rebuild: false,
		ok: true,
		errorCode: null,
	});
});

test("outcomeToast says what finished or failed, and what to do next", () => {
	expect(outcomeToast({ rebuild: true, ok: true, errorCode: null }, "Alice")).toEqual({
		tone: "success",
		title: "Rebuild of Alice's workspace finished",
	});
	expect(
		outcomeToast({ rebuild: false, ok: false, errorCode: "INCUS_ERROR" }, "Alice"),
	).toEqual({
		tone: "danger",
		title: "Docker reset of Alice's workspace failed",
		children:
			"The workspace is in error (INCUS_ERROR). Try again, or look for the error in the Logs tab.",
	});
});

test.each([
	["workspace.rebuilt", "Rebuild of Alice Example's workspace finished", "status"],
	["workspace.rebuild_failed", "Rebuild of Alice Example's workspace failed", "alert"],
])(
	"a confirmed rebuild shows Rebuilding… on the panel and row, then announces %s",
	async (action, title, role) => {
		const requested = auditEvent(8, "workspace.rebuild_requested");
		let body = detail({ capabilities: { rebuild: true, resetDocker: true } });
		let pending: string | null = null;
		const row = () => ({
			...ALICE_ROW,
			workspace: { ...ALICE_ROW.workspace, pendingOperation: pending },
		});
		stubFetch((url, init) => {
			if (url === "/auth/me") return json(200, ADMIN);
			if (url === "/admin/users")
				return json(200, { users: [row(), ADMIN_ROW], dexUsers: false });
			if (url === "/admin/settings") return json(200, SETTINGS);
			if (url === "/admin/health") return json(200, HEALTH);
			if (init?.method === "POST") {
				// The API sets the pending operation before it answers 202 (ADR 0021).
				body = detail({
					workspace: { ...WORKSPACE, archivedAt: null, pendingOperation: "rebuild" },
					capabilities: { rebuild: true, resetDocker: true },
					recentAudit: [requested],
				});
				pending = "rebuild";
				return json(202, { ok: true });
			}
			if (url === `/admin/workspaces/${WORKSPACE.id}`) return json(200, body);
			throw new Error(`unexpected request: ${url}`);
		});
		const panel = await openAlice();

		fireEvent.click(
			within(panel).getByRole("button", {
				name: "Rebuild workspace for Alice Example",
			}),
		);
		const dialog = await screen.findByTestId("rebuild-dialog");
		fireEvent.change(within(dialog).getByRole("textbox"), {
			target: { value: WORKSPACE.label },
		});
		fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

		// The head badge sits in a status region, so the start is announced.
		const state = within(panel).getByTestId("detail-state");
		await waitFor(() => expect(state.textContent).toBe("Rebuilding…"));
		expect(state.getAttribute("role")).toBe("status");
		expect(state.querySelector(".pk-spin")).not.toBeNull();
		const usersRow = screen.getByTestId(`account-row-${USER.id}`);
		await waitFor(() => expect(within(usersRow).getByText("Rebuilding…")).toBeTruthy());
		expect(
			within(panel)
				.getByRole("button", { name: "Rebuild workspace for Alice Example" })
				.getAttribute("aria-disabled"),
		).toBe("true");

		// The worker clears the operation, then audits the result.
		body = detail({
			workspace: { ...WORKSPACE, state: "stopped", archivedAt: null },
			capabilities: { rebuild: true, resetDocker: true },
			recentAudit: [auditEvent(9, action), requested],
		});
		pending = null;

		const toast = await screen.findByText(title, {}, { timeout: 8000 });
		expect(toast.closest(`[role="${role}"]`)).not.toBeNull();
		expect(state.textContent).not.toBe("Rebuilding…");
		await waitFor(() => expect(within(usersRow).queryByText("Rebuilding…")).toBeNull());
	},
	20000,
);

test("the detail shows per-class storage meters when the agent measured them", async () => {
	const gib = 1024 ** 3;
	stubDetail(
		detail({
			storage: {
				home: { usedBytes: 5 * gib, limitBytes: 25 * gib },
				docker: { usedBytes: 19 * gib, limitBytes: 20 * gib },
				recovery: { usedBytes: 1 * gib, limitBytes: 3 * gib },
			},
		}),
	);
	const panel = await openAlice();

	expect(within(panel).getByLabelText("Projects and home")).toBeTruthy();
	expect(within(panel).getByLabelText("Recovery")).toBeTruthy();
	expect(within(panel).getByLabelText("Docker").getAttribute("aria-valuetext")).toMatch(
		/nearly full$/,
	);
});

test("Rebuild asks for the exact workspace label before it calls the route", async () => {
	const writes = stubDetail(
		detail({ capabilities: { rebuild: true, resetDocker: true } }),
	);
	const panel = await openAlice();
	expect(within(panel).queryByTestId("capability-note")).toBeNull();

	fireEvent.click(
		within(panel).getByRole("button", { name: "Rebuild workspace for Alice Example" }),
	);
	const dialog = await screen.findByTestId("rebuild-dialog");
	const confirm = within(dialog).getByTestId("dialog-confirm") as HTMLButtonElement;
	expect(confirm.disabled).toBe(true);
	// SPEC.md §22.3: the warning names what a rebuild loses.
	const described = document.getElementById(
		dialog.getAttribute("aria-describedby") ?? "",
	);
	expect(described?.textContent).toContain(
		"System packages installed with sudo apt are lost",
	);
	// The checkbox is a sibling of the description, not read as part of it.
	expect(described?.contains(within(dialog).getByRole("checkbox"))).toBe(false);

	const typed = within(dialog).getByRole("textbox");
	fireEvent.change(typed, { target: { value: "TW7" } });
	expect(confirm.disabled).toBe(true);
	fireEvent.change(typed, { target: { value: WORKSPACE.label } });
	expect(confirm.disabled).toBe(false);

	fireEvent.click(within(dialog).getByRole("checkbox"));
	fireEvent.click(confirm);

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/workspaces/${WORKSPACE.id}/rebuild`,
		body: { resetDocker: true },
	});
});

test("Reset Docker asks for the label and calls the owner route", async () => {
	const writes = stubDetail(
		detail({ capabilities: { rebuild: true, resetDocker: true } }),
	);
	const panel = await openAlice();

	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Reset Docker for Alice Example",
		}),
	);
	const dialog = await screen.findByTestId("reset-docker-dialog");
	fireEvent.change(within(dialog).getByRole("textbox"), {
		target: { value: WORKSPACE.label },
	});
	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.url).toBe(`/workspaces/${WORKSPACE.id}/reset-docker`);
});

test("focus returns to the button that opened a dialog", async () => {
	stubDetail(detail());
	const panel = await openAlice();

	const opener = within(panel).getByRole("button", {
		name: "Archive workspace for Alice Example",
	});
	opener.focus();
	fireEvent.click(opener);
	const dialog = await screen.findByTestId("archive-dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

	await waitFor(() => expect(screen.queryByTestId("archive-dialog")).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("closing the panel returns focus to the row", async () => {
	stubDetail(detail());
	const panel = await openAlice();

	fireEvent.click(
		within(panel).getByRole("button", { name: "Close details for Alice Example" }),
	);

	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: /^Show details for Alice Example, / }),
		),
	);
});

test("stop uses the student route", async () => {
	const writes = stubDetail(detail());
	const panel = await openAlice();

	fireEvent.click(
		within(panel).getByRole("button", { name: "Stop Alice Example's workspace" }),
	);

	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.url).toBe(`/workspaces/${WORKSPACE.id}/stop`);
});

test("archive and disable confirm first, then call their routes", async () => {
	const writes = stubDetail(detail());
	const panel = await openAlice();

	fireEvent.click(
		within(panel).getByRole("button", { name: "Archive workspace for Alice Example" }),
	);
	fireEvent.click(
		within(await screen.findByTestId("archive-dialog")).getByTestId("dialog-confirm"),
	);
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.url).toBe(`/admin/workspaces/${WORKSPACE.id}/archive`);

	fireEvent.click(
		within(panel).getByRole("button", { name: "Disable account for Alice Example" }),
	);
	fireEvent.click(
		within(await screen.findByTestId("disable-dialog")).getByTestId("dialog-confirm"),
	);
	await waitFor(() => expect(writes.length).toBe(2));
	expect(writes[1]?.url).toBe(`/admin/users/${USER.id}/disable`);
});

test("a shrink is refused in the dialog, and a grow is sent", async () => {
	const writes = stubDetail(detail());
	const panel = await openAlice();

	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Edit quotas for Alice Example's workspace",
		}),
	);
	const dialog = await screen.findByTestId("quota-dialog");
	fireEvent.change(within(dialog).getByTestId("quota-home"), {
		target: { value: "5" },
	});
	fireEvent.click(within(dialog).getByTestId("quota-save"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Storage can only be increased.",
	);
	// The error belongs to the field at fault (Gate E).
	const homeField = within(dialog).getByRole("textbox", { name: "Home (GiB)" });
	expect(homeField.getAttribute("aria-invalid")).toBe("true");
	expect(homeField.getAttribute("aria-describedby")).toBe("quota-home-err");
	expect(
		within(dialog)
			.getByRole("textbox", { name: "Docker (GiB)" })
			.getAttribute("aria-invalid"),
	).toBe(null);
	expect(writes.length).toBe(0);

	fireEvent.change(within(dialog).getByTestId("quota-home"), {
		target: { value: "30" },
	});
	fireEvent.click(within(dialog).getByTestId("quota-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/workspaces/${WORKSPACE.id}/quota`,
		body: { homeGiB: 30, dockerGiB: 10 },
	});
});

test("an administrator cannot disable their own account", async () => {
	stubDetail(detail());
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", { name: /^Show details for Carol Admin, / }),
	);
	const panel = await screen.findByRole("region", { name: "Carol Admin" });

	const button = within(panel).getByRole("button", {
		name: "Disable account for Carol Admin",
	}) as HTMLButtonElement;
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(within(panel).getByText("You cannot disable your own account.")).toBeDefined();
	expect(within(panel).getByText("This account has no workspace.")).toBeDefined();
});

test("opening a panel focuses its heading and marks the row (Gate E)", async () => {
	stubDetail(detail());
	const panel = await openAlice();

	await waitFor(() =>
		expect(document.activeElement).toBe(
			within(panel).getByRole("heading", { name: "Alice Example" }),
		),
	);
	const rowButton = screen.getByRole("button", {
		name: /^Show details for Alice Example, /,
	});
	expect(rowButton.getAttribute("aria-expanded")).toBe("true");
	expect(rowButton.getAttribute("aria-controls")).toBe(panel.id);
	expect(rowButton.className).toContain("pk-focus-inset");
	// The selected row carries the ink bar, not only a background colour.
	expect(screen.getByTestId(`account-cell-${USER.id}`).style.boxShadow).toBe(
		"var(--row-current-bar)",
	);
	const carol = screen.getByRole("button", { name: /^Show details for Carol Admin, / });
	expect(carol.getAttribute("aria-expanded")).toBe("false");
	expect(carol.hasAttribute("aria-controls")).toBe(false);
});

test("row buttons add the email so repeated names stay distinct (Gate E)", async () => {
	stubDetail(detail());
	renderApp("/admin");
	expect(
		await screen.findByRole("button", {
			name: `Show details for Alice Example, ${USER.email}`,
		}),
	).toBeDefined();
});

test("each action's name starts with its visible text (WCAG 2.5.3)", async () => {
	stubDetail(detail({ capabilities: { rebuild: true, resetDocker: true } }));
	const panel = await openAlice();

	for (const button of within(panel).getAllByRole("button")) {
		const visible = (button.textContent ?? "").replace(/…$/, "").trim();
		const name = button.getAttribute("aria-label");
		if (visible === "" || name === null) continue;
		expect(name.startsWith(visible.replace(/…$/, ""))).toBe(true);
	}
});

test("Stop keeps focus and ignores repeats while its request runs (Gate E)", async () => {
	const writes = stubDetail(detail(), { hold: true });
	const panel = await openAlice();

	const stop = within(panel).getByRole("button", {
		name: "Stop Alice Example's workspace",
	});
	stop.focus();
	fireEvent.click(stop);
	await waitFor(() => expect(stop.getAttribute("aria-busy")).toBe("true"));
	expect(document.activeElement).toBe(stop);
	expect(stop.hasAttribute("disabled")).toBe(false);
	const restart = within(panel).getByRole("button", {
		name: "Restart Alice Example's workspace",
	});
	expect(restart.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(stop);
	fireEvent.click(restart);
	expect(writes.length).toBe(1);
});

test("Unarchive keeps focus while its request runs (Gate E)", async () => {
	const writes = stubDetail(
		detail({ workspace: { ...WORKSPACE, archivedAt: "2026-09-20T10:00:00.000Z" } }),
		{
			hold: true,
			users: [{ ...ALICE_ROW, markers: NONE }, ADMIN_ROW],
		},
	);
	const panel = await openAlice();

	const unarchive = within(panel).getByRole("button", {
		name: "Unarchive workspace for Alice Example",
	});
	unarchive.focus();
	fireEvent.click(unarchive);
	await waitFor(() => expect(unarchive.getAttribute("aria-busy")).toBe("true"));
	expect(document.activeElement).toBe(unarchive);
	expect(unarchive.hasAttribute("disabled")).toBe(false);
	fireEvent.click(unarchive);
	expect(writes.length).toBe(1);
});

test("Archive workspace cannot reopen its dialog while its request runs", async () => {
	const writes = stubDetail(detail(), { hold: true });
	const panel = await openAlice();

	const archive = within(panel).getByRole("button", {
		name: "Archive workspace for Alice Example",
	});
	fireEvent.click(archive);
	fireEvent.click(
		within(await screen.findByTestId("archive-dialog")).getByTestId("dialog-confirm"),
	);
	await waitFor(() => expect(writes.length).toBe(1));
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
	await waitFor(() => expect(screen.queryByTestId("archive-dialog")).toBeNull());

	expect(archive.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(archive);
	expect(screen.queryByTestId("archive-dialog")).toBeNull();
	expect(writes.length).toBe(1);
});

test("Enable account keeps focus while its request runs (Gate E)", async () => {
	const writes = stubDetail(detail(), {
		hold: true,
		users: [{ ...ALICE_ROW, disabledAt: "2026-09-20T10:00:00.000Z" }, ADMIN_ROW],
	});
	const panel = await openAlice();

	const enable = within(panel).getByRole("button", {
		name: "Enable account for Alice Example",
	});
	enable.focus();
	fireEvent.click(enable);
	await waitFor(() => expect(enable.getAttribute("aria-busy")).toBe("true"));
	expect(document.activeElement).toBe(enable);
	expect(enable.hasAttribute("disabled")).toBe(false);
	fireEvent.click(enable);
	expect(writes.length).toBe(1);
});

test("closing a panel whose row is filtered out focuses the table caption (Gate E)", async () => {
	stubDetail(detail());
	const panel = await openAlice();

	fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
		target: { value: "nobody-matches" },
	});
	expect(screen.queryByTestId(`account-row-${USER.id}`)).toBeNull();
	fireEvent.click(
		within(panel).getByRole("button", { name: "Close details for Alice Example" }),
	);

	await waitFor(() =>
		expect(document.activeElement?.id).toBe("admin-accounts-caption"),
	);
});

test("the disconnect grace shows the site setting, and its dialog takes minutes (S8)", async () => {
	const writes: { url: string; body: unknown }[] = [];
	let row = { ...ALICE_ROW };
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users")
			return json(200, { users: [row, ADMIN_ROW], dexUsers: false });
		if (url === "/admin/settings") {
			return json(200, SETTINGS);
		}
		if (url === "/admin/health") return json(200, HEALTH);
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			writes.push({ url, body });
			row = { ...row, shutdownGraceSeconds: body.shutdownGraceSeconds };
			return json(200, row);
		}
		if (url === `/admin/workspaces/${WORKSPACE.id}`) return json(200, detail());
		throw new Error(`unexpected request: ${url}`);
	});
	const panel = await openAlice();
	const resources = within(panel).getByRole("region", { name: "Resources" });
	expect(await within(resources).findByText("10 minutes (site setting)")).toBeDefined();
	// The old seconds field is gone from the panel.
	expect(within(panel).queryByRole("textbox")).toBeNull();

	fireEvent.click(
		within(resources).getByRole("button", {
			name: "Edit disconnect grace for Alice Example",
		}),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Disconnect grace for Alice Example",
	});
	const field = within(dialog).getByRole("textbox", {
		name: "Disconnect grace (minutes)",
	}) as HTMLInputElement;
	expect(field.value).toBe("");
	expect(
		document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Site setting: 10 minutes. 0 keeps it running until it is stopped.");

	fireEvent.change(field, { target: { value: "soon" } });
	fireEvent.click(within(dialog).getByTestId("grace-dialog-save"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(GRACE_ERROR);
	expect(writes).toEqual([]);

	fireEvent.change(field, { target: { value: "30" } });
	fireEvent.click(within(dialog).getByTestId("grace-dialog-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	// The API still takes seconds.
	expect(writes[0]).toEqual({
		url: `/admin/users/${USER.id}/settings`,
		body: { shutdownGraceSeconds: 1800 },
	});
	expect(await screen.findByText("Disconnect grace saved")).toBeDefined();
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(await within(resources).findByText("30 minutes")).toBeDefined();

	fireEvent.click(
		within(resources).getByRole("button", {
			name: "Edit disconnect grace for Alice Example",
		}),
	);
	const again = await screen.findByRole("dialog", {
		name: "Disconnect grace for Alice Example",
	});
	const minutes = within(again).getByLabelText(
		"Disconnect grace (minutes)",
	) as HTMLInputElement;
	expect(minutes.value).toBe("30");
	fireEvent.change(minutes, { target: { value: "" } });
	fireEvent.click(within(again).getByTestId("grace-dialog-save"));
	await waitFor(() => expect(writes.length).toBe(2));
	expect(writes[1]?.body).toEqual({ shutdownGraceSeconds: null });
});

test("without the site settings, the grace claims no value it does not know", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users")
			return json(200, { users: [ALICE_ROW, ADMIN_ROW], dexUsers: false });
		if (url === "/admin/settings") {
			return json(500, { code: "INTERNAL", message: "Settings are unavailable." });
		}
		if (url === "/admin/health") return json(200, HEALTH);
		if (url === `/admin/workspaces/${WORKSPACE.id}`) return json(200, detail());
		throw new Error(`unexpected request: ${url}`);
	});
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-grace").textContent).toBe("Site setting");
	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Edit disconnect grace for Alice Example",
		}),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Disconnect grace for Alice Example",
	});
	const field = within(dialog).getByLabelText("Disconnect grace (minutes)");
	expect(
		document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("0 keeps it running until it is stopped.");
});

test("grace minutes convert to and from the API's seconds", () => {
	expect(graceSeconds("")).toBeNull();
	expect(graceSeconds(" 0 ")).toBe(0);
	expect(graceSeconds("10")).toBe(600);
	expect(graceSeconds("1.5")).toBe(90);
	expect(graceSeconds("-1")).toBeUndefined();
	expect(graceSeconds("ten")).toBeUndefined();
	expect(graceSeconds("99999999999")).toBeUndefined();
	expect(graceDraft(null)).toBe("");
	expect(graceDraft(600)).toBe("10");
	expect(graceDraft(90)).toBe("1.5");
	expect(graceDraft(100)).toBe("1.67");
	expect(graceValueText(0)).toBe("Never stops on disconnect");
	expect(graceValueText(3600)).toBe("1 hour");
});

// Promote and demote (docs/archive/epics/EPIC-13-1.md ruling 23).
const GRANTED_ROW = {
	...ALICE_ROW,
	id: "44444444-4444-4444-8444-444444444444",
	displayName: "Gina Granted",
	email: "gina@example.invalid",
	role: "administrator" as const,
	providerRole: "student" as const,
	grantedRole: "administrator" as const,
	workspace: null,
};
const COURSE_ROW = {
	...ALICE_ROW,
	id: "55555555-5555-4555-8555-555555555555",
	displayName: "Sam Course",
	email: null,
	issuer: "lti:https://canvas.example.edu",
	workspace: null,
};
const ROLE_ROWS = [
	{ ...ALICE_ROW, workspace: null },
	ADMIN_ROW,
	GRANTED_ROW,
	COURSE_ROW,
];

/** Answers the list; a promote or demote answers 400 with `refusal` when given. */
function stubRoles(refusal?: string) {
	const writes: string[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: ROLE_ROWS, dexUsers: false });
		if (url === "/admin/settings") {
			return json(200, SETTINGS);
		}
		if (init?.method === "POST") {
			writes.push(url);
			if (refusal) return json(400, { code: "VALIDATION_FAILED", message: refusal });
			return json(200, ALICE_ROW);
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

/** Whether a confirmation is drawn as destructive: the alert icon rather than the neutral one. */
function isDestructive(dialog: HTMLElement): boolean {
	const status = dialog.querySelector(".pk-dialog-status");
	if (!status) throw new Error("no dialog status icon");
	return !status.classList.contains("pk-dialog-status--neutral");
}

async function openRow(name: string) {
	renderApp("/admin");
	fireEvent.click(
		await screen.findByRole("button", {
			name: new RegExp(`^Show details for ${name}, `),
		}),
	);
	return screen.findByRole("region", { name });
}

test("the account section shows the role, source, issuer and username (issue #302)", async () => {
	stubRoles();
	const panel = await openRow("Alice Example");
	expect(within(panel).getByTestId("detail-role").textContent).toBe("Student");
	expect(within(panel).getByTestId("detail-issuer").textContent).toBe(
		"https://login.example.edu",
	);
	expect(within(panel).getByText("alice")).toBeDefined();
});

test("promote asks first, then calls the promote route", async () => {
	const writes = stubRoles();
	const panel = await openRow("Alice Example");
	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Promote Alice Example to administrator",
		}),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Make Alice Example an administrator?",
	});
	// Promoting takes nothing away, so it is not drawn as destructive (S3).
	expect(isDestructive(dialog)).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([`/admin/users/${USER.id}/promote`]);
	expect(
		await screen.findByText("Alice Example is now an administrator"),
	).toBeDefined();
});

test("demote asks first, says where they go back to, then calls the demote route", async () => {
	const writes = stubRoles();
	const panel = await openRow("Gina Granted");
	expect(within(panel).getByTestId("detail-role").textContent).toBe(
		"Administrator (granted)",
	);
	fireEvent.click(within(panel).getByRole("button", { name: "Demote Gina Granted" }));
	const dialog = await screen.findByRole("alertdialog", {
		name: "Demote Gina Granted?",
	});
	expect(within(dialog).getByText(/They go back to Student/)).toBeDefined();
	expect(isDestructive(dialog)).toBe(true);
	fireEvent.click(within(dialog).getByRole("button", { name: "Demote" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([`/admin/users/${GRANTED_ROW.id}/demote`]);
});

test.each([
	[
		"Sam Course",
		"Promote Sam Course to administrator",
		"Only SSO accounts can be administrators.",
	],
	["Carol Admin", "Demote Carol Admin", "You cannot demote your own account."],
])("%s's button is off and says why", async (name, button, note) => {
	const writes = stubRoles();
	const panel = await openRow(name);
	const action = within(panel).getByRole("button", { name: button });
	expect(action.getAttribute("aria-disabled")).toBe("true");
	expect(action.getAttribute("aria-describedby")).toBe(
		within(panel).getByText(note).id,
	);
	fireEvent.click(action);
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(writes).toEqual([]);
});

test("a provider administrator cannot be demoted, and the note says why", () => {
	expect(roleChangeNote({ ...ADMIN_ROW, id: "someone-else" } as AdminUser, false)).toBe(
		"This administrator comes from the SSO provider's groups.",
	);
	expect(roleChangeNote(GRANTED_ROW as AdminUser, false)).toBeNull();
	expect(roleChangeNote(ALICE_ROW as AdminUser, false)).toBeNull();
});

test.each([
	"Only SSO accounts can be administrators.",
	"You cannot demote your own account.",
	"This administrator comes from the SSO provider's groups.",
	"This account is not an administrator.",
	"At least one other enabled administrator must remain.",
])("the dialog shows the server's refusal: %s", async (message) => {
	stubRoles(message);
	const panel = await openRow("Gina Granted");
	fireEvent.click(within(panel).getByRole("button", { name: "Demote Gina Granted" }));
	const dialog = await screen.findByRole("alertdialog", {
		name: "Demote Gina Granted?",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Demote" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
	// Reopening starts clean.
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	fireEvent.click(within(panel).getByRole("button", { name: "Demote Gina Granted" }));
	const again = await screen.findByRole("alertdialog", {
		name: "Demote Gina Granted?",
	});
	expect(within(again).queryByRole("alert")).toBeNull();
});

test("a refused promote shows the refusal in its dialog", async () => {
	stubRoles("Only SSO accounts can be administrators.");
	const panel = await openRow("Alice Example");
	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Promote Alice Example to administrator",
		}),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Make Alice Example an administrator?",
	});
	// Promoting takes nothing away, so it is not drawn as destructive (S3).
	expect(isDestructive(dialog)).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Only SSO accounts can be administrators.",
	);
});

// Make and remove instructor (docs/archive/epics/EPIC-14.md ruling 14).
const TEACHER_ROW = {
	...ALICE_ROW,
	id: "66666666-6666-4666-8666-666666666666",
	displayName: "Tia Teacher",
	email: "tia@example.invalid",
	role: "instructor" as const,
	providerRole: "student" as const,
	grantedRole: "instructor" as const,
	workspace: null,
};

function stubInstructors(refusal?: string) {
	const writes: string[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") {
			return json(200, { users: [...ROLE_ROWS, TEACHER_ROW], dexUsers: false });
		}
		if (url === "/admin/settings") {
			return json(200, SETTINGS);
		}
		if (init?.method === "POST") {
			writes.push(url);
			if (refusal) return json(400, { code: "VALIDATION_FAILED", message: refusal });
			return json(200, ALICE_ROW);
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

test("make instructor asks first, then calls its route", async () => {
	const writes = stubInstructors();
	const panel = await openRow("Alice Example");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Make instructor: Alice Example" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Make Alice Example an instructor?",
	});
	expect(isDestructive(dialog)).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Make instructor" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([`/admin/users/${USER.id}/make-instructor`]);
	expect(await screen.findByText("Alice Example is now an instructor")).toBeDefined();
});

test("remove instructor shows for a granted instructor and says where they go back to", async () => {
	const writes = stubInstructors();
	const panel = await openRow("Tia Teacher");
	expect(within(panel).getByTestId("detail-role").textContent).toBe(
		"Instructor (granted)",
	);
	expect(within(panel).queryByRole("button", { name: /^Make instructor/ })).toBeNull();
	fireEvent.click(
		within(panel).getByRole("button", { name: "Remove instructor: Tia Teacher" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Remove instructor from Tia Teacher?",
	});
	expect(within(dialog).getByText(/They go back to Student/)).toBeDefined();
	expect(isDestructive(dialog)).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove instructor" }));
	await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	expect(writes).toEqual([`/admin/users/${TEACHER_ROW.id}/remove-instructor`]);
});

test.each([
	["Sam Course", "Only SSO accounts can be instructors."],
	["Gina Granted", "This account is a granted administrator. Demote first."],
	["Carol Admin", "Already an administrator from the SSO provider."],
])("%s cannot be made an instructor, and the note says why", async (name, note) => {
	const writes = stubInstructors();
	const panel = await openRow(name);
	const action = within(panel).getByRole("button", {
		name: `Make instructor: ${name}`,
	});
	expect(action.getAttribute("aria-disabled")).toBe("true");
	expect(action.getAttribute("aria-describedby")).toBe(
		within(panel).getByText(note).id,
	);
	fireEvent.click(action);
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(writes).toEqual([]);
});

test("instructorChangeNote leaves a student and a granted instructor on", () => {
	expect(instructorChangeNote(ALICE_ROW as AdminUser)).toBeNull();
	expect(instructorChangeNote(TEACHER_ROW as AdminUser)).toBeNull();
	expect(
		instructorChangeNote({
			...ALICE_ROW,
			role: "instructor",
			providerRole: "instructor",
		} as AdminUser),
	).toBe("Already an instructor from the SSO provider.");
});

test("a refused make instructor shows the refusal in its dialog", async () => {
	stubInstructors("Demote first.");
	const panel = await openRow("Alice Example");
	fireEvent.click(
		within(panel).getByRole("button", { name: "Make instructor: Alice Example" }),
	);
	const dialog = await screen.findByRole("alertdialog", {
		name: "Make Alice Example an instructor?",
	});
	expect(isDestructive(dialog)).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Make instructor" }));
	expect((await within(dialog).findByRole("alert")).textContent).toBe("Demote first.");
});

const THROTTLE = {
	at: "2026-09-25T12:00:00.000Z",
	thresholdPercent: 80,
	windowMinutes: 30,
	sharePercent: 25,
	averagePercent: 97.4,
	allowance: "100ms/100ms",
};
const FLAG = {
	at: "2026-09-25T12:00:00.000Z",
	averagePercent: 93,
	thresholdPercent: 90,
	windowMinutes: 30,
};

test("the guard texts give the numbers and mark overrides", () => {
	expect(throttleText(null)).toBe("Normal");
	expect(throttleText(THROTTLE)).toContain(
		"It averaged 97% over 30 minutes, above 80%, and now gets 25% of its CPU.",
	);
	expect(memoryFlagText(FLAG)).toContain("It averaged 93% over 30 minutes, above 90%.");
	const guard = {
		cpuThresholdPercent: 80,
		memoryThresholdPercent: 90,
		windowMinutes: 30,
		throttleSharePercent: 25,
		idleStopMinutes: 0,
	};
	expect(effectiveGuardText(guard, { idleStopMinutes: 0 })).toEqual([
		"CPU above 80% for 30 minutes is slowed to 25%.",
		"Memory above 90% is flagged.",
		"Never stopped for inactivity (override).",
	]);
	expect(effectiveGuardText({ ...guard, idleStopMinutes: 60 }, null)[2]).toBe(
		"Stopped after 60 minutes without activity.",
	);
});

test("the guard summary names the owner's Keep running hold only while it lasts", () => {
	const guard = {
		cpuThresholdPercent: 80,
		memoryThresholdPercent: 90,
		windowMinutes: 30,
		throttleSharePercent: 25,
		idleStopMinutes: 60,
	};
	const now = Date.parse("2026-10-01T12:00:00.000Z");
	const until = "2026-10-01T20:00:00.000Z";
	const lines = effectiveGuardText(guard, null, until, now);
	expect(lines).toHaveLength(4);
	expect(lines[3]).toMatch(/^Kept running by its owner until .+\.$/);
	expect(effectiveGuardText(guard, null, until, Date.parse(until) + 1)).toHaveLength(3);
	expect(effectiveGuardText(guard, null, null, now)).toHaveLength(3);
});

test("a normal workspace shows its limits and last activity, with no lift or clear", async () => {
	stubDetail(
		detail({ workspace: { ...WORKSPACE, lastActivityAt: "2026-09-25T12:00:00.000Z" } }),
	);
	const panel = await openAlice();
	const section = within(panel).getByRole("region", { name: "Resource guard" });
	expect(within(section).getByTestId("detail-guard-cpu").textContent).toBe("Normal");
	expect(within(section).getByTestId("detail-guard-memory").textContent).toBe("Normal");
	// The panel names it for what it is: the input idle stop counts from (S1).
	expect(within(section).getByText("Last input (idle stop)")).toBeDefined();
	expect(within(section).getByTestId("detail-last-activity").textContent).not.toBe(
		"None recorded",
	);
	expect(within(section).queryByTestId("detail-lift-throttle")).toBeNull();
	expect(within(section).queryByTestId("detail-clear-memory-flag")).toBeNull();
});

test("Lift throttle and Clear memory flag call their routes and move focus to the heading", async () => {
	const writes = stubDetail(detail({ cpuThrottle: THROTTLE, memoryFlag: FLAG }));
	const panel = await openAlice();
	const section = within(panel).getByRole("region", { name: "Resource guard" });
	expect(within(section).getByTestId("detail-guard-cpu").textContent).toContain(
		"Throttled since",
	);

	fireEvent.click(
		within(section).getByRole("button", {
			name: "Lift throttle on Alice Example's workspace",
		}),
	);
	await waitFor(() =>
		expect(writes).toContainEqual({
			url: `/admin/workspaces/${WORKSPACE.id}/lift-throttle`,
			body: null,
		}),
	);
	expect(await screen.findByText("Throttle lifted")).toBeDefined();
	expect(document.activeElement?.id).toBe("detail-guard");

	fireEvent.click(
		within(section).getByRole("button", {
			name: "Clear memory flag on Alice Example's workspace",
		}),
	);
	await waitFor(() =>
		expect(writes).toContainEqual({
			url: `/admin/workspaces/${WORKSPACE.id}/clear-memory-flag`,
			body: null,
		}),
	);
});

test("the overrides dialog refuses a bad value, then sends numbers and nulls", async () => {
	const writes = stubDetail(detail({ guardConfig: { cpuThresholdPercent: 95 } }));
	const panel = await openAlice();
	fireEvent.click(
		within(panel).getByRole("button", {
			name: "Guard settings for Alice Example's workspace",
		}),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Resource guard for Alice Example's workspace",
	});
	const cpu = within(dialog).getByLabelText("CPU threshold (%)") as HTMLInputElement;
	expect(cpu.value).toBe("95");

	const idle = within(dialog).getByLabelText("Idle stop (minutes)");
	fireEvent.change(idle, { target: { value: "5" } });
	fireEvent.click(within(dialog).getByTestId("guard-save"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Enter 0 for never, or a whole number from 10 to 1440.",
	);
	expect(writes).toEqual([]);

	fireEvent.change(idle, { target: { value: "0" } });
	fireEvent.change(cpu, { target: { value: "" } });
	fireEvent.click(within(dialog).getByTestId("guard-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/workspaces/${WORKSPACE.id}/guard`,
		body: {
			cpuThresholdPercent: null,
			memoryThresholdPercent: null,
			windowMinutes: null,
			throttleSharePercent: null,
			idleStopMinutes: 0,
			keepRunningMaxHours: null,
		},
	});
	expect(await screen.findByText("Guard settings saved")).toBeDefined();
});

// --- Per-workspace limits and re-provision (SPEC.md section 20.1) ---

test("the limits line names each limit or the site value, and pending compares keys", () => {
	const site = { cpu: 2, memoryMiB: 4096, processes: 2000 };
	expect(limitsText(null, site)).toBe(
		"2 CPUs (site value) · 4 GiB memory (site value) · 2,000 processes (site value)",
	);
	expect(limitsText({ cpu: 1, memoryMiB: 6144 }, site)).toBe(
		"1 CPU · 6 GiB memory · 2,000 processes (site value)",
	);
	expect(limitsText(null, null)).toBe(
		"CPUs (site value) · Memory (site value) · Processes (site value)",
	);
	expect(limitsText(null, { cpu: 2, memoryMiB: null, processes: 2000 })).toBe(
		"2 CPUs (site value) · Memory (site value) · 2,000 processes (site value)",
	);
	expect(limitsPending(null, null)).toBe(false);
	expect(limitsPending({}, null)).toBe(false);
	expect(limitsPending({ cpu: 2 }, null)).toBe(true);
	expect(limitsPending({ cpu: 2, processes: 900 }, { processes: 900, cpu: 2 })).toBe(
		false,
	);
	expect(limitsPending(null, { cpu: 2 })).toBe(true);
});

test("the Limits dialog refuses a bad value, then sends numbers and nulls", async () => {
	const writes = stubDetail(detail({ limitsConfig: { cpu: 2 }, limitsApplied: null }));
	const panel = await openAlice();
	const section = within(panel).getByRole("region", { name: "Resources" });
	expect(
		await within(section).findByText(
			"2 CPUs · 4 GiB memory (site value) · 2,000 processes (site value)",
		),
	).toBeDefined();
	expect(within(section).getByTestId("detail-limits-pending").textContent).toBe(
		"Limits saved. They take effect within a minute.",
	);

	fireEvent.click(
		within(section).getByRole("button", {
			name: "Edit limits for Alice Example's workspace",
		}),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Limits for Alice Example's workspace",
	});
	// A blank field says what it falls back to, memory in MiB and GiB (S4, N6).
	const hint = (label: string) => {
		const input = within(dialog).getByLabelText(label);
		return document.getElementById(input.getAttribute("aria-describedby") ?? "")
			?.textContent;
	};
	expect(hint("Memory (MiB)")).toBe(
		"Site value: 4,096 MiB (4 GiB). Below what the workspace uses now, the kernel stops its largest process.",
	);
	expect(hint("CPUs")).toBe("Site value: 2. At most the host's CPU count.");
	const cpu = within(dialog).getByLabelText("CPUs") as HTMLInputElement;
	expect(cpu.value).toBe("2");
	const memory = within(dialog).getByLabelText("Memory (MiB)");
	fireEvent.change(memory, { target: { value: "100" } });
	fireEvent.click(within(dialog).getByTestId("limits-save"));
	expect((await within(dialog).findByRole("alert")).textContent).toBe(
		"Enter a whole number from 512 to 262144, or leave it blank.",
	);
	expect(writes).toEqual([]);

	fireEvent.change(memory, { target: { value: "2048" } });
	fireEvent.change(cpu, { target: { value: "" } });
	fireEvent.click(within(dialog).getByTestId("limits-save"));
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/workspaces/${WORKSPACE.id}/limits`,
		body: { cpu: null, memoryMiB: 2048, processes: null },
	});
	expect(await screen.findByText("Limits saved")).toBeDefined();
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("applied limits show no pending note", async () => {
	stubDetail(
		detail({ limitsConfig: { processes: 900 }, limitsApplied: { processes: 900 } }),
	);
	const panel = await openAlice();
	expect(within(panel).queryByTestId("detail-limits-pending")).toBeNull();
});

test("Re-provision shows only in error, calls its route and moves focus to the heading", async () => {
	const writes = stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "error",
				errorCode: "OPERATION_FAILED",
				errorMessage: "The workspace could not be created.",
			},
		}),
	);
	const panel = await openAlice();
	const error = within(panel).getByRole("region", { name: "Error" });
	fireEvent.click(
		within(error).getByRole("button", {
			name: "Re-provision Alice Example's workspace",
		}),
	);
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]).toEqual({
		url: `/admin/workspaces/${WORKSPACE.id}/reprovision`,
		body: null,
	});
	expect(await screen.findByText("Re-provision requested")).toBeDefined();
	await waitFor(() =>
		expect(document.activeElement).toBe(
			within(panel).getByRole("heading", { name: "Alice Example" }),
		),
	);
});

test("an error message on a workspace not in error has no Re-provision", async () => {
	stubDetail(
		detail({
			workspace: {
				...WORKSPACE,
				state: "provisioning",
				errorCode: "POOL_FULL",
				errorMessage: "The storage pool is full.",
			},
		}),
	);
	const panel = await openAlice();
	expect(within(panel).getByRole("region", { name: "Error" })).toBeDefined();
	expect(within(panel).queryByTestId("detail-reprovision")).toBeNull();
});

test("the panel's toggletips are named after what they explain and open on click", async () => {
	stubDetail(detail({ capabilities: { rebuild: true, resetDocker: true } }));
	const panel = await openAlice();
	const names = within(panel)
		.getAllByRole("button", { name: /^About / })
		.map((button) => button.getAttribute("aria-label"));
	expect(names).toEqual([
		"About Rebuild workspace",
		"About Reset Docker",
		"About Archive workspace",
		"About Storage",
		"About Limits",
		"About Disconnect grace",
		"About CPU throttle",
		"About High memory",
		"About Last input",
		"About Preview column",
		"About Promote",
		"About Make instructor",
		"About Disable account",
	]);
	fireEvent.click(within(panel).getByRole("button", { name: "About Last input" }));
	const tip = openToggletip();
	expect(tip.textContent).toBe(PANEL_HELP.lastInput);
});

test("Restore from backup opens the restore dialog preset to this workspace", async () => {
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users")
			return json(200, { users: [ALICE_ROW, ADMIN_ROW], dexUsers: false });
		if (url === "/admin/settings") return json(200, SETTINGS);
		if (url === "/admin/health") return json(200, HEALTH);
		if (url === "/admin/backups" && !init?.method) {
			return json(200, {
				host: null,
				hostReportedAt: null,
				hostStale: false,
				vm: null,
				vmListedAt: null,
				requests: [],
				workspaces: [],
			});
		}
		if (url === `/admin/workspaces/${WORKSPACE.id}`) return json(200, detail());
		throw new Error(`unexpected request: ${url}`);
	});
	const panel = await openAlice();
	const open = within(panel).getByRole("button", {
		name: "Restore from backup: Alice Example's workspace",
	});
	expect(open.textContent).toBe("Restore from backup…");
	fireEvent.click(open);
	const dialog = await screen.findByRole("dialog", { name: "Restore from backup" });
	expect(
		await within(dialog).findByText("Backups are not connected on this site."),
	).toBeDefined();
});
