import type {
	DockerAdminResponse,
	DockerUsageResponse,
	SeedJob,
} from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { DockerTab } from "./DockerTab.js";

afterEach(() => vi.unstubAllGlobals());

const JOB_ID = "22222222-2222-4222-8222-222222222222";

function data(over: Partial<DockerAdminResponse> = {}): DockerAdminResponse {
	return {
		cache: {
			sizeBytes: 20 * 1024 ** 3,
			usedBytes: 5 * 1024 ** 3,
			hubUp: true,
			ghcrEnabled: false,
			ghcrUp: false,
			hubCredentialSet: false,
			lastClearedAt: "2026-09-29T10:00:00.000Z",
			lastClearReason: "full",
			updatedAt: "2026-09-30T10:00:00.000Z",
		},
		ghcrEnabled: false,
		seedMaxGiB: 8,
		hubCredential: { isSet: false },
		seedImages: ["python:3.12", "node:22"],
		seed: {
			images: ["python:3.12"],
			sizeBytes: 1024 ** 3,
			imageVersion: "2026.09.9",
			builtAt: "2026-09-29T09:00:00.000Z",
		},
		...over,
	};
}

function job(over: Partial<SeedJob> = {}): SeedJob {
	return {
		id: JOB_ID,
		state: "running",
		step: "Pulling node:22 (2 of 2)",
		images: ["python:3.12", "node:22"],
		message: null,
		requestedAt: "2026-09-30T10:00:00.000Z",
		finishedAt: null,
		...over,
	};
}

const USAGE: DockerUsageResponse = {
	windowDays: 30,
	notInSeed: [
		{
			image: "docker.io/library/redis:7",
			pulls: 5,
			workspaces: 3,
			lastSeen: "2026-09-30T08:00:00.000Z",
		},
		{
			image: "ghcr.io/owner/tool:1",
			pulls: 1,
			workspaces: 1,
			lastSeen: "2026-09-30T08:00:00.000Z",
		},
	],
	unusedSeed: [
		{
			image: "docker.io/library/node:22",
			pulls: 0,
			workspaces: 2,
			lastSeen: "2026-09-30T07:00:00.000Z",
		},
	],
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Answers the tab's reads; `writes` answers anything else first. */
function serve(admin: DockerAdminResponse, jobs: SeedJob[] = [], writes?: Handler) {
	return stubFetch((url, init) => {
		const written = writes?.(url, init);
		if (written) return written;
		if (url === "/admin/docker") return json(200, admin);
		if (url === "/admin/docker/seed/jobs") return json(200, { jobs });
		if (url === "/admin/docker/usage") return json(200, USAGE);
		if (url === "/admin/image")
			return json(404, { code: "NOT_FOUND", message: "Not found." });
		throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
	});
}

function bodyOf(fetch: ReturnType<typeof stubFetch>, method: string, url: string) {
	const call = fetch.mock.calls.find(
		([u, init]) => String(u) === url && init?.method === method,
	);
	return call ? JSON.parse(String(call[1]?.body ?? "null")) : undefined;
}

test("says the tab is off when the API answers 404", async () => {
	stubFetch(() => json(404, { code: "NOT_FOUND", message: "Not found." }));
	renderWithQuery(<DockerTab />);
	expect(await screen.findByText("The Docker cache is off on this site")).toBeTruthy();
});

test("shows the cache's space, state and last clear", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-cache-use")).textContent).toBe(
		"5.0 GB of 20.0 GB used",
	);
	expect(screen.getByTestId("docker-cache-hub").textContent).toBe("Answering");
	expect(screen.getByTestId("docker-cache-cleared").textContent).toContain(
		"cleared because it was nearly full",
	);
});

test("before the cache reports, the page says so", async () => {
	serve(data({ cache: null }));
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-cache-unknown")).textContent).toContain(
		"has not reported yet",
	);
});

