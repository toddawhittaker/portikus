/**
 * Shared pieces of the code-help specs (SPEC.md §13.6): a window on the
 * browser's language-server sockets, with a way to rewrite what a server
 * answers. The sockets still go through the real API to the fake agent's
 * scripted server; the hook only edits the answer on its way to the page.
 */
import { expect, type Page, type test, type WebSocketRoute } from "@playwright/test";
import {
	CODE_HELP_SWITCH_LOCK,
	createProject,
	lockSharedState,
	query,
	SETTINGS_ROW_LOCK,
	seedFile,
	type TestProject,
	type TestStudent,
	workspacePath,
} from "./helpers";

// e2e cannot import @portikus/contracts; these are its LANGUAGE_SERVER_IDS.
export type LanguageServerId = "python" | "typescript" | "ruff";

/** A JSON-RPC message, as far as the specs read one. */
interface Rpc {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	// biome-ignore lint/suspicious/noExplicitAny: LSP params differ for every method
	params?: any;
	// biome-ignore lint/suspicious/noExplicitAny: LSP results differ for every method
	result?: any;
	error?: { code: number; message: string };
}

/** One frame the browser sent, with the server id of its socket. */
interface Sent {
	server: LanguageServerId;
	/** Which socket of that server, from 0. */
	attempt: number;
	message: Rpc;
}

/** Return from a rewrite to hold an answer back for good. */
export const DROP = Symbol("drop");

interface RewriteContext {
	server: LanguageServerId;
	method: string;
	params: Rpc["params"];
	result: Rpc["result"];
}

/** A close the agent side of a socket made, as the browser saw it. */
interface Closed {
	server: LanguageServerId;
	code: number;
	reason: string;
}

export interface Wire {
	/** Every frame the browser sent, in order. */
	sent: Sent[];
	/** Every close that came from the API or agent, in order. */
	closes: Closed[];
	/** How many sockets the page opened to a server id. */
	opened: (server: LanguageServerId) => number;
	/** The sent frames with this method. */
	sentWith: (method: string, server?: LanguageServerId) => Sent[];
	/** Send a frame to the page on the newest open socket of a server. */
	push: (server: LanguageServerId, message: Rpc) => void;
	/** Close the newest socket of a server from the agent's side. */
	close: (server: LanguageServerId, code: number, reason?: string) => Promise<void>;
	/** Close every open socket the same way. */
	closeAll: (code: number, reason?: string) => Promise<void>;
	/** Change the rewrite while the page runs. */
	rewrite: (hook: Rewrite | undefined) => void;
}

export type Rewrite = (context: RewriteContext) => unknown | typeof DROP | undefined;

interface Live {
	server: LanguageServerId;
	page: WebSocketRoute;
	agent: WebSocketRoute;
	open: boolean;
}

function serverOf(url: string): LanguageServerId {
	const last = new URL(url).pathname.split("/").pop();
	if (last === "python" || last === "typescript" || last === "ruff") return last;
	throw new Error(`not a language-server URL: ${url}`);
}

/** Watch every language-server socket the page opens; call before `goto`. */
export async function watchLanguageServers(
	page: Page,
	initial?: Rewrite,
): Promise<Wire> {
	const sent: Sent[] = [];
	const live: Live[] = [];
	const closes: Closed[] = [];
	const counts: Record<string, number> = {};
	let hook = initial;

	await page.routeWebSocket(/\/language-servers\//, (route) => {
		const server = serverOf(route.url());
		const attempt = counts[server] ?? 0;
		counts[server] = attempt + 1;
		const agent = route.connectToServer();
		const entry: Live = { server, page: route, agent, open: true };
		live.push(entry);
		// The method of each request that is waiting for its answer.
		const asked = new Map<number | string, { method: string; params: Rpc["params"] }>();

		route.onMessage((data) => {
			const text = typeof data === "string" ? data : data.toString();
			try {
				const message = JSON.parse(text) as Rpc;
				sent.push({ server, attempt, message });
				if (message.id !== undefined && message.method !== undefined) {
					asked.set(message.id, { method: message.method, params: message.params });
				}
			} catch {
				// A frame that is not JSON is passed on as it is.
			}
			agent.send(data);
		});
		agent.onMessage((data) => {
			const text = typeof data === "string" ? data : data.toString();
			let message: Rpc | undefined;
			try {
				message = JSON.parse(text) as Rpc;
			} catch {
				message = undefined;
			}
			const request =
				message?.id !== undefined && message.method === undefined
					? asked.get(message.id)
					: undefined;
			if (message && request && hook) {
				asked.delete(message.id as number | string);
				const changed = hook({
					server,
					method: request.method,
					params: request.params,
					result: message.result,
				});
				if (changed === DROP) return;
				if (changed !== undefined) {
					route.send(JSON.stringify({ ...message, result: changed }));
					return;
				}
			}
			route.send(data);
		});
		route.onClose((code, reason) => {
			entry.open = false;
			void agent.close({ code, reason }).catch(() => {});
		});
		// Handling the agent's close here means passing it on to the page too.
		agent.onClose((code, reason) => {
			// A close the helper or the page started has already been handled.
			if (!entry.open) return;
			entry.open = false;
			closes.push({ server, code: code ?? 1005, reason: reason ?? "" });
			void route.close({ code, reason }).catch(() => {});
		});
	});

	const newest = (server: LanguageServerId) =>
		[...live].reverse().find((entry) => entry.server === server && entry.open);

	const closeEntry = async (entry: Live, code: number, reason?: string) => {
		entry.open = false;
		await entry.page.close({ code, reason });
		await entry.agent.close().catch(() => {});
	};

	return {
		sent,
		closes,
		opened: (server) => counts[server] ?? 0,
		sentWith: (method, server) =>
			sent.filter(
				(item) => item.message.method === method && (!server || item.server === server),
			),
		push(server, message) {
			const entry = newest(server);
			if (!entry) throw new Error(`no open ${server} socket to push to`);
			entry.page.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
		},
		async close(server, code, reason) {
			const entry = newest(server);
			if (!entry) throw new Error(`no open ${server} socket to close`);
			await closeEntry(entry, code, reason);
		},
		async closeAll(code, reason) {
			for (const entry of live.filter((item) => item.open)) {
				await closeEntry(entry, code, reason);
			}
		},
		rewrite(next) {
			hook = next;
		},
	};
}

