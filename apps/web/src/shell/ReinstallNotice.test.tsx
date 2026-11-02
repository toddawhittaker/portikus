import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import {
	REINSTALL_LEAD,
	ReinstallNotice,
	reinstallAnnouncement,
} from "./ReinstallNotice.js";

afterEach(() => vi.unstubAllGlobals());

const ID = "11111111-1111-4111-8111-111111111111";

test("the title is one sentence ending with each package in code style", async () => {
	stubFetch(() => json(200, { packages: ["python3-venv", "htop", "jq"] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	const title = await screen.findByTestId("reinstall-title");
	expect(title.textContent).toBe(`${REINSTALL_LEAD}: python3-venv, htop, jq.`);
	expect([...title.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
		"python3-venv",
		"htop",
		"jq",
	]);
	expect(screen.getByTestId("reinstall-command").textContent).toBe(
		"sudo apt install python3-venv htop jq",
	);
});

test("one package reads as a sentence with no comma", async () => {
	stubFetch(() => json(200, { packages: ["htop"] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	const title = await screen.findByTestId("reinstall-title");
	expect(title.textContent).toBe(`${REINSTALL_LEAD}: htop.`);
	expect(title.querySelectorAll("code")).toHaveLength(1);
});

test("the visible title and the status announcement say the same words", async () => {
	const packages = ["file", "htop"];
	stubFetch(() => json(200, { packages }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	const title = await screen.findByTestId("reinstall-title");
	expect(title.textContent).toBe(reinstallAnnouncement(packages));
});

test("nothing shows when nothing was removed", async () => {
	const fetch = stubFetch(() => json(200, { packages: [] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	await waitFor(() => expect(fetch).toHaveBeenCalled());
	expect(screen.queryByTestId("reinstall-notice")).toBeNull();
});

test("a first 503 while the agent starts is retried, and the notice shows", async () => {
	let calls = 0;
	stubFetch(() => {
		calls += 1;
		return calls === 1
			? json(503, { error: { code: "AGENT_UNAVAILABLE", message: "Starting." } })
			: json(200, { packages: ["htop"] });
	});
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	expect(
		await screen.findByTestId("reinstall-title", {}, { timeout: 4000 }),
	).toBeTruthy();
	expect(calls).toBe(2);
});

test("the announcement names the removed packages, and nothing when none", () => {
	expect(reinstallAnnouncement(["htop", "jq"])).toBe(`${REINSTALL_LEAD}: htop, jq.`);
	expect(reinstallAnnouncement([])).toBe("");
});

test("a stopped workspace is not asked", () => {
	const fetch = stubFetch(() => json(200, { packages: ["htop"] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running={false} />);
	expect(fetch).not.toHaveBeenCalled();
	expect(screen.queryByTestId("reinstall-notice")).toBeNull();
});

test("the copy icon button has a name, is a native button, and copies the line", async () => {
	stubFetch(() => json(200, { packages: ["htop"] }));
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	const copy = await screen.findByRole("button", { name: "Copy command" });
	expect(copy.tagName).toBe("BUTTON");
	// No separate text button remains beside the icon.
	expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1);
	copy.focus();
	expect(document.activeElement).toBe(copy);
	fireEvent.click(copy);
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("sudo apt install htop"));
	expect(await screen.findByText("Command copied")).toBeTruthy();
});

test("a refused clipboard says to select the command instead", async () => {
	stubFetch(() => json(200, { packages: ["htop"] }));
	const writeText = vi.fn(async () => {
		throw new Error("denied");
	});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));
	expect(
		await screen.findByText("Could not copy. Select the command instead."),
	).toBeTruthy();
});

test("dismiss asks the workspace, hides the notice and moves focus", async () => {
	const fetch = stubFetch((_url, init) => {
		if (init?.method === "POST") return new Response(null, { status: 204 });
		return json(200, { packages: ["htop"] });
	});
	const main = document.createElement("main");
	main.tabIndex = -1;
	document.body.appendChild(main);
	const ref = createRef<HTMLElement>();
	(ref as { current: HTMLElement }).current = main;
	renderWithQuery(<ReinstallNotice workspaceId={ID} running fallbackFocus={ref} />);

	fireEvent.click(
		await screen.findByRole("button", { name: "Dismiss the reinstall notice" }),
	);

	await waitFor(() => expect(screen.queryByTestId("reinstall-notice")).toBeNull());
	expect(fetch).toHaveBeenCalledWith(
		`/workspaces/${ID}/reinstall-note/dismiss`,
		expect.objectContaining({ method: "POST" }),
	);
	expect(document.activeElement).toBe(main);
	main.remove();
});

test("the copy icon is always shown on any touch pointer, and on hover or focus otherwise", async () => {
	stubFetch(() => json(200, { packages: ["htop"] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	const wrap = await screen.findByTestId("reinstall-copy-wrap");
	const classes = wrap.className.split(/\s+/);
	expect(classes).toContain("opacity-0");
	expect(classes).toContain("group-hover:opacity-100");
	expect(classes).toContain("group-focus-within:opacity-100");
	// A touchscreen laptop's primary pointer is the trackpad, so (hover: none) alone misses it.
	expect(classes).toContain("[@media(hover:none),(any-pointer:coarse)]:opacity-100");
});
