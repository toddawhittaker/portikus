import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedStorage,
	setWorkspaceState,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * The starting screen and the move to the work area (SPEC.md §6.3, §6.7).
 * The worker does not run here, so the test moves the workspace row itself
 * and the presence socket pushes the change to the page.
 */
test("the starting screen gives way to the terminal tabs", async ({
	page,
	context,
}) => {
	const student = await createStudent(context, { state: "starting" });
	const project = await createProject(student.workspaceId, { name: "Starting" });

	await page.goto(workspacePath(student.workspaceId, project.id));

	await expect(page.getByTestId("workspace-state")).toHaveText("Starting");
	await expect(
		page.getByRole("heading", { name: "Starting your workspace" }),
	).toBeVisible();
	await expect(workTabs(page)).toHaveCount(0);

	await setWorkspaceState(student.workspaceId, "running");

	// No reload: the workspace WebSocket reports the new state.
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText("No terminals open")).toBeVisible();
	await expect(page.getByTestId("launcher")).toBeVisible();
});

/** A workspace the worker could not start, as its error row reads (SPEC.md §28). */
async function failWorkspace(
	workspaceId: string,
	code = "STORAGE_FULL",
	message = "Your workspace could not start because its storage is full.",
): Promise<void> {
	await query(
		`update workspaces
		    set state = 'error', error_code = $2, error_message = $3, updated_at = now()
		  where id = $1`,
		[workspaceId, code, message],
	);
}

test("an error a second start can get past offers Try again and Workspace details, with the detail folded away", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await failWorkspace(student.workspaceId, "TIMEOUT", "The operation timed out.");
	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	// The raw error is there, but collapsed under "Technical details".
	const details = page.getByTestId("workspace-error-details");
	await expect(details.getByText("Technical details")).toBeVisible();
	await expect(details.getByText("TIMEOUT")).toBeHidden();
	await details.getByText("Technical details").click();
	await expect(details.getByText("TIMEOUT")).toBeVisible();

	await page.getByRole("button", { name: "Workspace details" }).click();
	await expect(page.getByTestId("dialog-workspace-status")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dialog-workspace-status")).toHaveCount(0);

	const start = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/workspaces/${student.workspaceId}/start`) &&
			response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "Try again" }).click();
	expect((await start).ok()).toBe(true);
});

test("a STORAGE_FULL error with Docker full says so with figures and leads with Reset Docker", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await failWorkspace(student.workspaceId);
	// The agent still answers in the error state, so the API serves its figures.
	const GIB = 1024 ** 3;
	await seedStorage(student.workspaceId, {
		home: { usedBytes: 3 * GIB, totalBytes: 10 * GIB },
		docker: { usedBytes: 99 * GIB, totalBytes: 100 * GIB },
	});
	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	await expect(progress.getByTestId("storage-meter-docker")).toHaveClass(
		/pk-meter--full/,
	);
	await expect(progress.getByTestId("progress-sub")).toHaveText(
		"Its storage is full. Docker is using 99.0 GB of 100 GB. Reset Docker to free that space; your projects and home folder are kept.",
	);
	// Try again stays, after Reset Docker: an administrator may have grown the quota.
	await expect(progress.locator(".pk-actions").getByRole("button")).toHaveText([
		"Reset Docker…",
		"Try again",
		"Workspace details",
	]);
	await progress.getByRole("button", { name: "Reset Docker…", exact: true }).click();
	await expect(page.getByTestId("dialog-reset-docker")).toBeVisible();
});

test("a STORAGE_FULL error with no agent offers Try again and Workspace details", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await failWorkspace(student.workspaceId);
	await seedStorage(student.workspaceId, {
		docker: { usedBytes: 99, totalBytes: 100 },
	});
	// No agent to ask, so there are no figures to show.
	await query(
		"update workspaces set agent_address = null, agent_token = null where id = $1",
		[student.workspaceId],
	);
	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	await expect(progress.getByTestId("storage-meters")).toHaveCount(0);
	await expect(progress.getByTestId("progress-sub")).toHaveText(
		"Its storage is full. Ask your administrator for more space. Your files are kept.",
	);
	await expect(progress.getByRole("button")).toHaveText([
		"Try again",
		"Workspace details",
	]);
	// The dialog still has Start workspace for when space has been freed.
	await progress.getByRole("button", { name: "Workspace details" }).click();
	await expect(
		page.getByTestId("dialog-workspace-status").getByTestId("workspace-start"),
	).toBeVisible();
});

test("a missing image offers no Try again, only Workspace details", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await failWorkspace(student.workspaceId, "IMAGE_NOT_FOUND", "The image is missing.");
	await page.goto(workspacePath(student.workspaceId));

	const progress = page.getByTestId("workspace-progress");
	await expect(progress).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	await expect(progress.locator(".pk-actions").getByRole("button")).toHaveText([
		"Workspace details",
	]);
});

for (const state of ["stopped", "error"] as const) {
	test(`a ${state} workspace shows no loading skeletons`, async ({ page, context }) => {
		const student = await createStudent(context);
		// Opening the page asks the workspace to run, so the change comes after.
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
			timeout: 15_000,
		});
		if (state === "error") await failWorkspace(student.workspaceId);
		else
			await query(
				"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
				[student.workspaceId],
			);

		await expect(page.getByTestId("workspace-progress")).toHaveAttribute(
			"data-phase",
			state,
			{ timeout: 15_000 },
		);
		await expect(
			page.getByText("Start your workspace to see your projects"),
		).toBeVisible();
		await expect(page.getByText("Start your workspace to see its files")).toBeVisible();
		await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
	});
}