test("Clear cache asks first, then posts", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/cache/clear" && init?.method === "POST"
			? new Response(null, { status: 202 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	fireEvent.click(await screen.findByRole("button", { name: "Clear cache…" }));
	const dialog = await screen.findByTestId("docker-cache-clear-dialog");
	expect(
		fetch.mock.calls.some(([u]) => String(u) === "/admin/docker/cache/clear"),
	).toBe(false);
	fireEvent.click(within(dialog).getByRole("button", { name: "Clear cache" }));
	await waitFor(() =>
		expect(
			fetch.mock.calls.some(([u]) => String(u) === "/admin/docker/cache/clear"),
		).toBe(true),
	);
	await waitFor(() =>
		expect(screen.queryByTestId("docker-cache-clear-dialog")).toBeNull(),
	);
});

test("the account form checks its fields, sends the token once and forgets it", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/hub-credential" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-hub-state")).textContent).toContain(
		"No account is set",
	);
	expect(screen.getByTestId("docker-hub-warning").textContent).toContain(
		"no private repositories",
	);
	expect(screen.getByText(/"Public Repo Read-only" scope/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Save account" }));
	expect(await screen.findByText(/4 to 30 lowercase letters/)).toBeTruthy();
	expect(bodyOf(fetch, "PUT", "/admin/docker/hub-credential")).toBeUndefined();

	const user = screen.getByLabelText("Docker Hub username") as HTMLInputElement;
	const token = screen.getByLabelText("Access token") as HTMLInputElement;
	expect(token.type).toBe("password");
	fireEvent.change(user, { target: { value: "teacher01" } });
	fireEvent.change(token, { target: { value: "fake-token-value" } });
	fireEvent.click(screen.getByRole("button", { name: "Save account" }));
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/hub-credential")).toEqual({
			username: "teacher01",
			token: "fake-token-value",
		}),
	);
	await waitFor(() => expect(token.value).toBe(""));
	expect(user.value).toBe("");
	// isSet still false: the cache has not applied it yet.
	expect(await screen.findByTestId("docker-hub-waiting")).toBeTruthy();
});

test("a set account offers Replace and Remove, and Remove asks first", async () => {
	const fetch = serve(data({ hubCredential: { isSet: true } }), [], (url, init) =>
		url === "/admin/docker/hub-credential" && init?.method === "DELETE"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	expect(await screen.findByRole("button", { name: "Replace account" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Remove account…" }));
	const dialog = await screen.findByTestId("docker-hub-remove-dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove account" }));
	await waitFor(() =>
		expect(
			fetch.mock.calls.some(
				([u, init]) =>
					String(u) === "/admin/docker/hub-credential" && init?.method === "DELETE",
			),
		).toBe(true),
	);
	await waitFor(() => expect(document.activeElement?.id).toBe("docker-hub-title"));
});

test("cancelling Remove account returns focus to the button", async () => {
	serve(data({ hubCredential: { isSet: true } }));
	renderWithQuery(<DockerTab />);
	const opener = await screen.findByRole("button", { name: "Remove account…" });
	opener.focus();
	fireEvent.click(opener);
	const dialog = await screen.findByTestId("docker-hub-remove-dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(screen.queryByTestId("docker-hub-remove-dialog")).toBeNull(),
	);
	await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("a failed removal returns focus to the button, not the heading", async () => {
	serve(data({ hubCredential: { isSet: true } }), [], (url, init) =>
		url === "/admin/docker/hub-credential" && init?.method === "DELETE"
			? json(503, {
					code: "UNAVAILABLE",
					message: "The cache helper is not answering.",
				})
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const opener = await screen.findByRole("button", { name: "Remove account…" });
	opener.focus();
	fireEvent.click(opener);
	const dialog = await screen.findByTestId("docker-hub-remove-dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: "Remove account" }));
	expect(await within(dialog).findByRole("alert")).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(screen.queryByTestId("docker-hub-remove-dialog")).toBeNull(),
	);
	await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("the ghcr.io switch states what breaks and saves both settings", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/settings" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const toggle = await screen.findByRole("switch", { name: "Cache ghcr.io images" });
	expect((toggle as HTMLInputElement).checked).toBe(false);
	const warning = document.getElementById("docker-ghcr-warning")?.textContent ?? "";
	expect(warning).toContain("docker push to ghcr.io");
	expect(warning).toContain("private ghcr.io images");
	expect(warning).toContain("tools other than Docker");
	fireEvent.click(toggle);
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/settings")).toEqual({
			ghcrEnabled: true,
			seedMaxGiB: 8,
		}),
	);
});

test("a saved switch the cache has not applied shows as waiting", async () => {
	serve(data({ ghcrEnabled: true }));
	renderWithQuery(<DockerTab />);
	expect(await screen.findByTestId("docker-ghcr-waiting")).toBeTruthy();
});

test("the seed shows its size, image version and images", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-seed-size")).textContent).toBe("1.0 GB");
	expect(screen.getByTestId("docker-seed-image-version").textContent).toBe("2026.09.9");
	expect(screen.getByTestId("docker-seed-images").textContent).toBe("python:3.12");
	expect(screen.getByTestId("docker-seed-list-count").textContent).toBe("2 of 30");
});

test("adding an image checks it with the contract before saving", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/seed/images" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const input = (await screen.findByLabelText("Image")) as HTMLInputElement;
	fireEvent.change(input, { target: { value: "ghcr.io/owner/tool:1" } });
	fireEvent.click(screen.getByRole("button", { name: "Add image" }));
	expect(
		await screen.findByText("Turn on the ghcr.io cache before seeding ghcr.io images."),
	).toBeTruthy();
	fireEvent.change(input, { target: { value: "docker.io/library/node:22" } });
	fireEvent.click(screen.getByRole("button", { name: "Add image" }));
	expect(await screen.findByText("Each image may appear once.")).toBeTruthy();
	expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toBeUndefined();

	fireEvent.change(input, { target: { value: "postgres:16" } });
	fireEvent.click(screen.getByRole("button", { name: "Add image" }));
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toEqual({
			images: ["python:3.12", "node:22", "postgres:16"],
		}),
	);
});

