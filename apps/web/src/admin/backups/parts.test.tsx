import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Group, Part } from "./parts.js";

function Removable({ shown, wrap }: { shown: boolean; wrap: "group" | "part" }) {
	const button = shown ? <button type="button">Delete…</button> : null;
	return wrap === "group" ? (
		<Group id="g-title" title="Restores" description="What the group is for.">
			{button}
		</Group>
	) : (
		<Part id="p-title" title="Backup sets">
			{button}
		</Part>
	);
}

test.each([
	["group", 3, "Restores"],
	["part", 4, "Backup sets"],
] as const)(
	"a %s's heading takes focus when the focused row goes away",
	(wrap, level, name) => {
		const { rerender } = render(<Removable shown wrap={wrap} />);
		screen.getByRole("button", { name: "Delete…" }).focus();
		rerender(<Removable shown={false} wrap={wrap} />);
		expect(document.activeElement).toBe(screen.getByRole("heading", { level, name }));
	},
);

test("a group is the shared admin card, with its description", () => {
	render(<Removable shown wrap="group" />);
	const section = screen.getByRole("region", { name: "Restores" });
	expect(section.classList.contains("pk-card")).toBe(true);
	expect(section.textContent).toContain("What the group is for.");
});
