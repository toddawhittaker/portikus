import {
	type BrowserContext,
	expect,
	type Locator,
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

/** The coding agents a chat tab can run. */
export type ChatAgent = "claude" | "codex";

/** The row name a chat of each agent starts with. */
const CHAT_NAME: Record<ChatAgent, string> = {
	claude: "Claude Code",
	codex: "Codex",
};

/**
 * A chat tab in a new student's workspace. The launcher entry is the
 * composer's, so a terminal is opened and its row made a chat; the fake
 * agent already knows the terminal, and the API reads the kind from the row.
 */
export async function makeChatTab(
	page: Page,
	context: BrowserContext,
	agent: ChatAgent = "claude",
) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Dashboard" });
	const id = await chatTabIn(page, student.workspaceId, project.id, agent);
	return { student, project, id };
}

/** A chat tab's row in an existing project: open it, start a terminal, and make its row a chat. */
export async function chatTabIn(
	page: Page,
	workspaceId: string,
	projectId: string,
	agent: ChatAgent = "claude",
): Promise<string> {
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(workspaceId, projectId)).length)
		.toBe(1);
	const [id] = await terminalIds(workspaceId, projectId);
	if (!id) throw new Error("the terminal row was not created");
	await query(
		"update terminals set kind = 'chat', agent = $2, name = $3 where id = $1",
		[id, agent, CHAT_NAME[agent]],
	);
	return id;
}

/** Start one more chat from the New tab menu in the project open on the page. */
export async function launchChat(
	page: Page,
	workspaceId: string,
	projectId: string,
	agent: ChatAgent = "claude",
) {
	const before = await terminalIds(workspaceId, projectId);
	await page.getByTestId("launcher").click();
	await page.getByTestId(`launcher-${agent}-gui`).click();
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
	// The box takes typing before the socket opens; a send then is refused as
	// not connected. The Model picker is drawn from the host's settings frame.
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	return { id, view };
}

/** Open a new project in the student's workspace and start a chat from the New tab menu. */
export async function openChat(
	page: Page,
	workspaceId: string,
	name: string,
	agent: ChatAgent = "claude",
) {
	const project = await createProject(workspaceId, { name });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	return { project, ...(await launchChat(page, workspaceId, project.id, agent)) };
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
		agent = "claude",
	}: {
		/** Whose chat the host says this is, which names the agent throughout. */
		agent?: ChatAgent;
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
			agent === "codex"
				? { agent, model: "gpt-5.5", effort: "medium", mode: "onRequest" }
				: { agent, model: "default", effort: "high", mode: "default" },
		]);
		for (const frame of first) send(frame);
		ws.onMessage((raw) => reply?.(JSON.parse(String(raw)), send));
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	// The Model picker is drawn once settings arrive, in the closed options panel.
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	return view;
}

/** Open the composer's Chat options panel, which holds the pickers and the read-aloud switch. */
export async function openChatOptions(view: Locator): Promise<void> {
	const options = view.getByTestId("composer-options");
	if ((await options.getAttribute("aria-expanded")) !== "true") await options.click();
	await expect(view.getByTestId("composer-picks")).toBeVisible();
}

/** Replace the MCP server list the fake chat reports, which it sends to every attachment. */
export async function setMcpServers(
	id: string,
	servers: { name: string; status: string }[],
): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ servers }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the MCP list: ${response.status}`);
}

/** Send a message from the composer, once the host's settings have drawn the pickers. */
export async function sendMessage(view: Locator, text: string): Promise<void> {
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await box.fill(text);
	await box.press("Enter");
}

/** The card answers the fake chat has received, as the browser sent them. */
export async function answersOf(id: string): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/answers`);
	const body = (await response.json()) as { answers: Record<string, unknown>[] };
	return body.answers;
}

/** Run `check` in the dark theme, then in the light one (SPEC.md §25.8). */
export async function inBothThemes(page: Page, check: () => Promise<void>) {
	for (const colorScheme of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme });
		await check();
	}
}

/** The newest turn with its folded work and every group of tool calls opened. */
export async function openWork(view: Locator): Promise<Locator> {
	const turn = view.getByTestId("chat-turn").last();
	const worked = turn.getByTestId("chat-worked");
	if (!(await worked.evaluate((node) => (node as HTMLDetailsElement).open))) {
		await worked.locator("> summary").click();
	}
	const groups = turn.getByTestId("chat-tool-group");
	for (let at = 0; at < (await groups.count()); at++) {
		const group = groups.nth(at);
		if (!(await group.evaluate((node) => (node as HTMLDetailsElement).open))) {
			await group.locator("> summary").click();
		}
	}
	return turn;
}

/** A tool row's summary line: the sentence the conversation shows for the call. */
export function rowLine(view: Locator, id: string): Locator {
	return view.getByTestId(`chat-tool-${id}`).locator("> summary");
}

/** What a screen reader is told: exactly the card's heading, as a sentence. */
export async function expectAnnounced(view: Locator, waiting = 0) {
	const heading =
		(
			await view.getByTestId("chat-cards").getByRole("heading").first().textContent()
		)?.trim() ?? "";
	const said = heading.endsWith("?") ? heading : `${heading}.`;
	const more =
		waiting === 0
			? ""
			: ` ${waiting === 1 ? "1 more request is waiting." : `${waiting} more requests are waiting.`}`;
	await expect(view.getByTestId("chat-announcer")).toHaveText(`${said}${more}`);
	return heading;
}
