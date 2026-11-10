import {
	type BrowserContext,
	expect,
	type Page,
	type Route,
	test,
} from "@playwright/test";
import { openChat, receivedFrames } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";

/**
 * The `@` menu (SPEC.md §10.8, §11.1, §25.8; #1782): `@` anywhere opens a
 * list of project files that narrows as the student types and puts the path
 * in the box as a mention the CLI expands. Typing waits before a search goes
 * out, a newer query cancels an older one, no match and a cut-off list say
 * so, and a failed search stays quiet. The file-name route is answered here,
 * so each answer, its timing and its failure are exact.
 */

const FILES = [
	"README.md",
	"src/app.ts",
	"src/components/AppHeader.tsx",
	"docs/my notes.md",
	"package.json",
];

/** The queries the page searched for, in order. */
async function answerSearches(
	page: Page,
	answer: (query: string, route: Route) => Promise<void> | void = (query, route) => {
		const paths = FILES.filter((path) =>
			path.toLowerCase().includes(query.toLowerCase()),
		);
		return route.fulfill({ json: { paths, truncated: false } });
	},
): Promise<string[]> {
	const queries: string[] = [];
	await page.route("**/file-search", async (route) => {
		const body = route.request().postDataJSON() as { query: string; limit: number };
		expect(body.limit).toBe(20);
		queries.push(body.query);
		await answer(body.query, route);
	});
	return queries;
}

async function openMentions(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Mentions");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	return { id, view, box };
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`@ lists project files, narrows, and Enter inserts the mention (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const queries = await answerSearches(page);
		const { view, box } = await openMentions(page, context);
		await page.keyboard.type("look at @");
		const list = view.getByRole("listbox", { name: "Files" });
		await expect(list.getByRole("option")).toHaveCount(5);
		await expect(view.getByTestId("composer-menu-status")).toHaveText("5 files");
		await expect(box).toHaveAttribute("aria-expanded", "true");
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await page.keyboard.type("app");
		await expect(list.getByRole("option")).toHaveCount(2);
		await expect(list.getByRole("option").first()).toHaveAccessibleName("src/app.ts");
		await page.keyboard.press("ArrowDown");
		await expect(list.getByRole("option", { selected: true })).toHaveAccessibleName(
			"src/components/AppHeader.tsx",
		);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await page.keyboard.press("Enter");
		await expect(box).toHaveText("look at @src/components/AppHeader.tsx");
		await expect(view.getByRole("listbox")).toHaveCount(0);
		// Typing waited: one search for the bare `@`, one once "app" was typed, none per key.
		expect(queries).toEqual(["", "app"]);
	});
}

test("the mention is what is sent, and a path with a space is quoted", async ({
	page,
	context,
}) => {
	await answerSearches(page);
	const { id, view, box } = await openMentions(page, context);
	await page.keyboard.type("@notes");
	await expect(view.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Tab");
	await expect(box).toHaveText('@"docs/my notes.md"');
	await page.keyboard.type("and @READ");
	await expect(view.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Enter");
	await expect(box).toHaveText('@"docs/my notes.md" and @README.md');
	expect(await receivedFrames(id, "send")).toEqual([]);
	await page.keyboard.press("Enter");
	await expect
		.poll(async () => (await receivedFrames(id, "send")).map((frame) => frame.text))
		.toEqual(['@"docs/my notes.md" and @README.md ']);
});

test("no match, a cut-off list and a failed search each say so quietly", async ({
	page,
	context,
}) => {
	await answerSearches(page, (query, route) => {
		if (query === "zzz")
			return route.fulfill({ json: { paths: [], truncated: false } });
		if (query === "src")
			return route.fulfill({
				json: {
					paths: Array.from({ length: 20 }, (_, at) => `src/file-${at}.ts`),
					truncated: true,
				},
			});
		return route.fulfill({
			status: 409,
			json: { error: { code: "BUSY", message: "too many searches are running" } },
		});
	});
	const { view, box } = await openMentions(page, context);
	const note = view.getByTestId("composer-menu-note");
	await page.keyboard.type("@zzz");
	await expect(note).toHaveText("No matching files");
	await expect(view.getByTestId("composer-menu-status")).toHaveText(
		"No matching files",
	);
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("@src");
	await expect(view.getByRole("option")).toHaveCount(20);
	await expect(note).toHaveText("20 files, more not shown; type more to narrow");
	await page.keyboard.type("x");
	await expect(note).toHaveText("Files could not be searched just now");
	await expect(view.getByTestId("chat-composer-error")).toHaveText("");
	await expect(page.getByRole("alert").filter({ hasText: "search" })).toHaveCount(0);
	await expect(box).toHaveText("@srcx");
});

test("a newer query cancels the search still running, whose answer never shows", async ({
	page,
	context,
}) => {
	let releaseSlow: () => void = () => {};
	const slowHeld = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	let staleDone: () => void = () => {};
	const staleAnswered = new Promise<void>((resolve) => {
		staleDone = resolve;
	});
	const queries = await answerSearches(page, async (query, route) => {
		if (query === "a") {
			await slowHeld;
			// The page gave up on this search; answering it may fail, which is fine.
			await route
				.fulfill({ json: { paths: ["stale.ts"], truncated: false } })
				.catch(() => {});
			staleDone();
			return;
		}
		await route.fulfill({ json: { paths: ["ab.ts"], truncated: false } });
	});
	const { view } = await openMentions(page, context);
	await page.keyboard.type("@a");
	await expect.poll(() => queries).toContain("a");
	await page.keyboard.type("b");
	await expect(view.getByRole("option")).toHaveCount(1);
	await expect(view.getByRole("option")).toHaveAccessibleName("ab.ts");
	releaseSlow();
	await staleAnswered;
	await expect(view.getByRole("option")).toHaveAccessibleName("ab.ts");
});
