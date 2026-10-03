import type { DockerAdminResponse } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, openToggletip, renderWithQuery, stubFetch } from "../../test-utils.js";
import { DockerTab } from "./DockerTab.js";
import { bodyOf, data, serve, USAGE } from "./test-data.js";

afterEach(() => vi.unstubAllGlobals());

test("says the tab is off when the API answers 404", async () => {
	stubFetch(() => json(404, { code: "NOT_FOUND", message: "Not found." }));
	renderWithQuery(<DockerTab />);
	expect(await screen.findByText("The Docker cache is off on this site")).toBeTruthy();
});

test("shows the cache's space, state and last clear", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const meter = (await screen.findByRole("meter", {
		name: "Pull cache space",
	})) as HTMLMeterElement;
	expect(meter.value).toBe(5 * 1024 ** 3);
	expect(meter.max).toBe(20 * 1024 ** 3);
	expect(meter.getAttribute("aria-valuetext")).toBe("5.0 GB of 20.0 GB used");
	const space = screen.getByTestId("docker-cache-space");
	expect(space.textContent).toContain("5.0 GB of 20.0 GB used");
	// The tick sits at the 90 percent auto-clear point.
	expect(
		space.querySelector<HTMLElement>(".pk-meter-mark")?.style.insetInlineStart,
	).toBe("90%");
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

test("the ghcr.io switch states what breaks and saves only itself", async () => {
	const fetch = serve(data(), [], (url, init) =>
		url === "/admin/docker/settings" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const toggle = await screen.findByRole("switch", { name: "Cache ghcr.io images" });
	expect((toggle as HTMLInputElement).checked).toBe(false);
	// The one thing every admin must see stays visible and describes the switch.
	expect(document.getElementById("docker-ghcr-warning")?.textContent).toBe(
		"While on, workspaces cannot push to ghcr.io.",
	);
	expect(toggle.getAttribute("aria-describedby")).toBe("docker-ghcr-warning");
	// The status line follows the switch directly, before the warning.
	const state = screen.getByTestId("docker-ghcr-state");
	expect(
		toggle.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		state.compareDocumentPosition(
			document.getElementById("docker-ghcr-warning") as Node,
		) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "About the ghcr.io cache" }));
	const tip = openToggletip().textContent;
	expect(tip).toContain("private ghcr.io images");
	expect(tip).toContain("tools other than Docker");
	expect(tip).toContain(
		"Turning it off reaches a running workspace only when it next starts",
	);
	expect(tip).toContain("Build and push images from GitHub Actions; pull them here.");
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
	fireEvent.click(toggle);
	await waitFor(() =>
		expect(bodyOf(fetch, "PUT", "/admin/docker/settings")).toEqual({
			ghcrEnabled: true,
		}),
	);
});

test("a saved switch the cache has not applied shows as waiting", async () => {
	serve(data({ ghcrEnabled: true }));
	renderWithQuery(<DockerTab />);
	expect(await screen.findByTestId("docker-ghcr-waiting")).toBeTruthy();
});

test("the Docker Hub warning sits inside the account form", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const form = await screen.findByRole("form", { name: "Docker Hub account" });
	expect(within(form).getByTestId("docker-hub-warning")).toBeTruthy();
});

