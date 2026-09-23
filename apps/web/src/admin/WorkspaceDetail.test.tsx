import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";
import { quotaError, quotaFaults } from "./QuotaDialog.js";
import { capabilityNote, NOT_AVAILABLE_TEXT, quotaPending } from "./WorkspaceDetail.js";

afterEach(() => vi.unstubAllGlobals());

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
	role: "administrator" as const,
};

const NONE = { disabled: false, archived: false, duplicateEmail: false, stale: false };
const IMAGE = { label: "2026.09.9", fingerprint: "abc", current: true };

const ALICE_ROW = {
	id: USER.id,
	displayName: USER.displayName,
	email: USER.email,
	role: "student" as const,
	disabledAt: null,
	shutdownGraceSeconds: null,
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
	},
};

const ADMIN_ROW = {
	id: ADMIN.id,
	displayName: ADMIN.displayName,
	email: ADMIN.email,
	role: "administrator" as const,
	disabledAt: null,
	shutdownGraceSeconds: null,
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
		if (url === "/admin/users") return json(200, { users });
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
	expect(quotaError(from, "20", "20")).toBe("Storage can only be increased.");
	expect(quotaError(from, "big", "20")).toBe("Enter whole numbers of GiB.");
	expect(quotaError(from, "2000", "20")).toBe("Each size can be at most 1024 GiB.");
	expect(quotaError(from, "25", "20")).toBe("Change at least one size.");
	expect(quotaError(from, "30", "20")).toBeNull();
});

test("a quota error points at the field at fault (Gate E)", () => {
	const from = { homeGiB: 25, dockerGiB: 20 };
	expect(quotaFaults(from, "20", "20")).toEqual({ home: true, docker: false });
	expect(quotaFaults(from, "25", "big")).toEqual({ home: false, docker: true });
	expect(quotaFaults(from, "2000", "2000")).toEqual({ home: true, docker: true });
	// "Change at least one size" has no single culprit, so it points at Home.
	expect(quotaFaults(from, "25", "20")).toEqual({ home: true, docker: false });
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
		"Configured: Home 10 GiB · Docker 10 GiB",
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
	expect(error.firstElementChild?.textContent).toBe(
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
			name: "Change storage for Alice Example's workspace",
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
	const start = within(panel).getByRole("button", {
		name: "Start Alice Example's workspace",
	});
	expect(start.getAttribute("aria-disabled")).toBe("true");
	fireEvent.click(stop);
	fireEvent.click(start);
	expect(writes.length).toBe(1);
});

test("Unarchive keeps focus while its request runs (Gate E)", async () => {
	stubDetail(
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
