import type { AdminImage, ImageJobView, ImageView } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { ImageTab } from "./ImageTab.js";

afterEach(() => vi.unstubAllGlobals());

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function image(version: string, over: Partial<ImageView> = {}): ImageView {
	return {
		version,
		role: "candidate",
		manifest: {
			schema: 1,
			version,
			recipeVersion: "2026.09.10",
			source: "published",
			builtAt: "2026-09-20T10:00:00Z",
			fingerprint: null,
			parameters: { node: "24", python: "debian" },
			tools: {
				node: "v24.8.0",
				npm: "11.6.0",
				python3: "Python 3.13.5",
				git: "git",
				docker: "docker",
				claude: "2.0.1",
				codex: "0.40.0",
			},
			packageCount: 400,
		},
		health: { result: "passed", checkedAt: "2026-09-20T10:00:00Z", checks: [] },
		workspaces: 0,
		...over,
	};
}

function job(over: Partial<ImageJobView> = {}): ImageJobView {
	return {
		id: JOB_ID,
		kind: "fetch",
		state: "running",
		step: "Downloading",
		version: null,
		message: null,
		requestedAt: null,
		startedAt: "2026-09-28T10:00:00Z",
		finishedAt: null,
		request: { kind: "fetch" },
		...over,
	};
}

function data(over: Partial<AdminImage> = {}): AdminImage {
	return {
		default: "2026.09.10",
		previous: "2026.09.9",
		images: [
			image("2026.09.10", { role: "default", workspaces: 3 }),
			image("2026.09.9", { role: "previous", workspaces: 1 }),
			image("2026.09.11", {
				health: { result: "failed", checkedAt: "2026-09-28T10:00:00Z", checks: [] },
			}),
		],
		otherWorkspaces: 2,
		job: null,
		...over,
	};
}

const DIFF = {
	from: "2026.09.10",
	to: "2026.09.12",
	tools: {
		added: [],
		removed: [],
		changed: [{ name: "node", from: "v24", to: "v26" }],
	},
	packages: { added: [{ name: "zsh", version: "5.9" }], removed: [], changed: [] },
};

test("says the section is off when the API answers 404", async () => {
	stubFetch(() => json(404, { code: "NOT_FOUND", message: "Not found." }));
	renderWithQuery(<ImageTab />);
	expect(await screen.findByText("Image management is off on this site")).toBeTruthy();
});

test("shows the default, previous, counts, and a failed image cannot be made default", async () => {
	stubFetch(() => json(200, data()));
	renderWithQuery(<ImageTab />);
	expect((await screen.findByTestId("image-default")).textContent).toBe("2026.09.10");
	expect(screen.getByTestId("image-previous").textContent).toBe("2026.09.9");
	expect(screen.getByTestId("image-workspaces-2026.09.10").textContent).toBe("3");
	expect(screen.getByTestId("image-other-workspaces").textContent).toContain(
		"2 workspaces",
	);
	const failed = screen.getByTestId("image-make-default-2026.09.11");
	expect(failed.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByText("This image failed its health check.")).toBeTruthy();
	fireEvent.click(failed);
	expect(screen.queryByTestId("image-confirm")).toBeNull();
});

test("a running job turns the actions off and shows its step and log", async () => {
	stubFetch((url) =>
		url.startsWith("/admin/image/jobs/")
			? json(200, { job: job(), log: ["fetching", "verifying"] })
			: json(200, data({ job: job() })),
	);
	renderWithQuery(<ImageTab />);
	await screen.findByTestId("image-job");
	expect(screen.getByTestId("image-fetch").getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("image-rebuild").getAttribute("aria-disabled")).toBe(
		"true",
	);
	expect(screen.getByTestId("image-job-state").textContent).toContain("Downloading");
	await waitFor(() =>
		expect(screen.getByTestId("image-job-log").textContent).toContain("verifying"),
	);
});

test("Rebuild posts the chosen Node and Python", async () => {
	const fetch = stubFetch((url, init) =>
		init?.method === "POST"
			? json(202, job({ kind: "build", state: "queued" }))
			: url.startsWith("/admin/image/jobs/")
				? json(200, { job: job(), log: [] })
				: json(200, data()),
	);
	renderWithQuery(<ImageTab />);
	fireEvent.click(await screen.findByTestId("image-rebuild"));
	const dialog = await screen.findByTestId("image-rebuild-dialog");
	fireEvent.click(within(dialog).getByTestId("image-rebuild-confirm"));
	await waitFor(() => {
		const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({
			kind: "build",
			node: "24",
			python: "debian",
		});
	});
});

test("a finished fetch shows its changes and offers Make default", async () => {
	const done = job({ state: "succeeded", step: "Done", version: "2026.09.12" });
	stubFetch((url) => {
		if (url.startsWith("/admin/image/diff")) return json(200, DIFF);
		if (url.startsWith("/admin/image/jobs/")) return json(200, { job: done, log: [] });
		return json(
			200,
			data({ job: done, images: [...data().images, image("2026.09.12")] }),
		);
	});
	renderWithQuery(<ImageTab />);
	const result = await screen.findByTestId("image-job-result");
	await waitFor(() => expect(within(result).getByText("zsh")).toBeTruthy());
	fireEvent.click(within(result).getByTestId("image-make-default-2026.09.12"));
	expect(await screen.findByTestId("image-confirm")).toBeTruthy();
});
