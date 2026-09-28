import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import {
	REINSTALL_TITLE,
	ReinstallNotice,
	reinstallAnnouncement,
} from "./ReinstallNotice.js";

afterEach(() => vi.unstubAllGlobals());

const ID = "11111111-1111-4111-8111-111111111111";

test("lists the removed packages and the line that puts them back", async () => {
	stubFetch((url) => {
		if (url === `/workspaces/${ID}/reinstall-note`) {
			return json(200, { packages: ["python3-venv", "htop"] });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	expect(await screen.findByText(REINSTALL_TITLE)).toBeTruthy();
	expect(screen.getByTestId("reinstall-packages").textContent).toBe(
		"python3-venv, htop",
	);
	expect(screen.getByTestId("reinstall-command").textContent).toBe(
		"sudo apt install python3-venv htop",
	);
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
	expect(await screen.findByText(REINSTALL_TITLE, {}, { timeout: 4000 })).toBeTruthy();
	expect(calls).toBe(2);
});

test("the announcement names the removed packages, and nothing when none", () => {
	expect(reinstallAnnouncement(["htop", "jq"])).toBe(`${REINSTALL_TITLE}: htop, jq.`);
	expect(reinstallAnnouncement([])).toBe("");
});

test("a stopped workspace is not asked", () => {
	const fetch = stubFetch(() => json(200, { packages: ["htop"] }));
	renderWithQuery(<ReinstallNotice workspaceId={ID} running={false} />);
	expect(fetch).not.toHaveBeenCalled();
	expect(screen.queryByTestId("reinstall-notice")).toBeNull();
});

test("Copy command puts the line on the clipboard", async () => {
	stubFetch(() => json(200, { packages: ["htop"] }));
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	renderWithQuery(<ReinstallNotice workspaceId={ID} running />);
	fireEvent.click(await screen.findByTestId("reinstall-copy"));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("sudo apt install htop"));
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
