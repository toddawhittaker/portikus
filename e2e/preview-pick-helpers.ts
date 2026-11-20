import type { BrowserContext, Frame, FrameLocator, Page } from "@playwright/test";
import { FAKE_AGENT_TOKEN } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * What the pick-mode tests share (SPEC.md §14.6, §24): the frames of an
 * embedded preview, the files a pick leaves in the drop folder, the input a
 * terminal was sent, and messages forged the three ways the student's code
 * can reach the Portikus page.
 */

export const PICK_BUTTON = "Pick an element";

/** The preview pane's frame, which holds the wrapper page. */
export function wrapperLocator(page: Page): FrameLocator {
	return page.frameLocator("[data-testid=preview-frame]");
}

function onPreviewHost(url: string): boolean {
	try {
		return new URL(url).hostname.endsWith(".preview.localhost");
	} catch {
		return false;
	}
}

/** The wrapper page's own document, for scripts that must run as it. */
export function wrapperFrame(page: Page): Frame {
	const found = page
		.frames()
		.find((one) => one.parentFrame() === page.mainFrame() && onPreviewHost(one.url()));
	if (!found) throw new Error("the preview frame is not there");
	return found;
}

/**
 * Give page loads the `Sec-Fetch-Dest` header a browser sends, which a route
 * handler cannot read, so the stand-in gateway can tell a frame loading the
 * wrapper from a tab opening it. Register it after the gateway: the last route
 * registered runs first. `user` adds `Sec-Fetch-User` too, as for a load the
 * student started.
 */
export async function sendFetchMetadata(
	context: BrowserContext,
	options: { user?: boolean } = {},
): Promise<void> {
	await context.route(
		(url) => onPreviewHost(url.toString()),
		async (route) => {
			const request = route.request();
			let dest: string | null = null;
			if (request.resourceType() === "document") {
				try {
					dest = request.frame().parentFrame() ? "iframe" : "document";
				} catch {
					// A request from a worker has no frame, and the browser sends it no such header.
				}
			}
			if (dest === null) return route.fallback();
			await route.fallback({
				headers: {
					...request.headers(),
					"sec-fetch-dest": dest,
					...(options.user ? { "sec-fetch-user": "?1" } : {}),
				},
			});
		},
	);
}

/** The origin the preview is showing, taken from the toolbar. */
export async function previewOriginOf(page: Page): Promise<string> {
	const host = await page.getByTestId("preview-host").textContent();
	return `https://${host ?? ""}`;
}

/** A well-formed `picked` message, every field a page could set. */
export interface ForgedPick {
	pagePath?: string;
	html?: string;
	/** A picture of this many bytes; the PNG signature leads it when `signature` is true. */
	png?: { bytes: number; signature: boolean };
}

export const FORGED_MARKER = "FORGED-BY-TEST";

/**
 * The message body, built in the page it is posted from so the picture can
 * be a real `ArrayBuffer`. Written out in each `evaluate` below because a
 * function sent to a page cannot use anything defined beside it, and the
 * wrapper's policy forbids `eval`.
 */

/**
 * Post a forged pick to the Portikus page as the wrapper page itself would,
 * which is the one window the page listens to. Only what the message says is
 * forged; its source is genuine.
 */
export async function postFromWrapper(
	page: Page,
	pick: ForgedPick = {},
): Promise<void> {
	await wrapperFrame(page).evaluate((given) => {
		const bytes = given.png ? new Uint8Array(given.png.bytes) : null;
		if (bytes && given.png?.signature) {
			bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		}
		window.parent.postMessage(
			{
				v: 1,
				type: "picked",
				pagePath: given.pagePath ?? "/",
				selector: "#forged-selector",
				tag: "div",
				html: given.html ?? "<div>FORGED-BY-TEST</div>",
				rules: [],
				computed: {},
				trimmed: { html: false, rules: false },
				...(bytes ? { png: bytes.buffer } : {}),
			},
			"*",
		);
	}, pick);
}

