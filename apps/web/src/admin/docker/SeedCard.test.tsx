import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { DockerTab } from "./DockerTab.js";
import { dockerKey } from "./queries.js";
import { bodyOf, data, job, serve, USAGE } from "./test-data.js";

afterEach(() => vi.unstubAllGlobals());

test("Save limit sends only the seed size limit", async () => {
	const fetch = serve(data({ ghcrEnabled: true }), [], (url, init) =>
		url === "/admin/docker/settings" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const limit = await screen.findByLabelText("Largest seed (GiB)");
	fireEvent.change(limit, { target: { value: "12" } });
	fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/settings")).toEqual({
			seedMaxGiB: 12,
		}),
	);
});

test("the seed shows its size, image version and images", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-seed-size")).textContent).toBe(
		"1.0 GB of the 8.0 GB limit",
	);
	const meter = screen.getByRole("meter", { name: "Seed size" }) as HTMLMeterElement;
	expect(meter.value).toBe(1024 ** 3);
	expect(meter.max).toBe(8 * 1024 ** 3);
	expect(meter.high).toBe(0.8 * 8 * 1024 ** 3);
	expect(screen.getByTestId("docker-seed-image-version").textContent).toBe("2026.09.9");
	const images = screen.getByTestId("docker-seed-images");
	expect(within(images).getByRole("row", { name: /python:3\.12/ }).textContent).toBe(
		"python:3.1260.0 MB",
	);
	expect(screen.getByTestId("docker-seed-list-count").textContent).toBe("2 of 30");
});