test("Remove saves the list without that image", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/seed/images" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	fireEvent.click(await screen.findByRole("button", { name: "Remove node:22" }));
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toEqual({
			images: ["python:3.12"],
		}),
	);
});

test("Rebuild seed is off while a rebuild runs, and shows its step", async () => {
	serve(data(), [job()]);
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-seed-job-state")).textContent).toContain(
		"Pulling node:22 (2 of 2)",
	);
	const button = screen.getByTestId("docker-seed-rebuild");
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(
		screen.getByText("A rebuild is waiting or running. Wait until it finishes."),
	).toBeTruthy();
});

test("the latest rebuild region is there before the first rebuild", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const none = await screen.findByTestId("docker-seed-job-none");
	expect(none.closest('[role="status"]')).not.toBeNull();
	expect(none.textContent).toBe("The seed has not been rebuilt yet.");
});

test("Rebuild seed is off with an empty list", async () => {
	serve(data({ seedImages: [] }));
	renderWithQuery(<DockerTab />);
	const button = await screen.findByTestId("docker-seed-rebuild");
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(
		screen.getByText("Add at least one image before rebuilding the seed."),
	).toBeTruthy();
});

test("a failed rebuild shows its reason", async () => {
	serve(data(), [
		job({
			state: "failed",
			step: "Measuring the seed",
			message: "The seed would be 9.2 GiB, over the 8 GiB limit.",
			finishedAt: "2026-09-30T10:10:00.000Z",
		}),
	]);
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-seed-job-message")).textContent).toBe(
		"The seed would be 9.2 GiB, over the 8 GiB limit.",
	);
});

test("Rebuild seed posts a job", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/seed/jobs" && init?.method === "POST"
			? json(202, job({ state: "queued", step: "Waiting to start" }))
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	fireEvent.click(await screen.findByRole("button", { name: "Rebuild seed" }));
	await waitFor(() =>
		expect(
			fetch.mock.calls.some(
				([u, init]) =>
					String(u) === "/admin/docker/seed/jobs" && init?.method === "POST",
			),
		).toBe(true),
	);
});

test("the use report adds a pulled image to the seed and removes an unused one", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/seed/images" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const extra = await screen.findByTestId("docker-usage-extra");
	expect(within(extra).getByRole("rowheader", { name: "redis:7" })).toBeTruthy();
	// ghcr.io is off, so its row says why instead of offering the button.
	expect(within(extra).getByText("Needs the ghcr.io cache on.")).toBeTruthy();
	fireEvent.click(within(extra).getByRole("button", { name: "Add to seed: redis:7" }));
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toEqual({
			images: ["python:3.12", "node:22", "redis:7"],
		}),
	);
	// The pressed button may go; focus waits on the table's heading.
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("docker-usage-extra-title"),
	);

	fetch.mockClear();
	const unused = screen.getByTestId("docker-usage-unused");
	fireEvent.click(
		within(unused).getByRole("button", { name: "Remove from seed: node:22" }),
	);
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toEqual({
			images: ["python:3.12"],
		}),
	);
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("docker-usage-unused-title"),
	);
});

test("an image name from the report is text, never markup (ruling S7)", async () => {
	const usage = {
		...USAGE,
		notInSeed: [{ ...USAGE.notInSeed[0], image: "<b>bold</b>" }],
	};
	stubFetch((url) => {
		if (url === "/admin/docker") return json(200, data());
		if (url === "/admin/docker/seed/jobs") return json(200, { jobs: [] });
		if (url === "/admin/docker/usage") return json(200, usage);
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	renderWithQuery(<DockerTab />);
	const extra = await screen.findByTestId("docker-usage-extra");
	expect(extra.querySelector("b")).toBeNull();
	expect(within(extra).getByText("<b>bold</b>")).toBeTruthy();
});
