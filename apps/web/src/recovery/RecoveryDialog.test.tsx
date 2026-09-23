import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { REASON_LABEL, RecoveryDialog } from "./RecoveryDialog.js";
import { pointTime } from "./RestoreConfirm.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

const PROJECT = project();
const POINT = {
	id: "55555555-5555-4555-8555-555555555555",
	projectId: PROJECT.id,
	createdAt: "2026-09-20T10:15:00.000Z",
	reason: "agent-session" as const,
	sizeBytes: 2048,
	expiresAt: "2026-10-04T10:15:00.000Z",
};
const LIST = {
	points: [POINT],
	usage: { usedBytes: 1024 ** 2, quotaBytes: 3 * 1024 ** 3 },
};
const base = `/workspaces/${WORKSPACE.id}/projects/${PROJECT.id}/recovery-points`;

function render(handler: (url: string, init?: RequestInit) => Response) {
	const fetchMock = stubFetch(handler);
	const onClose = vi.fn();
	renderWithQuery(
		<RecoveryDialog workspaceId={WORKSPACE.id} project={PROJECT} onClose={onClose} />,
	);
	return { fetchMock, onClose };
}

const posts = (fetchMock: ReturnType<typeof stubFetch>, suffix: string) =>
	fetchMock.mock.calls.filter(
		([url, init]) => init?.method === "POST" && String(url) === `${base}${suffix}`,
	);

test("lists each point with its reason and size, and the allowance in use", async () => {
	render(() => json(200, LIST));

	const row = await screen.findByTestId(`recovery-row-${POINT.id}`);
	expect(row.textContent).toContain("Before Claude Code or Codex session");
	expect(row.textContent).toContain("2.0 KB");
	expect(row.textContent).toContain(pointTime(POINT.createdAt));
	expect(screen.getByTestId("recovery-usage").textContent).toBe(
		"1.0 MB of 3.0 GB recovery storage used",
	);
	// The row action is named for its row.
	expect(
		screen.getByRole("button", {
			name: `Restore to ${pointTime(POINT.createdAt)}, ${REASON_LABEL[POINT.reason]}`,
		}),
	).toBeDefined();
});

test("an empty list says so", async () => {
	render(() => json(200, { ...LIST, points: [] }));

	expect((await screen.findByTestId("recovery-empty")).textContent).toBe(
		"No recovery points yet.",
	);
});

test("Create recovery point now posts and announces the result", async () => {
	const { fetchMock } = render((_url, init) =>
		init?.method === "POST" ? json(201, POINT) : json(200, LIST),
	);

	fireEvent.click(await screen.findByTestId("recovery-create"));

	await waitFor(() =>
		expect(screen.getByTestId("recovery-status").textContent).toBe(
			"Recovery point created.",
		),
	);
	expect(posts(fetchMock, "")).toHaveLength(1);
});

test("Create keeps focus and ignores repeats while it runs (Gate E)", async () => {
	const { fetchMock } = render((_url, init) =>
		init?.method === "POST"
			? (new Promise<Response>(() => undefined) as unknown as Response)
			: json(200, LIST),
	);

	const create = await screen.findByTestId("recovery-create");
	create.focus();
	fireEvent.click(create);
	await waitFor(() => expect(create.getAttribute("aria-busy")).toBe("true"));
	expect(create.hasAttribute("disabled")).toBe(false);
	expect(document.activeElement).toBe(create);
	fireEvent.click(create);
	expect(posts(fetchMock, "")).toHaveLength(1);
});

test("a failed create is shown as an alert", async () => {
	render((_url, init) =>
		init?.method === "POST"
			? json(409, {
					code: "WORKSPACE_NOT_RUNNING",
					message: "Start the workspace first.",
				})
			: json(200, LIST),
	);

	fireEvent.click(await screen.findByTestId("recovery-create"));

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Start the workspace first.");
});

test("restore confirms with the project and time, then posts", async () => {
	const { fetchMock, onClose } = render((_url, init) =>
		init?.method === "POST" ? json(200, { ok: true }) : json(200, LIST),
	);

	fireEvent.click(await screen.findByTestId(`recovery-restore-${POINT.id}`));
	const dialog = screen.getByTestId("dialog-restore-point");
	expect(dialog.textContent).toContain(PROJECT.name);
	expect(dialog.textContent).toContain(pointTime(POINT.createdAt));
	expect(dialog.textContent).toContain(
		"A recovery point of the current state is made first",
	);
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));

	await waitFor(() => expect(onClose).toHaveBeenCalled());
	const [, init] = posts(fetchMock, `/${POINT.id}/restore`)[0] ?? [];
	expect(JSON.parse(String(init?.body))).toEqual({});
});

test("storage full offers a restore without the safety point", async () => {
	const { fetchMock, onClose } = render((_url, init) => {
		if (init?.method !== "POST") return json(200, LIST);
		return JSON.parse(String(init.body)).skipSafetyPoint
			? json(200, { ok: true })
			: json(507, { code: "STORAGE_FULL", message: "Recovery storage is full." });
	});

	fireEvent.click(await screen.findByTestId(`recovery-restore-${POINT.id}`));
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));
	await screen.findByTestId("dialog-restore-without-safety");
	fireEvent.click(
		screen.getByRole("button", { name: "Restore without saving the current state" }),
	);

	await waitFor(() => expect(onClose).toHaveBeenCalled());
	const bodies = posts(fetchMock, `/${POINT.id}/restore`).map(([, init]) =>
		JSON.parse(String(init?.body)),
	);
	expect(bodies).toEqual([{}, { skipSafetyPoint: true }]);
});

test("any other restore failure is an alert and sends no second request", async () => {
	const { fetchMock } = render((_url, init) =>
		init?.method === "POST"
			? json(500, { code: "INTERNAL", message: "The safety point failed." })
			: json(200, LIST),
	);

	fireEvent.click(await screen.findByTestId(`recovery-restore-${POINT.id}`));
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));

	expect((await screen.findByRole("alert")).textContent).toContain(
		"The safety point failed.",
	);
	expect(screen.queryByTestId("dialog-restore-without-safety")).toBeNull();
	expect(posts(fetchMock, `/${POINT.id}/restore`)).toHaveLength(1);
});

test("a failed restore without the safety point shows the server's message", async () => {
	const partial =
		"The project may be partly restored. Your earlier files are kept in a folder named .portikus-aside-x in the projects folder; do not delete it.";
	render((_url, init) => {
		if (init?.method !== "POST") return json(200, LIST);
		return JSON.parse(String(init.body)).skipSafetyPoint
			? json(500, { code: "INTERNAL", message: partial })
			: json(507, { code: "STORAGE_FULL", message: "Recovery storage is full." });
	});

	fireEvent.click(await screen.findByTestId(`recovery-restore-${POINT.id}`));
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));
	await screen.findByTestId("dialog-restore-without-safety");
	fireEvent.click(
		screen.getByRole("button", { name: "Restore without saving the current state" }),
	);

	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(partial));
});

test("a leftover rollback copy is explained, not offered a skip", async () => {
	const message =
		"A previous restore's rollback copy is still in the projects folder. Deal with it before restoring again.";
	render((_url, init) =>
		init?.method === "POST" ? json(409, { code: "BUSY", message }) : json(200, LIST),
	);

	fireEvent.click(await screen.findByTestId(`recovery-restore-${POINT.id}`));
	fireEvent.click(screen.getByRole("button", { name: "Restore" }));

	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
	expect(screen.queryByTestId("dialog-restore-without-safety")).toBeNull();
});
