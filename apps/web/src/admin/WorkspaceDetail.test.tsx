import type { AdminWorkspaceDetail } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "../test-utils.js";
import { quotaError } from "./QuotaDialog.js";
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

/** Answers the admin reads with one detail; every POST and PUT lands in `writes`. */
function stubDetail(body: AdminWorkspaceDetail) {
	const writes: { url: string; body: unknown }[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN);
		if (url === "/admin/users") return json(200, { users: [ALICE_ROW, ADMIN_ROW] });
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		if (init?.method === "POST" || init?.method === "PUT") {
			writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
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
		await screen.findByRole("button", { name: "Show details for Alice Example" }),
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
	expect(within(panel).getByTestId("detail-all-events").getAttribute("href")).toBe(
		`/admin?tab=audit&workspace=${WORKSPACE.id}`,
	);
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
		name: "Rebuild Alice Example's workspace",
	}) as HTMLButtonElement;
	const reset = within(panel).getByRole("button", {
		name: "Reset Docker in Alice Example's workspace",
	}) as HTMLButtonElement;
	expect(rebuild.disabled).toBe(true);
	expect(reset.disabled).toBe(true);
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
		name: "Rebuild Alice Example's workspace",
	}) as HTMLButtonElement;
	const reset = within(panel).getByRole("button", {
		name: "Reset Docker in Alice Example's workspace",
	}) as HTMLButtonElement;
	expect(rebuild.disabled).toBe(true);
	expect(reset.disabled).toBe(true);
	expect(within(panel).getByTestId("pending-operation").textContent).toMatch(
		/^Rebuilding…/,
	);
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
		within(panel).getByRole("button", { name: "Rebuild Alice Example's workspace" }),
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
			name: "Reset Docker in Alice Example's workspace",
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
		name: "Archive Alice Example's workspace",
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
			screen.getByRole("button", { name: "Show details for Alice Example" }),
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
		within(panel).getByRole("button", { name: "Archive Alice Example's workspace" }),
	);
	fireEvent.click(
		within(await screen.findByTestId("archive-dialog")).getByTestId("dialog-confirm"),
	);
	await waitFor(() => expect(writes.length).toBe(1));
	expect(writes[0]?.url).toBe(`/admin/workspaces/${WORKSPACE.id}/archive`);

	fireEvent.click(
		within(panel).getByRole("button", { name: "Disable Alice Example's account" }),
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
		await screen.findByRole("button", { name: "Show details for Carol Admin" }),
	);
	const panel = await screen.findByRole("region", { name: "Carol Admin" });

	const button = within(panel).getByRole("button", {
		name: "Disable Carol Admin's account",
	}) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	expect(within(panel).getByText("You cannot disable your own account.")).toBeDefined();
	expect(within(panel).getByText("This account has no workspace.")).toBeDefined();
});
