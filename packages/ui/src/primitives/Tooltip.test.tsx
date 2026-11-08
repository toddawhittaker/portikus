import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { skipTooltipOnReturnedFocus, Tooltip } from "./Tooltip.js";

describe("Tooltip", () => {
	it("opens when its trigger takes keyboard focus", async () => {
		render(
			<Tooltip content="Effort High">
				<button type="button">High</button>
			</Tooltip>,
		);
		act(() => screen.getByRole("button", { name: "High" }).focus());
		expect((await screen.findByRole("tooltip")).textContent).toBe("Effort High");
	});

	it("describes the trigger", async () => {
		render(
			<Tooltip content="First">
				<button type="button">One</button>
			</Tooltip>,
		);
		const one = screen.getByRole("button", { name: "One" });
		act(() => one.focus());
		const tip = await screen.findByRole("tooltip");
		expect(one.getAttribute("aria-describedby")).toBe(tip.id);
	});

	it("adds no description to a trigger when decorative", async () => {
		render(
			<Tooltip content="Second" decorative={true}>
				<button type="button">Two</button>
			</Tooltip>,
		);
		const two = screen.getByRole("button", { name: "Two" });
		act(() => two.focus());
		const tip = await screen.findByText("Second");
		expect(tip.closest("[aria-hidden='true']")).not.toBeNull();
		const described = (two.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join("")
			.trim();
		expect(described).toBe("");
	});

	it("stays closed while open is false, whatever the focus does", async () => {
		render(
			<Tooltip content="Never" open={false}>
				<button type="button">Quiet</button>
			</Tooltip>,
		);
		act(() => screen.getByRole("button", { name: "Quiet" }).focus());
		await Promise.resolve();
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	// Focus handed back by a closing menu must not pop the name up.
	it("keeps its tooltip closed for focus a menu hands back", async () => {
		render(
			<Tooltip content="Back">
				<button type="button">Trigger</button>
			</Tooltip>,
		);
		const button = screen.getByRole("button", { name: "Trigger" });
		act(() => {
			skipTooltipOnReturnedFocus();
			button.focus();
		});
		await Promise.resolve();
		expect(document.activeElement).toBe(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});
