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
		sizeBytes: 880803840,
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
		newerPublished: null,
		disk: { freeBytes: 5 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
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

test("a newer published image shows a notice whose button asks for the update (issue #861)", async () => {
	const fetch = stubFetch((url, init) =>
		init?.method === "POST"
			? json(202, job({ state: "queued" }))
			: url.startsWith("/admin/image/jobs/")
				? json(200, { job: job(), log: [] })
				: json(200, data({ newerPublished: "2026.09.13" })),
	);
	renderWithQuery(<ImageTab />);
	const notice = await screen.findByTestId("image-newer-published");
	expect(notice.textContent).toContain("Image 2026.09.13 is published");
	fireEvent.click(within(notice).getByRole("button", { name: "Update to 2026.09.13" }));
	fireEvent.click(
		within(await screen.findByTestId("image-confirm")).getByRole("button", {
			name: "Update",
		}),
	);
	await waitFor(() => {
		const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({ kind: "fetch" });
	});
});

test("no notice when nothing newer is published", async () => {
	stubFetch(() => json(200, data()));
	renderWithQuery(<ImageTab />);
	await screen.findByTestId("image-default");
	expect(screen.queryByTestId("image-newer-published")).toBeNull();
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

test("a confirmed update from the notice sends focus to the job heading, not the page body", async () => {
	let posted = false;
	stubFetch((url, init) => {
		if (init?.method === "POST") {
			posted = true;
			return json(202, job({ state: "queued" }));
		}
		if (url.startsWith("/admin/image/jobs/")) return json(200, { job: job(), log: [] });
		return json(
			200,
			posted ? data({ job: job() }) : data({ newerPublished: "2026.09.13" }),
		);
	});
	renderWithQuery(<ImageTab />);
	const notice = await screen.findByTestId("image-newer-published");
	const update = within(notice).getByRole("button", { name: "Update to 2026.09.13" });
	update.focus();
	fireEvent.click(update);
	fireEvent.click(
		within(await screen.findByTestId("image-confirm")).getByRole("button", {
			name: "Update",
		}),
	);
	await waitFor(() => expect(screen.queryByTestId("image-confirm")).toBeNull());
	expect(screen.queryByTestId("image-newer-published")).toBeNull();
	await waitFor(() => expect(document.activeElement?.id).toBe("image-job-title"));
});

test("shows each image's size and the main disk's free space (issue #936)", async () => {
	stubFetch(() =>
		json(
			200,
			data({
				images: [
					image("2026.09.10", { role: "default" }),
					image("2026.09.11", { sizeBytes: null }),
				],
			}),
		),
	);
	renderWithQuery(<ImageTab />);
	expect((await screen.findByTestId("image-size-2026.09.10")).textContent).toBe(
		"840 MB",
	);
	expect(screen.getByTestId("image-size-2026.09.11").textContent).toBe(
		"Not measured yet",
	);
	expect(screen.getByTestId("image-disk-free").textContent).toBe(
		"Free space on the main disk: 5.0 GB of 20.0 GB.",
	);
});

test("Delete is off for the default and the previous image, with the reason", async () => {
	stubFetch(() => json(200, data()));
	renderWithQuery(<ImageTab />);
	for (const [version, reason] of [
		["2026.09.10", "The default image cannot be deleted."],
		["2026.09.9", "The previous image is kept so you can roll back."],
	] as const) {
		const button = await screen.findByTestId(`image-delete-${version}`);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(screen.getByText(reason)).toBeTruthy();
		fireEvent.click(button);
		expect(screen.queryByTestId("image-confirm")).toBeNull();
	}
});

test("Delete confirms with the workspace count and posts a delete request", async () => {
	const fetch = stubFetch((url, init) =>
		init?.method === "POST"
			? json(202, job({ kind: "delete", state: "queued", request: null }))
			: url.startsWith("/admin/image/jobs/")
				? json(200, { job: job({ kind: "delete", version: "2026.09.11" }), log: [] })
				: json(
						200,
						data({
							images: [
								...data().images.slice(0, 2),
								image("2026.09.11", { workspaces: 4 }),
							],
						}),
					),
	);
	renderWithQuery(<ImageTab />);
	fireEvent.click(await screen.findByTestId("image-delete-2026.09.11"));
	const dialog = await screen.findByTestId("image-confirm");
	expect(dialog.textContent).toContain("Delete image 2026.09.11?");
	expect(dialog.textContent).toContain("4 workspaces were made from this image.");
	fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
	await waitFor(() => {
		const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({
			kind: "delete",
			version: "2026.09.11",
		});
	});
});
