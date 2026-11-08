import {
	type BrowserContext,
	expect,
	type Page,
	type WebSocketRoute,
} from "@playwright/test";
import {
	createProject,
	createStudent,
	newTerminal,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * A chat tab in a new student's workspace. The launcher entry is the
 * composer's, so a terminal is opened and its row made a chat; the fake
 * agent already knows the terminal, and the API reads the kind from the row.
 */
export async function makeChatTab(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Dashboard" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	if (!id) throw new Error("the terminal row was not created");
	return { student, project, id };
}

/** Start one more chat from the New tab menu in the project open on the page. */
export async function launchChat(page: Page, workspaceId: string, projectId: string) {
	const before = await terminalIds(workspaceId, projectId);
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude-gui").click();
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(before.length + 1);
	const id = (await terminalIds(workspaceId, projectId)).find(
		(one) => !before.includes(one),
	);
	if (!id) throw new Error("the chat row was not created");
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("chat-composer-input")).toBeVisible();
	return { id, view };
}

/** Open a new project in the student's workspace and start a chat from the New tab menu. */
export async function openChat(page: Page, workspaceId: string, name: string) {
	const project = await createProject(workspaceId, { name });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	return { project, ...(await launchChat(page, workspaceId, project.id)) };
}

/**
 * Stand in for the host on a routed chat socket: the returned `send` frames
 * an event for the session, numbering `seq` up from `first`.
 */
export function scriptedChat(ws: WebSocketRoute, sessionId: string, first = 0) {
	let seq = first;
	return (type: string, body: Record<string, unknown> = {}) =>
		ws.send(JSON.stringify({ type, sessionId, seq: seq++, ...body }));
}

/** The frames the fake chat has received from the browser, parsed; only `type` if given. */
export async function receivedFrames(
	id: string,
	type?: string,
): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/received`);
	const body = (await response.json()) as { received: string[] };
	const frames = body.received.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>,
	);
	return type === undefined ? frames : frames.filter((frame) => frame.type === type);
}

/** A frame the scripted host sends: its type and body. */
export type Frame = [string, object];

/**
 * The chat socket answered by a script standing in for the host: a snapshot
 * with `snapshot` merged in, the settings, then `first`, and whatever
 * `reply` sends for each message from the browser.
 */
export async function scriptChat(
	page: Page,
	id: string,
	{
		snapshot = {},
		first = [],
		reply,
	}: {
		snapshot?: object;
		first?: Frame[];
		reply?: (
			message: { type: string; rule?: string },
			send: (frame: Frame) => void,
		) => void;
	},
) {
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const post = scriptedChat(ws, id);
		const send = ([type, body]: Frame) => post(type, { ...body });
		send([
			"snapshot",
			{ cards: [], turnRunning: false, truncated: false, ...snapshot },
		]);
		send([
			"settings",
			{ agent: "claude", model: "default", effort: "high", mode: "default" },
		]);
		for (const frame of first) send(frame);
		ws.onMessage((raw) => reply?.(JSON.parse(String(raw)), send));
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	return view;
}
