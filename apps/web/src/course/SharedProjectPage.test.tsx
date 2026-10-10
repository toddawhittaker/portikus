import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { shareProblem } from "./shared/queries.js";

// Monaco does not run in jsdom; these stand-ins show what they were given.
vi.mock("./shared/ReadOnlyText.js", () => ({
	ReadOnlyText: ({ path, text }: { path: string; text: string }) => (
		<pre data-testid={`shared-text-${path}`}>{text}</pre>
	),
}));
vi.mock("../editor/DiffViewer.js", () => ({
	DiffViewer: (props: { original: string; modified: string; testId: string }) => (
		<div data-testid={props.testId}>
			<pre data-testid="diff-before">{props.original}</pre>
			<pre data-testid="diff-after">{props.modified}</pre>
		</div>
	),
}));

afterEach(() => vi.unstubAllGlobals());

const COURSE = "55555555-5555-4555-8555-555555555555";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const BASE = `/courses/${COURSE}/shares/${PROJECT}`;
const PATH = `/course/${COURSE}/shares/${PROJECT}`;

const SHARE = {
	projectId: PROJECT,
	projectName: "todo-api",
	userId: "77777777-7777-4777-8777-777777777777",
	displayName: "Sam Student",
	startedAt: "2026-10-10T09:00:00.000Z",
	endsAt: "2026-10-11T09:00:00.000Z",
	workspaceState: "running",
};

function entry(name: string, type: "file" | "dir" = "file") {
	return { name, type, size: 10, mtimeMs: 1000 };
}

const STATUS = {
	repo: true,
	branch: "main",
	detached: false,
	upstream: null,
	ahead: 0,
	behind: 0,
	conflicts: 0,
	entries: [{ path: "src/app.js", x: ".", y: "M", unmerged: false }],
	ignored: [],
	truncated: false,
};

const CHECKS = {
	checks: [
		{ id: "tests", name: "Tests", command: "npm test" },
		{ id: "lint", name: "Lint", command: "npm run lint" },
	],
	error: null,
	runs: [
		{
			id: "r1",
			checkId: "tests",
			state: "passed",
			startedAt: "2026-10-10T09:00:00.000Z",
			endedAt: "2026-10-10T09:01:00.000Z",
			exitCode: 0,
		},
	],
};

