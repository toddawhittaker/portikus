import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FocusCatch, FocusCatchGroup } from "./parts.js";

function Removable({ shown, level }: { shown: boolean; level: 3 | 4 }) {
	const button = shown ? <button type="button">Delete…</button> : null;
	return level === 3 ? (
		<FocusCatchGroup id="g-title" title="Restores" description="What the group is for.">
			{button}
		</FocusCatchGroup>
	) : (
		<FocusCatchGroup id="p-title" level={4} title="Backup sets">
			{button}
		</FocusCatchGroup>
	);
}

test.each([
	[3, "Restores"],
	[4, "Backup sets"],
] as const)(
	"a level %s group's heading takes focus when the focused row goes away",
	(level, name) => {
		const { rerender } = render(<Removable shown level={level} />);
		screen.getByRole("button", { name: "Delete…" }).focus();
		rerender(<Removable shown={false} level={level} />);
		expect(document.activeElement).toBe(screen.getByRole("heading", { level, name }));
	},
);

test("a level 3 group is the shared admin card, with its description", () => {
	render(<Removable shown level={3} />);
	const section = screen.getByRole("region", { name: "Restores" });
	expect(section.classList.contains("pk-card")).toBe(true);
	expect(section.textContent).toContain("What the group is for.");
});

/** One card that becomes two, as Activity does when its first request arrives. */
function Swapping({ split }: { split: boolean }) {
	return (
		<FocusCatch id="restores">
			{split ? (
				<h3 id="restores" tabIndex={-1}>
					Restores
				</h3>
			) : (
				<section>
					<h4 id="restores" tabIndex={-1}>
						Restores
					</h4>
					<button type="button">About Replace home</button>
				</section>
			)}
		</FocusCatch>
	);
}

test("a catch puts focus on the heading that survives a swapped layout", () => {
	const { rerender } = render(<Swapping split={false} />);
	screen.getByRole("button", { name: "About Replace home" }).focus();
	rerender(<Swapping split />);
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { level: 3, name: "Restores" }),
	);
});

test("a catch leaves focus alone when what had it is still there", () => {
	const { rerender } = render(<Swapping split={false} />);
	const button = screen.getByRole("button", { name: "About Replace home" });
	button.focus();
	rerender(<Swapping split={false} />);
	expect(document.activeElement).toBe(button);
});