test("the grid holds two children: pull cache over ghcr.io, beside Docker Hub; seed and use stay outside it", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const grid = await screen.findByTestId("docker-settings");
	const [stack, hub] = [...grid.children];
	expect(grid.children).toHaveLength(2);
	expect(
		[...(stack?.children ?? [])].map((el) => el.getAttribute("data-testid")),
	).toEqual(["docker-cache", "docker-ghcr"]);
	expect(hub?.getAttribute("data-testid")).toBe("docker-hub");
	expect(grid.contains(screen.getByTestId("docker-seed"))).toBe(false);
	expect(grid.contains(screen.getByTestId("docker-usage"))).toBe(false);
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

test("with no seed and nothing used, image use says so in one sentence", async () => {
	serve(data({ seed: null }), [], (url) =>
		url === "/admin/docker/usage"
			? json(200, {
					windowDays: 120,
					notInSeed: [],
					unusedSeed: [],
					notInSeedTotal: 0,
					unusedSeedTotal: 0,
				})
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	const none = await screen.findByTestId("docker-usage-none");
	expect(none.textContent).toBe("No images used in the last 120 days.");
	const card = within(screen.getByTestId("docker-usage"));
	expect(card.queryAllByRole("heading", { level: 4 })).toEqual([]);
	expect(screen.queryByTestId("docker-usage-window")).toBeNull();
});

test("an image name from the report is text, never markup", async () => {
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

test("the use report shows each image's download size, or a dash read as not known", async () => {
	serve(data());
	renderWithQuery(<DockerTab />);
	const extra = await screen.findByTestId("docker-usage-extra");
	expect(
		within(extra).getByRole("columnheader", { name: "Download size" }),
	).toBeTruthy();
	const redis = within(extra).getByRole("row", { name: /redis:7/ });
	expect(within(redis).getAllByRole("cell")[0]?.textContent).toBe("40.0 MB");
	const tool = within(extra).getByRole("row", { name: /tool:1/ });
	expect(within(tool).getAllByRole("cell")[0]?.textContent).toBe("—Not known");
	const unused = screen.getByTestId("docker-usage-unused");
	const node = within(unused).getByRole("row", { name: /node:22/ });
	expect(within(node).getAllByRole("cell")[0]?.textContent).toBe("—Not known");
	expect(screen.getByTestId("docker-usage-window").textContent).toContain(
		"Over the last 120 days.",
	);
});

const OFF_REASON =
	"When setup last ran, the main disk had 9.5 GiB free, and setup keeps 10 GiB of it free, so not even a 1 GiB cache fits.";

function offData(): DockerAdminResponse {
	const base = data();
	return {
		...base,
		cache: base.cache
			? {
					...base.cache,
					cacheOff: OFF_REASON,
					hubUp: false,
					sizeBytes: 0,
					usedBytes: 0,
				}
			: null,
	};
}

test("when setup turned the cache off, the tab says why and Clear cache does nothing", async () => {
	const fetch = serve(offData());
	renderWithQuery(<DockerTab />);
	const line = await screen.findByTestId("docker-cache-off");
	expect(line.textContent).toContain("Setup turned the pull cache off");
	expect(line.textContent).toContain(OFF_REASON);
	expect(line.textContent).toContain("sudo dpkg-reconfigure portikus");
	expect(screen.queryByRole("meter", { name: "Pull cache space" })).toBeNull();
	expect(screen.queryByTestId("docker-cache-hub")).toBeNull();

	const clear = screen.getByRole("button", { name: "Clear cache…" });
	expect(clear.getAttribute("aria-disabled")).toBe("true");
	expect(clear.getAttribute("aria-describedby")).toBe("docker-cache-off");
	fireEvent.click(clear);
	expect(screen.queryByTestId("docker-cache-clear-dialog")).toBeNull();
	expect(
		fetch.mock.calls.some(([u]) => String(u) === "/admin/docker/cache/clear"),
	).toBe(false);
	expect(screen.getByTestId("docker-ghcr-state").textContent).toBe(
		"The pull cache is off, so workspaces reach ghcr.io directly.",
	);
	expect(screen.queryByTestId("docker-ghcr-down")).toBeNull();
});

test("a Docker Hub account saved while the cache is off does not claim the cache uses it", async () => {
	serve(offData(), [], (url, init) =>
		url === "/admin/docker/hub-credential" && init?.method === "PUT"
			? new Response(null, { status: 204 })
			: undefined,
	);
	renderWithQuery(<DockerTab />);
	fireEvent.change(await screen.findByLabelText("Docker Hub username"), {
		target: { value: "teacher01" },
	});
	fireEvent.change(screen.getByLabelText("Access token"), {
		target: { value: "fake-token-value" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save account" }));
	expect(await screen.findByText("Docker Hub account saved")).toBeTruthy();
	expect(
		screen.getByText(
			"The pull cache is off. It uses the account once setup turns the cache back on.",
		),
	).toBeTruthy();
	expect(screen.queryByText("Docker Hub account sent to the cache")).toBeNull();
});
