import type { CodingAgentsFile } from "@portikus/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CodingAgentsSection } from "./CodingAgentsSection.js";

const AGENTS: CodingAgentsFile = {
	claude: { current: "2.1.5", previous: "2.1.4", kept: ["2.1.4", "2.1.5"] },
	codex: { current: "0.46.0", previous: null, kept: ["0.46.0"] },
	updatedAt: "2026-10-10T10:00:00.000Z",
};

function renderSection(over: Partial<Parameters<typeof CodingAgentsSection>[0]> = {}) {
	const submit = vi.fn((_body: unknown, done: () => void) => done());
	render(
		<CodingAgentsSection
			agents={AGENTS}
			busy={false}
			pending={false}
			submit={submit}
			{...over}
		/>,
	);
	return submit;
}

test("shows each tool's version in use and its previous one", () => {
	renderSection();
	const claude = screen.getByTestId("image-agents-row-claude");
	expect(within(claude).getByRole("rowheader").textContent).toBe("Claude Code");
	expect(screen.getByTestId("image-agents-current-claude").textContent).toBe("2.1.5");
	expect(screen.getByTestId("image-agents-previous-claude").textContent).toBe("2.1.4");
	expect(screen.getByTestId("image-agents-current-codex").textContent).toBe("0.46.0");
	expect(screen.getByTestId("image-agents-previous-codex").textContent).toBe("None");
});

test("Update coding agents confirms first, saying open sessions keep their version", () => {
	const submit = renderSection();
	fireEvent.click(screen.getByRole("button", { name: "Update coding agents" }));
	const dialog = screen.getByTestId("image-agents-confirm");
	expect(dialog.textContent).toContain(
		"Students get the new version the next time they start it.",
	);
	expect(dialog.textContent).toContain(
		"Open sessions keep the version they started with.",
	);
	expect(submit).not.toHaveBeenCalled();
	fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
	expect(submit).toHaveBeenCalledWith({ kind: "agents-update" }, expect.any(Function));
	expect(screen.queryByTestId("image-agents-confirm")).toBeNull();
});

test("Roll back sends only its own tool", () => {
	const submit = renderSection();
	fireEvent.click(screen.getByRole("button", { name: "Roll back Claude Code" }));
	const dialog = screen.getByTestId("image-agents-confirm");
	expect(dialog.textContent).toContain("Roll back Claude Code to 2.1.4?");
	fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
	expect(submit).toHaveBeenCalledWith(
		{ kind: "agents-rollback", tool: "claude" },
		expect.any(Function),
	);
});

test("Roll back is off, with its reason, for a tool with no previous version", () => {
	const submit = renderSection();
	const button = screen.getByRole("button", { name: "Roll back Codex" });
	expect(button.getAttribute("aria-disabled")).toBe("true");
	const note = document.getElementById(button.getAttribute("aria-describedby") ?? "");
	expect(note?.textContent).toBe("No previous version.");
	fireEvent.click(button);
	expect(screen.queryByTestId("image-agents-confirm")).toBeNull();
	expect(submit).not.toHaveBeenCalled();
});

test("while an image job runs, every button is off and points at the busy note", () => {
	const submit = renderSection({ busy: true });
	for (const name of ["Update coding agents", "Roll back Claude Code"]) {
		const button = screen.getByRole("button", { name });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-describedby")).toBe("image-busy-note");
		fireEvent.click(button);
	}
	expect(screen.queryByTestId("image-agents-confirm")).toBeNull();
	expect(submit).not.toHaveBeenCalled();
});

test("before setup has written the shared folder, it says how to set it up and offers no actions", () => {
	renderSection({ agents: null });
	expect(screen.getByTestId("image-agents-none").textContent).toContain(
		"sudo portikus setup",
	);
	expect(screen.queryByRole("button")).toBeNull();
});

test("a tool with no version in use says so", () => {
	renderSection({
		agents: { ...AGENTS, codex: { current: null, previous: null, kept: [] } },
	});
	expect(screen.getByTestId("image-agents-current-codex").textContent).toBe(
		"Not installed",
	);
});
