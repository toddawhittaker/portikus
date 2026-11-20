import { expect, type Page } from "@playwright/test";
import { launchChat } from "./chat-helpers";
import { join, newCourse } from "./course-profile-helpers";
import {
	createProject,
	createStudent,
	expectConnected,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { appFrameLocator, previewGateway } from "./preview-gateway";
import { startPickApp } from "./preview-pick-app";
import {
	PICK_BUTTON,
	type PickFolder,
	pickFolders,
	pickText,
	sendFetchMetadata,
	settle,
	typedInto,
	wrapperLocator,
} from "./preview-pick-helpers";

/**
 * A student with agents and an application's preview open, and the moves a
 * pick test makes in it (SPEC.md §14.6).
 */

export interface Scene {
	workspaceId: string;
	projectId: string;
	slug: string;
	port: number;
	terminalId?: string;
	chatId?: string;
}

export interface SceneOptions {
	/** A Claude Code terminal. */
	terminal?: boolean;
	/** A Claude Code chat, launched after the terminal. */
	chat?: boolean;
	/** The student's course profile, when they are in a course. */
	profile?: "traditional";
}

/** A student with the agents asked for and the application's preview open. */
export async function openScene(
	page: Page,
	context: Parameters<typeof previewGateway>[0] & Parameters<typeof createStudent>[0],
	options: SceneOptions = { terminal: true },
): Promise<Scene> {
	const student = await createStudent(context);
	await previewGateway(context);
	await sendFetchMetadata(context);
	if (options.profile) {
		await join((await newCourse(options.profile)).id, student.userId, "student");
	}
	const app = await startPickApp(student.workspaceId);
	const project = await createProject(student.workspaceId, { name: "Pick" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const scene: Scene = {
		workspaceId: student.workspaceId,
		projectId: project.id,
		slug: project.slug,
		port: app.port,
	};

	if (options.terminal) {
		const before = await terminalIds(student.workspaceId, project.id);
		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-claude").click();
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(before.length + 1);
		const id = (await terminalIds(student.workspaceId, project.id)).find(
			(one) => !before.includes(one),
		);
		if (!id) throw new Error("the terminal row was not created");
		await expectConnected(page, id);
		scene.terminalId = id;
	}
	if (options.chat) {
		scene.chatId = (await launchChat(page, student.workspaceId, project.id)).id;
	}

	await openPreview(page, scene);
	return scene;
}

export async function openPreview(page: Page, scene: Scene): Promise<void> {
	await page.getByTestId("right-pane-tab-running").click();
	await page.getByTestId(`running-open-${scene.port}`).click({ timeout: 20_000 });
	await expect(page.getByTestId("preview-frame")).toBeVisible({ timeout: 20_000 });
	await expect(appFrameLocator(page).locator("#title")).toHaveText("Pick test app", {
		timeout: 20_000,
	});
}

export function pickButton(page: Page) {
	return page.getByRole("button", { name: PICK_BUTTON });
}

export function layer(page: Page) {
	return wrapperLocator(page).getByRole("application", { name: /^Pick mode/ });
}

/** Press the pick button, choosing from the menu when a name is given. */
export async function startPicking(page: Page, agent?: string): Promise<void> {
	await pickButton(page).click();
	if (agent) {
		await page.getByRole("menu").getByRole("menuitem", { name: agent }).click();
	}
	await expect(pickButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect(layer(page)).toBeVisible();
}

/** The preview tab again, after a pick moved the view to an agent. */
export async function backToPreview(page: Page): Promise<void> {
	await page.getByRole("tab", { name: /^Preview/ }).click();
	await expect(page.getByTestId("preview-frame")).toBeVisible();
}

/** The middle of an element of the application, in the page's own coordinates. */
export async function centreOf(
	page: Page,
	selector: string,
): Promise<{ x: number; y: number }> {
	const box = await appFrameLocator(page).locator(selector).boundingBox();
	if (!box) throw new Error(`${selector} is not on screen`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function clickOn(page: Page, selector: string): Promise<void> {
	const at = await centreOf(page, selector);
	await page.mouse.move(at.x, at.y);
	await page.mouse.click(at.x, at.y);
}

/** The folders' file names, to tell when they have stopped changing. */
const listing = (found: PickFolder[]) =>
	JSON.stringify(found.map((folder) => Object.keys(folder.files).sort()));

/**
 * Wait for exactly `count` drop folders whose files have all been written,
 * and return them. A folder appears before its files do, one at a time, so
 * the listing must hold its Markdown and read the same twice running.
 */
export async function folders(scene: Scene, count: number): Promise<PickFolder[]> {
	let last = "";
	let found: PickFolder[] = [];
	await expect
		.poll(
			async () => {
				found = await pickFolders(scene.workspaceId, scene.slug);
				const now = listing(found);
				const settled =
					found.length === count &&
					found.every((folder) => "picked-element.md" in folder.files) &&
					now === last;
				last = now;
				return settled;
			},
			{ timeout: 20_000, intervals: [250] },
		)
		.toBe(true);
	return found;
}

/** No drop folder, and nothing typed, after everything posted has been handled. */
export async function expectNothingSent(page: Page, scene: Scene): Promise<void> {
	await settle(page);
	expect(await pickFolders(scene.workspaceId, scene.slug)).toEqual([]);
	if (scene.terminalId) expect(await typedInto(scene.terminalId)).toBe("");
}

/** The application's selector line from a pick's Markdown. */
export function selectorOf(folder: PickFolder): string {
	return /^selector: (.*)$/m.exec(pickText(folder))?.[1] ?? "";
}
