/** Opening a preview in its own tab from a link (BROWSER-HANDLING.md §7.2). */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OpenPreviewPage } from "./OpenPreviewPage.js";

const requestGrant = vi.fn();
vi.mock("./grants.js", () => ({
	requestGrant: (...args: unknown[]) => requestGrant(...args),
}));

afterEach(() => {
	cleanup();
	requestGrant.mockReset();
	vi.unstubAllGlobals();
});

test("asks for a tab grant once and goes to its bootstrap URL", async () => {
	const replace = vi.fn();
	vi.stubGlobal("location", { ...window.location, replace });
	requestGrant.mockResolvedValue({
		bootstrapUrl: "https://p.example/__portikus/bootstrap?t=x",
	});
	render(<OpenPreviewPage workspaceId="w1" port={5173} />);
	expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Opening preview");
	expect(document.title).toBe("Opening preview");
	// A polite live region, so a screen reader hears the wait.
	expect(screen.getByRole("status").textContent).toBe("Opening the preview…");
	await waitFor(() =>
		expect(replace).toHaveBeenCalledWith("https://p.example/__portikus/bootstrap?t=x"),
	);
	expect(requestGrant).toHaveBeenCalledTimes(1);
	expect(requestGrant).toHaveBeenCalledWith("w1", 5173, "top-level");
});

test("says so when the grant is refused", async () => {
	requestGrant.mockRejectedValue(new Error("stopped"));
	render(<OpenPreviewPage workspaceId="w1" port={5173} />);
	expect((await screen.findByRole("alert")).textContent).toContain(
		"could not be opened",
	);
	expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Opening preview");
});

test("a bad port asks for nothing", () => {
	render(<OpenPreviewPage workspaceId="w1" port={undefined} />);
	expect(screen.getByRole("alert")).toBeTruthy();
	expect(requestGrant).not.toHaveBeenCalled();
});
