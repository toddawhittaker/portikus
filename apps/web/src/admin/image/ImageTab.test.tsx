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
		codingAgents: null,
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

const NO_SURVEY = { day: null, surveyed: 0, packages: [] };

test("the tab ends with Packages students add, after the image actions", async () => {
	stubFetch((url) =>
		url === "/admin/packages" ? json(200, NO_SURVEY) : json(200, data()),
	);
	renderWithQuery(<ImageTab />);
	await screen.findByTestId("image-default");
	const headings = screen.getAllByRole("heading").map((h) => h.textContent);
	expect(headings.at(-1)).toBe("Packages students add");
	expect((await screen.findByTestId("packages-empty")).textContent).toBe(
		"No workspace has been surveyed yet.",
	);
});

test("the survey still shows when image management is off or fails", async () => {
	stubFetch((url) =>
		url === "/admin/packages"
			? json(200, NO_SURVEY)
			: json(404, { code: "NOT_FOUND", message: "Not found." }),
	);
	renderWithQuery(<ImageTab />);
	await screen.findByText("Image management is off on this site");
	expect(
		screen.getByRole("heading", { level: 3, name: "Packages students add" }),
	).toBeTruthy();
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

test("a newer published image shows a notice whose button asks for the update", async () => {
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

test("shows each image's size and the main disk's free space", async () => {
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
	// A dash on screen, read out as "Not measured yet", as the Docker tab does.
	expect(screen.getByTestId("image-size-2026.09.11").textContent).toBe(
		"—Not measured yet",
	);
	const meter = screen.getByRole("meter", {
		name: "Main disk space",
	}) as HTMLMeterElement;
	expect(meter.value).toBe(15 * 1024 ** 3);
	expect(meter.max).toBe(20 * 1024 ** 3);
	expect(meter.high).toBe(16 * 1024 ** 3);
	expect(meter.getAttribute("aria-valuetext")).toBe(
		"15.0 GB of 20.0 GB used, 5.0 GB free",
	);
	expect(screen.getByTestId("image-disk-free").textContent).toContain(
		"15.0 GB of 20.0 GB used, 5.0 GB free",
	);
	// The row label and the meter's name are the same words.
	expect(screen.getByText("Main disk space").tagName).toBe("DT");
});

test("Delete is off for the default and the previous image, with the reason", async () => {
	stubFetch(() => json(200, data()));
	renderWithQuery(<ImageTab />);
	for (const [version, reason] of [
		["2026.09.10", "The default image is never deleted."],
		["2026.09.9", "Kept so you can roll back."],
	] as const) {
		const button = await screen.findByTestId(`image-delete-${version}`);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		const note = screen.getByText(reason);
		expect(button.getAttribute("aria-describedby")).toBe(note.id);
		fireEvent.click(button);
		expect(screen.queryByTestId("image-confirm")).toBeNull();
	}
});

test("Delete confirms with the workspace count and posts a delete request", async () => {
	let posted = false;
	const deleting = job({ kind: "delete", version: "2026.09.11", request: null });
	const fetch = stubFetch((url, init) => {
		if (init?.method === "POST") {
			posted = true;
			return json(202, { ...deleting, state: "queued" });
		}
		if (url.startsWith("/admin/image/jobs/"))
			return json(200, { job: deleting, log: [] });
		// Once the delete is queued, the row is gone and the job shows.
		return json(
			200,
			posted
				? data({ job: deleting })
				: data({
						images: [
							...data().images.slice(0, 2),
							image("2026.09.11", { workspaces: 4 }),
						],
					}),
		);
	});
	renderWithQuery(<ImageTab />);
	fireEvent.click(await screen.findByTestId("image-delete-2026.09.11"));
	const dialog = await screen.findByTestId("image-confirm");
	expect(dialog.textContent).toContain("Delete image 2026.09.11?");
	expect(dialog.textContent).toContain(
		"4 workspaces were made from this image. They keep working, because each has its own copy of its disk.",
	);
	expect(dialog.textContent).toContain(
		"Deleting it frees about 840 MB on the main disk.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Delete image" }));
	await waitFor(() => {
		const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({
			kind: "delete",
			version: "2026.09.11",
		});
	});
	// The row and its Delete button go; focus goes to the job, not the page body.
	await waitFor(() => expect(screen.queryByTestId("image-confirm")).toBeNull());
	await waitFor(() => expect(document.activeElement?.id).toBe("image-job-title"));
});

test("Delete of an image no workspace was made from says so, and an unmeasured one frees its space", async () => {
	stubFetch(() =>
		json(
			200,
			data({
				images: [
					...data().images.slice(0, 2),
					image("2026.09.11", { workspaces: 0, sizeBytes: null }),
				],
			}),
		),
	);
	renderWithQuery(<ImageTab />);
	fireEvent.click(await screen.findByTestId("image-delete-2026.09.11"));
	const dialog = await screen.findByTestId("image-confirm");
	expect(dialog.textContent).toContain("No workspaces were made from this image.");
	expect(dialog.textContent).not.toContain("They keep working");
	expect(dialog.textContent).toContain("Deleting it frees its space on the main disk.");
});

test("while a job runs, each row action points at the one busy note instead of repeating it", async () => {
	stubFetch((url) =>
		url.startsWith("/admin/image/jobs/")
			? json(200, { job: job(), log: [] })
			: json(
					200,
					data({
						job: job(),
						images: [...data().images.slice(0, 2), image("2026.09.11")],
					}),
				),
	);
	renderWithQuery(<ImageTab />);
	const remove = await screen.findByTestId("image-delete-2026.09.11");
	const make = screen.getByTestId("image-make-default-2026.09.11");
	for (const button of [remove, make]) {
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-describedby")).toBe("image-busy-note");
	}
	expect(
		screen.getAllByText("An image job is waiting or running. Wait until it finishes."),
	).toHaveLength(1);
});