/** The Monaco text inside one editor tab. */
export function editorLines(page: Page, path: string) {
	return page.getByTestId(`editor-${path}`).locator(".view-lines");
}

/** The code-help state in a file's editor bar. */
export function codeHelpStatus(page: Page, path: string) {
	return page.getByTestId(`editor-code-help-${path}`);
}

/** The hover that is showing; Monaco keeps hidden ones in the page. */
export function hoverWidget(page: Page) {
	return page.locator(".monaco-hover:not(.hidden)").first();
}

/** How far the text cursor is below the top of the first line, in pixels. */
export async function cursorBelowFirstLine(page: Page, path?: string): Promise<number> {
	return page.evaluate((scope) => {
		const root = scope
			? document.querySelector(`[data-testid="editor-${scope}"]`)
			: document;
		const cursor = root?.querySelector(".cursors-layer .cursor");
		const line = root?.querySelector(".view-line");
		if (!cursor || !line) return Number.NaN;
		return cursor.getBoundingClientRect().top - line.getBoundingClientRect().top;
	}, path);
}

/** The text of the editor line the cursor is on, or null when it is not drawn. */
export async function lineAtCursor(page: Page, path: string): Promise<string | null> {
	return page.evaluate((scope) => {
		const root = document.querySelector(`[data-testid="editor-${scope}"]`);
		const cursor = root
			?.querySelector(".cursors-layer .cursor")
			?.getBoundingClientRect();
		if (!root || !cursor) return null;
		for (const line of root.querySelectorAll(".view-line")) {
			const box = line.getBoundingClientRect();
			if (cursor.top >= box.top - 1 && cursor.top < box.bottom) return line.textContent;
		}
		return null;
	}, path);
}

/** Rename the word at the cursor with F2, waiting for the name box. */
export async function renameTo(page: Page, name: string): Promise<void> {
	await page.keyboard.press("F2");
	await expect(page.locator(".rename-box.monaco-editor :focus")).toBeVisible();
	await page.keyboard.type(name);
	await page.keyboard.press("Enter");
}

/** The short message Monaco shows at the cursor. */
export function editorMessage(page: Page) {
	return page.locator(".monaco-editor-overlaymessage .message");
}

/**
 * Hold the switch lock for the tests of the enclosing describe: shared by the
 * tests that need code help on, alone by the ones that change the switch
 * (they write the one settings row, so they take its lock too).
 */
export function holdCodeHelpSwitch(
	hooks: Pick<typeof test, "beforeAll" | "afterAll" | "setTimeout">,
	{ alone = false }: { alone?: boolean } = {},
): void {
	const releases: Array<() => Promise<void>> = [];
	hooks.beforeAll(async () => {
		// Waiting for the other workers' tests to finish can take a while.
		hooks.setTimeout(600_000);
		if (alone) releases.push(await lockSharedState(SETTINGS_ROW_LOCK));
		releases.push(await lockSharedState(CODE_HELP_SWITCH_LOCK, { shared: !alone }));
	});
	hooks.afterAll(async () => {
		if (alone) {
			await query("update settings set code_help_enabled = true where id = 1");
		}
		for (const release of releases.reverse()) await release();
		releases.length = 0;
	});
}

/** The first character of a file, which every scripted answer points at. */
export const FIRST_CHARACTER = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 1 },
};

/** The URI a language server knows a project file by. */
export function serverUriOf(project: TestProject, path: string): string {
	return `file://${project.path}/${path}`;
}

/** Save after one second, so a test does not wait out the default delay. */
export async function saveQuickly(userId: string): Promise<void> {
	await query(
		"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
		[JSON.stringify({ autoSaveDelaySeconds: 1 }), userId],
	);
}

/**
 * Open a project whose layout holds one file tab per file, the first one
 * showing, with every file already on disk.
 */
export async function openProjectFiles(
	page: Page,
	student: TestStudent,
	name: string,
	files: Record<string, string>,
): Promise<TestProject> {
	const project = await createProject(student.workspaceId, { name });
	const paths = Object.keys(files);
	for (const path of paths) {
		await seedFile(student.workspaceId, project.slug, path, files[path] ?? "");
	}
	await query("update projects set layout = $2 where id = $1", [
		project.id,
		JSON.stringify({
			tabs: paths.map((path) => ({
				id: `file:${path}`,
				root: { type: "file", path },
			})),
		}),
	]);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId(`file-pane-${paths[0]}`)).toBeVisible({
		timeout: 15_000,
	});
	return project;
}
