import type { AdminUser, AdminWorkspaceDetail } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";
import { quotaError } from "./QuotaDialog.js";
import {
	capabilityNote,
	effectiveGuardText,
	instructorChangeNote,
	memoryFlagText,
	NOT_AVAILABLE_TEXT,
	quotaPending,
	roleChangeNote,
	throttleText,
} from "./WorkspaceDetail.js";

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
		...overrides,
	};
}

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
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
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

	expect(within(panel).getByTestId("detail-usage").textContent).toBe(
		"Home disk 2.0 GB of 10.0 GB · CPU 12.5% · Memory 1.0 GB of 4.0 GB",
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
	// Styled as a link, not body text (Gate E).
	expect(allEvents.className).toContain("underline");
	expect(allEvents.className).toContain("text-[var(--accent-text)]");
	// The selected row is marked as the current one.
	expect(
		screen.getByTestId(`account-row-${USER.id}`).getAttribute("aria-current"),
	).toBe("true");
});

test("the panel's sections come in the order of EPIC-18 ruling 17", async () => {
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
		"H4 Account",
		"H4 Workspace",
		"H4 Storage",
		"H4 Resource guard",
		"H4 Ports and connections",
		"H4 Logs",
		"H4 Recent audit events",
	]);
});

test("Start, Stop and Restart sit in the head, directly under the state badge", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const head = within(panel).getByTestId("detail-state").closest(".pk-detail-head");
	expect(head).not.toBeNull();
	for (const action of ["Start", "Stop", "Restart"]) {
		expect(
			within(head as HTMLElement).getByRole("button", {
				name: `${action} Alice Example's workspace`,
			}),
		).toBeDefined();
	}
});

test("Edit quotas sits in the Storage heading row", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const storage = within(panel).getByRole("region", { name: "Storage" });
	const heading = within(storage).getByRole("heading", { name: "Storage" });
	const edit = within(storage).getByRole("button", {
		name: "Edit quotas for Alice Example's workspace",
	});
	expect(edit.textContent).toBe("Edit quotas…");
	expect(edit.parentElement).toBe(heading.parentElement);
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
	expect(within(panel).getByTestId("detail-usage").textContent).toBe("Stopped");
});

test("an agent that does not answer says so", async () => {
	stubDetail(detail({ agent: "not_answering", usage: null }));
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-usage").textContent).toBe(
		"Agent not answering",
	);
});

test("an unapplied storage change shows as pending", async () => {
	stubDetail(detail({ quotaApplied: { homeGiB: 5, dockerGiB: 10 } }));
	const panel = await openAlice();
	expect(within(panel).getByTestId("detail-quota-pending")).toBeDefined();
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
	const start = within(panel).getByRole("button", {
		name: "Start Alice Example's workspace",
	});
	expect(start.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(stop);
	fireEvent.click(start);
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

test("the grace field is named by its visible label (WCAG 2.5.3)", async () => {
	stubDetail(detail());
	const panel = await openAlice();
	const field = within(panel).getByRole("textbox", {
		name: "Grace period override (seconds)",
	});
	expect(field.hasAttribute("aria-label")).toBe(false);
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
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
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
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
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
		"It averaged 97% over 30 minutes, above 80%, and now gets 25% of its CPU (100ms/100ms).",
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

test("a normal workspace shows its limits and last activity, with no lift or clear", async () => {
	stubDetail(
		detail({ workspace: { ...WORKSPACE, lastActivityAt: "2026-09-25T12:00:00.000Z" } }),
	);
	const panel = await openAlice();
	const section = within(panel).getByRole("region", { name: "Resource guard" });
	expect(within(section).getByTestId("detail-guard-cpu").textContent).toBe("Normal");
	expect(within(section).getByTestId("detail-guard-memory").textContent).toBe("Normal");
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
			name: "Change overrides for Alice Example's workspace",
		}),
	);
	const dialog = await screen.findByRole("dialog", {
		name: "Resource guard overrides",
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
		},
	});
	expect(await screen.findByText("Overrides saved")).toBeDefined();
});