/** Answers the shared reads; `override` replaces one URL's answer. */
function serve(override: Record<string, () => Response> = {}) {
	return stubFetch((url) => {
		if (override[url]) return override[url]();
		if (url === "/auth/me") return json(200, { ...USER, role: "instructor" });
		if (url === `/courses/${COURSE}/shares`) return json(200, { shares: [SHARE] });
		if (url === `${BASE}/tree?path=`) {
			return json(200, {
				entries: [entry("src", "dir"), entry(".gitignore"), entry("README.md")],
				truncated: false,
			});
		}
		if (url === `${BASE}/tree?path=src`) {
			return json(200, {
				entries: [entry("app.js"), entry("logo.png")],
				truncated: false,
			});
		}
		if (url === `${BASE}/git/status`) return json(200, STATUS);
		if (url === `${BASE}/checks`) return json(200, CHECKS);
		if (url === `${BASE}/file?path=README.md`) {
			return new Response("# Todo API\n", {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
		if (url === `${BASE}/git/diff?path=src%2Fapp.js`) {
			return json(200, {
				status: "M",
				before: "let a = 1;\n",
				after: "let a = 2;\n",
				binary: false,
				tooLarge: false,
			});
		}
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
}

test("an instructor sees the project's files, changes and checks", async () => {
	serve();
	renderApp(PATH);

	expect(
		await screen.findByRole("heading", { level: 1, name: "todo-api" }),
	).toBeDefined();
	expect(screen.getByTestId("shared-byline").textContent).toContain(
		"Shared by Sam Student",
	);
	const tree = await screen.findByRole("list", { name: "Files in todo-api" });
	expect(await within(tree).findByTestId("shared-row-README.md")).toBeDefined();
	// A dotfile waits for Show hidden, as in the student's own tree.
	expect(within(tree).queryByTestId("shared-row-.gitignore")).toBeNull();
	fireEvent.click(
		screen.getByRole("checkbox", { name: "Show hidden and generated files" }),
	);
	expect(within(tree).getByTestId("shared-row-.gitignore")).toBeDefined();

	// The folder holding a change carries the dot, and opening it lists it.
	const src = within(tree).getByTestId("shared-row-src");
	expect(src.getAttribute("data-git")).toBe("dir");
	expect(src.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(src);
	expect(src.getAttribute("aria-expanded")).toBe("true");
	const app = await within(tree).findByTestId("shared-row-src/app.js");
	expect(app.getAttribute("data-git")).toBe("modified");
	expect(app.textContent).toContain("Modified");

	const changes = await screen.findByTestId("shared-changes");
	expect(within(changes).getByTestId("shared-change-src/app.js").textContent).toContain(
		"src/app.js",
	);

	expect((await screen.findByTestId("shared-check-state-tests")).textContent).toBe(
		"Passed",
	);
	expect(screen.getByTestId("shared-check-state-lint").textContent).toBe("Not run yet");
});

test("a file opens read-only and a change opens its diff", async () => {
	serve();
	renderApp(PATH);

	fireEvent.click(await screen.findByTestId("shared-row-README.md"));
	expect((await screen.findByTestId("shared-text-README.md")).textContent).toBe(
		"# Todo API\n",
	);
	expect(screen.getByTestId("shared-row-README.md").getAttribute("aria-current")).toBe(
		"true",
	);

	fireEvent.click(await screen.findByTestId("shared-change-src/app.js"));
	expect(await screen.findByTestId("shared-diff-src/app.js")).toBeDefined();
	expect(screen.getByTestId("diff-before").textContent).toBe("let a = 1;\n");
	expect(screen.getByTestId("diff-after").textContent).toBe("let a = 2;\n");
	expect(screen.getByTestId("shared-diff-status").textContent).toContain("Modified");
	expect(
		screen.getByRole("heading", { level: 2, name: "Changes in src/app.js" }),
	).toBeDefined();
});

test("an image is drawn from the inline address, versioned by the listing", async () => {
	serve();
	renderApp(PATH);

	fireEvent.click(await screen.findByTestId("shared-row-src"));
	fireEvent.click(await screen.findByTestId("shared-row-src/logo.png"));
	const image = (await screen.findByRole("img", {
		name: "logo.png",
	})) as HTMLImageElement;
	expect(image.getAttribute("src")).toBe(
		`${BASE}/file?path=src%2Flogo.png&inline=1&v=10-1000`,
	);
});

test("there is no way to write, download, or reach a terminal or preview", async () => {
	serve();
	renderApp(PATH);

	fireEvent.click(await screen.findByTestId("shared-row-README.md"));
	await screen.findByTestId("shared-text-README.md");
	fireEvent.click(await screen.findByTestId("shared-change-src/app.js"));
	await screen.findByTestId("shared-diff-src/app.js");

	const main = screen.getByTestId("page-shared-project");
	const controls = within(main)
		.queryAllByRole("button")
		.map((button) => button.textContent ?? "");
	for (const name of controls) {
		expect(name).not.toMatch(
			/edit|save|rename|delete|upload|download|terminal|preview|run|stop|new/i,
		);
	}
	expect(within(main).queryAllByRole("textbox")).toEqual([]);
});

test("a stopped workspace says so instead of the files", async () => {
	serve({
		[`${BASE}/tree?path=`]: () =>
			json(409, { code: "WORKSPACE_NOT_RUNNING", message: "The workspace is stopped" }),
	});
	renderApp(PATH);

	const notice = await screen.findByTestId("shared-stopped");
	expect(notice.textContent).toContain("The workspace is stopped");
	expect(screen.queryByTestId("shared-tree")).toBeNull();
});

test("a share that ended says it is not available", async () => {
	serve({
		[`/courses/${COURSE}/shares`]: () => json(200, { shares: [] }),
		[`${BASE}/tree?path=`]: () =>
			json(404, { code: "NOT_FOUND", message: "Not found." }),
	});
	renderApp(PATH);

	expect((await screen.findByTestId("shared-gone")).textContent).toContain(
		"This share is not available",
	);
	await waitFor(() => expect(screen.queryByTestId("shared-tree")).toBeNull());
});

test("only the share gate's answers count as a stopped or ended share", () => {
	expect(shareProblem(new ApiError(409, "x", "WORKSPACE_NOT_RUNNING"))).toBe("stopped");
	expect(shareProblem(new ApiError(404, "x", "NOT_FOUND"))).toBe("gone");
	// A missing file or folder is not a missing share.
	expect(shareProblem(new ApiError(404, "x", "FILE_NOT_FOUND"))).toBeNull();
	expect(shareProblem(new ApiError(503, "x", "AGENT_UNAVAILABLE"))).toBeNull();
	expect(shareProblem(new Error("x"))).toBeNull();
});