/** Post a forged pick straight from the student's own window, past the wrapper. */
export async function postFromApp(frame: Frame, pick: ForgedPick = {}): Promise<void> {
	await frame.evaluate((given) => {
		window.top?.postMessage(
			{
				v: 1,
				type: "picked",
				pagePath: given.pagePath ?? "/",
				selector: "#forged-selector",
				tag: "div",
				html: given.html ?? "<div>FORGED-BY-TEST</div>",
				rules: [],
				computed: {},
				trimmed: { html: false, rules: false },
			},
			"*",
		);
	}, pick);
}

/** Let messages already posted reach the page and the page act on them. */
export async function settle(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((done) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => setTimeout(done, 500);
				channel.port2.postMessage(0);
			}),
	);
}

function agentGet(workspaceId: string, path: string): Promise<Response> {
	return fetch(`${FAKE_AGENT_URL}${path}`, {
		headers: { authorization: `Bearer ${FAKE_AGENT_TOKEN}:${workspaceId}` },
	});
}

/** One drop folder's files, by name. */
export interface PickFolder {
	stamp: string;
	files: Record<string, Buffer>;
}

/** Every folder under `.portikus/pastes`, as the workspace holds them now. */
export async function pickFolders(
	workspaceId: string,
	slug: string,
): Promise<PickFolder[]> {
	const root = ".portikus/pastes";
	const listing = await agentGet(
		workspaceId,
		`/projects/${slug}/tree?path=${encodeURIComponent(root)}`,
	);
	if (!listing.ok) return [];
	const { entries } = (await listing.json()) as { entries: { name: string }[] };
	const folders: PickFolder[] = [];
	for (const entry of entries) {
		const inner = await agentGet(
			workspaceId,
			`/projects/${slug}/tree?path=${encodeURIComponent(`${root}/${entry.name}`)}`,
		);
		const names = ((await inner.json()) as { entries: { name: string }[] }).entries;
		const files: Record<string, Buffer> = {};
		for (const file of names) {
			const bytes = await agentGet(
				workspaceId,
				`/projects/${slug}/file?path=${encodeURIComponent(`${root}/${entry.name}/${file.name}`)}`,
			);
			files[file.name] = Buffer.from(await bytes.arrayBuffer());
		}
		folders.push({ stamp: entry.name, files });
	}
	return folders;
}

/** The text a terminal was sent as input, in order. */
export async function typedInto(terminalId: string): Promise<string> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/received`);
	const { received } = (await response.json()) as {
		received: { terminalId: string; text: string }[];
	};
	return received
		.filter((frame) => frame.terminalId === terminalId)
		.map((frame) => JSON.parse(frame.text) as { type: string; data?: string })
		.filter((frame) => frame.type === "input")
		.map((frame) => frame.data ?? "")
		.join("");
}

/** The Markdown file of a pick, as text. */
export function pickText(folder: PickFolder): string {
	return (folder.files["picked-element.md"] ?? Buffer.alloc(0)).toString("utf8");
}

/** The contents of every fenced block in a Markdown text, and the text outside them. */
export function splitFences(markdown: string): { fenced: string[]; plain: string } {
	const fenced: string[] = [];
	const plain: string[] = [];
	let fence: string | null = null;
	let block: string[] = [];
	for (const line of markdown.split("\n")) {
		if (fence === null) {
			const opening = /^(`{3,})[a-z]*$/.exec(line);
			if (opening) {
				fence = opening[1] ?? "```";
				block = [];
			} else plain.push(line);
		} else if (line === fence) {
			fenced.push(block.join("\n"));
			fence = null;
		} else block.push(line);
	}
	return { fenced, plain: plain.join("\n") };
}

/** Post a forged pick from a window the student's application opened. */
export async function postFromPopup(popup: Page): Promise<void> {
	await popup.evaluate(() => {
		window.opener?.top.postMessage(
			{
				v: 1,
				type: "picked",
				pagePath: "/",
				selector: "#forged-selector",
				tag: "div",
				html: "<div>FORGED-BY-TEST</div>",
				rules: [],
				computed: {},
				trimmed: { html: false, rules: false },
			},
			"*",
		);
	});
}
