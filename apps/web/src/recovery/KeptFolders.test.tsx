import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { pointTime } from "./labels.js";
import { RecoveryDialog } from "./RecoveryDialog.js";

/**
 * Kept folders in the Recovery points dialog (SPEC.md §15.10): each folder a
 * restore left is listed with what it holds, and deleting one is confirmed
 * by a dialog that says so.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

const PROJECT = project();
const POINTS = { points: [], usage: { usedBytes: 0, quotaBytes: 3 * 1024 ** 3 } };
const FOLDER = {
	pointId: "66666666-6666-4666-8666-666666666666",
	modifiedAt: "2026-10-01T09:00:00.000Z",
	fileCount: 12,
	sizeBytes: 4096,
	complete: true,
	pointCreatedAt: "2026-09-30T08:30:00.000Z",
};
const asidesUrl = `/workspaces/${WORKSPACE.id}/projects/${PROJECT.id}/recovery-asides`;

function render(
	folders: unknown[],
	onDelete: () => Response = () => new Response(null, { status: 204 }),
) {
	let current = folders;
	const fetchMock = stubFetch((url, init) => {
		if (String(url) === asidesUrl) return json(200, { folders: current });
		if (init?.method === "DELETE") {
			const answer = onDelete();
			if (answer.ok) current = [];
			return answer;
		}
		return json(200, POINTS);
	});
	renderWithQuery(
		<RecoveryDialog workspaceId={WORKSPACE.id} project={PROJECT} onClose={vi.fn()} />,
	);
	return fetchMock;
}

const deletes = (fetchMock: ReturnType<typeof stubFetch>) =>
	fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");

test("a kept folder is listed with its path, its restore and what it holds", async () => {
	render([
		FOLDER,
		{
			...FOLDER,
			pointId: "77777777-7777-4777-8777-777777777777",
			complete: false,
			pointCreatedAt: null,
		},
	]);

	const row = await screen.findByTestId(`recovery-kept-${FOLDER.pointId}`);
	expect(row.textContent).toContain(`~/projects/.portikus-aside-${FOLDER.pointId}`);
	expect(row.textContent).toContain(
		`From a restore to ${pointTime(FOLDER.pointCreatedAt)}: 12 files, 4.0 KB`,
	);
	const other = screen.getByTestId(
		"recovery-kept-77777777-7777-4777-8777-777777777777",
	);
	expect(other.textContent).toContain("From an earlier restore: at least 12 files");
	expect(screen.getByRole("heading", { name: "Kept folders" })).toBeDefined();
});

test("no kept folders, or a workspace that cannot list them, shows no section", async () => {
	render([]);
	await screen.findByTestId("recovery-empty");
	expect(screen.queryByRole("heading", { name: "Kept folders" })).toBeNull();
});

test("delete asks first, saying what the folder holds, then deletes and announces", async () => {
	const fetchMock = render([FOLDER]);

	fireEvent.click(
		await screen.findByRole("button", {
			name: `Delete kept folder from a restore to ${pointTime(FOLDER.pointCreatedAt)}`,
		}),
	);
	const confirm = screen.getByTestId("dialog-delete-kept-folder");
	expect(confirm.textContent).toContain(`~/projects/.portikus-aside-${FOLDER.pointId}`);
	expect(confirm.textContent).toContain(`the files ${PROJECT.name} had before`);
	expect(confirm.textContent).toContain("12 files, 4.0 KB");
	expect(confirm.textContent).toContain("the files in this folder, for good");
	expect(deletes(fetchMock)).toHaveLength(0);

	fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));

	await waitFor(() =>
		expect(screen.getByTestId("recovery-status").textContent).toBe(
			"Kept folder deleted.",
		),
	);
	expect(screen.queryByTestId("dialog-delete-kept-folder")).toBeNull();
	expect(String(deletes(fetchMock)[0]?.[0])).toBe(`${asidesUrl}/${FOLDER.pointId}`);
	await waitFor(() =>
		expect(screen.queryByTestId(`recovery-kept-${FOLDER.pointId}`)).toBeNull(),
	);
});

test("cancel deletes nothing", async () => {
	const fetchMock = render([FOLDER]);
	fireEvent.click(await screen.findByTestId(`recovery-kept-delete-${FOLDER.pointId}`));
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(screen.queryByTestId("dialog-delete-kept-folder")).toBeNull(),
	);
	expect(deletes(fetchMock)).toHaveLength(0);
	expect(screen.getByTestId(`recovery-kept-${FOLDER.pointId}`)).toBeDefined();
});

test("a failed delete is an alert inside the confirmation", async () => {
	render([FOLDER], () =>
		json(404, {
			code: "NOT_FOUND",
			message: "That kept folder is not there any more.",
		}),
	);
	fireEvent.click(await screen.findByTestId(`recovery-kept-delete-${FOLDER.pointId}`));
	fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
	await waitFor(() =>
		expect(screen.getByTestId("delete-kept-error").textContent).toBe(
			"That kept folder is not there any more.",
		),
	);
	expect(screen.getByTestId("dialog-delete-kept-folder")).toBeDefined();
});