test("both meters follow new figures when the tab rereads", async () => {
	let current = data();
	stubFetch((url) => {
		if (url === "/admin/docker") return json(200, current);
		if (url === "/admin/docker/seed/jobs") return json(200, { jobs: [] });
		if (url === "/admin/docker/usage") return json(200, USAGE);
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	const client = renderWithQuery(<DockerTab />);
	const cache = (await screen.findByRole("meter", {
		name: "Pull cache space",
	})) as HTMLMeterElement;
	expect(cache.value).toBe(5 * 1024 ** 3);
	const base = data();
	current = {
		...base,
		cache: base.cache ? { ...base.cache, usedBytes: 9 * 1024 ** 3 } : null,
		seedMaxGiB: 4,
		seed: base.seed ? { ...base.seed, sizeBytes: 3 * 1024 ** 3 } : null,
	};
	await client.invalidateQueries();
	await waitFor(() => expect(cache.value).toBe(9 * 1024 ** 3));
	const seed = screen.getByRole("meter", { name: "Seed size" }) as HTMLMeterElement;
	expect(seed.value).toBe(3 * 1024 ** 3);
	expect(seed.max).toBe(4 * 1024 ** 3);
	expect(screen.getByTestId("docker-seed-size").textContent).toBe(
		"3.0 GB of the 4.0 GB limit",
	);
});

test("the list for the next rebuild shows each image's size, a dash when not known, and the total", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const list = await screen.findByTestId("docker-seed-list");
	expect(
		within(list).getByRole("columnheader", { name: "Download size" }),
	).toBeTruthy();
	const node = within(list).getByRole("row", { name: /node:22/ });
	expect(within(node).getAllByRole("cell")[0]?.textContent).toBe("—Not known");
	expect(screen.getByTestId("docker-seed-list-size").textContent).toBe(
		"These images download as 60.0 MB, not counting 1 image the pull cache has not held. The limit of 8.0 GB counts the unpacked images, which take more space than their download.",
	);
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

test("with no seed and no rebuild the seed card says so in one line, inside the status region", async () => {
	serve(data({ seed: null }));
	renderWithQuery(<DockerTab />);
	const none = await screen.findByTestId("docker-seed-none");
	expect(none.textContent).toBe("No seed yet, so new Docker storage starts empty.");
	expect(none.closest('[role="status"]')).not.toBeNull();
	const card = within(screen.getByTestId("docker-seed"));
	expect(card.queryByRole("heading", { level: 4, name: "Current seed" })).toBeNull();
	expect(card.queryByRole("heading", { level: 4, name: "Latest rebuild" })).toBeNull();
	expect(screen.queryByTestId("docker-seed-job-none")).toBeNull();
});

test("with no seed but a rebuild, the card shows the rebuild and not the empty line", async () => {
	serve(data({ seed: null }), [job()]);
	renderWithQuery(<DockerTab />);
	await screen.findByTestId("docker-seed-job-state");
	const card = within(screen.getByTestId("docker-seed"));
	expect(card.getByRole("heading", { level: 4, name: "Latest rebuild" })).toBeTruthy();
	expect(card.queryByRole("heading", { level: 4, name: "Current seed" })).toBeNull();
	expect(screen.queryByTestId("docker-seed-none")).toBeNull();
});

test("the size limit sits in its own row under the image list, as wide as the image field", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const limit = await screen.findByLabelText("Largest seed (GiB)");
	const add = screen.getByLabelText("Image", { exact: true });
	expect(
		add.compareDocumentPosition(limit) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(limit.closest(".pk-field")?.classList.contains("w-72")).toBe(true);
	expect(add.closest(".pk-field")?.classList.contains("w-72")).toBe(true);
});

test("Rebuild seed is off with an empty list", async () => {
	serve(data({ seedImages: [] }));
	renderWithQuery(<DockerTab />);
	const button = await screen.findByTestId("docker-seed-rebuild");
	expect(button.getAttribute("aria-disabled")).toBe("true");
	const note = screen.getByText("Add at least one image before rebuilding the seed.");
	// The reason sits with the button in the card's actions, and stays its description.
	expect(button.getAttribute("aria-describedby")).toBe(note.id);
	expect(note.parentElement?.contains(button)).toBe(true);
});

test("a finished rebuild says Finished once, without its last step", async () => {
	serve(data(), [
		job({ state: "succeeded", step: "Done", finishedAt: "2026-09-30T10:10:00.000Z" }),
	]);
	renderWithQuery(<DockerTab />);
	expect((await screen.findByTestId("docker-seed-job-state")).textContent).toBe(
		"Finished",
	);
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
	// A failure keeps the step it stopped at.
	expect(screen.getByTestId("docker-seed-job-state").textContent).toBe(
		"Failed Measuring the seed",
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

const MATCH_26_314 = {
	node: { version: "26", image: "node:26-slim" },
	python: { version: "3.14", image: "python:3.14-slim" },
};

test("no drift notice when the list holds the matching images", async () => {
	serve(
		data({ seedImages: ["node:26-slim", "python:3.14-slim"], match: MATCH_26_314 }),
	);
	renderWithQuery(<DockerTab />);
	await screen.findByTestId("docker-seed-list");
	expect(screen.queryByTestId("docker-seed-drift")).toBeNull();
});

test("the drift notice's button posts the match, starts a rebuild and keeps focus in place", async () => {
	const fetch = serve(
		data({ seedImages: ["node:24-slim", "python:3.13-slim"], match: MATCH_26_314 }),
		[],
		(url, init) =>
			url === "/admin/docker/seed/match" && init?.method === "POST"
				? json(
						202,
						job({ state: "queued", images: ["node:26-slim", "python:3.14-slim"] }),
					)
				: undefined,
	);
	renderWithQuery(<DockerTab />);
	const notice = await screen.findByTestId("docker-seed-drift");
	expect(notice.textContent).toContain(
		"The default workspace image runs Node 26 and Python 3.14, but the seed list has node:24-slim and python:3.13-slim.",
	);
	expect(notice.textContent).toContain(
		"Updating replaces node:24-slim with node:26-slim and python:3.13-slim with python:3.14-slim, then rebuilds the seed.",
	);
	// Image names read as code, like the tables around the notice.
	expect(within(notice).getByText("node:26-slim").tagName).toBe("CODE");
	// It sits under the heading of the list it changes.
	const list = screen.getByRole("region", { name: /Images for the next rebuild/ });
	expect(list.contains(notice)).toBe(true);
	fireEvent.click(
		within(notice).getByRole("button", { name: "Update list and rebuild" }),
	);
	await waitFor(() =>
		expect(
			fetch.mock.calls.some(
				([u, init]) =>
					String(u) === "/admin/docker/seed/match" && init?.method === "POST",
			),
		).toBe(true),
	);
	// Nothing else writes the list.
	expect(bodyOf(fetch, "PUT", "/admin/docker/seed/images")).toBeUndefined();
	// The notice and its button go; focus lands on the list it changed.
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("docker-seed-list-title"),
	);
});

test("the drift notice's toast and focus survive a reread that removes the notice", async () => {
	// The list is rewritten as soon as the match arrives; the answer comes later.
	let matched = false;
	let answer: (response: Response) => void = () => {};
	stubFetch((url, init) => {
		if (url === "/admin/docker/seed/match" && init?.method === "POST") {
			matched = true;
			// stubFetch awaits whatever the handler returns.
			return new Promise<Response>((resolve) => {
				answer = resolve;
			}) as unknown as Response;
		}
		if (url === "/admin/docker")
			return json(
				200,
				data({
					seedImages: matched
						? ["node:26-slim", "python:3.14-slim"]
						: ["node:24-slim", "python:3.13-slim"],
					match: MATCH_26_314,
				}),
			);
		if (url === "/admin/docker/seed/jobs") return json(200, { jobs: [] });
		if (url === "/admin/docker/usage") return json(200, USAGE);
		return json(404, { code: "NOT_FOUND", message: "Not found." });
	});
	const client = renderWithQuery(<DockerTab />);
	const notice = await screen.findByTestId("docker-seed-drift");
	fireEvent.click(
		within(notice).getByRole("button", { name: "Update list and rebuild" }),
	);
	await waitFor(() => expect(matched).toBe(true));
	// Another reread lands first and takes the notice away.
	await client.invalidateQueries({ queryKey: dockerKey });
	await waitFor(() => expect(screen.queryByTestId("docker-seed-drift")).toBeNull());
	answer(json(202, job({ state: "queued" })));
	expect(await screen.findByText("Seed list updated, rebuild requested")).toBeTruthy();
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("docker-seed-list-title"),
	);
});

test("over the size limit the notice says so and offers no button", async () => {
	serve(
		data({
			seedMaxGiB: 1,
			seedImages: ["python:3.12"],
			imageSizes: { "docker.io/library/python:3.12": 1024 ** 3 },
			match: MATCH_26_314,
		}),
	);
	renderWithQuery(<DockerTab />);
	const notice = await screen.findByTestId("docker-seed-drift");
	expect(within(notice).getByTestId("docker-seed-drift-over").textContent).toBe(
		"Using node:26-slim and python:3.14-slim would take the list past the 1.0 GB limit. That is an estimate from download sizes; the rebuild checks the unpacked images, which are larger. Raise Largest seed below, or remove images from the list.",
	);
	expect(within(notice).queryByRole("button")).toBeNull();
});

test("a seed built from an older image says so once: the drift notice's rebuild covers it", async () => {
	const image = (url: string) =>
		url === "/admin/image"
			? json(200, {
					default: "2026.09.10",
					previous: null,
					images: [],
					otherWorkspaces: 0,
					job: null,
					newerPublished: null,
					disk: null,
				})
			: undefined;
	serve(
		data({ seedImages: ["node:26-slim", "python:3.14-slim"], match: MATCH_26_314 }),
		[],
		image,
	);
	renderWithQuery(<DockerTab />);
	expect(await screen.findByTestId("docker-seed-stale")).toBeTruthy();
	cleanup();
	vi.unstubAllGlobals();

	serve(
		data({ seedImages: ["node:24-slim", "python:3.13-slim"], match: MATCH_26_314 }),
		[],
		image,
	);
	renderWithQuery(<DockerTab />);
	await screen.findByTestId("docker-seed-drift");
	expect(screen.queryByTestId("docker-seed-stale")).toBeNull();
});
