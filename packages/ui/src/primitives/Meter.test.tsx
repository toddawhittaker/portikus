import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter, meterText } from "./Meter.js";

describe("Meter", () => {
	it("is a native meter with a name, a value and the value as text", () => {
		render(
			<Meter
				label="Pull cache space"
				value={4}
				max={20}
				valueText="4.0 GB of 20.0 GB used"
			/>,
		);
		const meter = screen.getByRole("meter", { name: "Pull cache space" });
		expect(meter.tagName).toBe("METER");
		expect((meter as HTMLMeterElement).value).toBe(4);
		expect((meter as HTMLMeterElement).max).toBe(20);
		expect(meter.getAttribute("aria-valuetext")).toBe("4.0 GB of 20.0 GB used");
		// The text stays beside the bar, readable and copyable, but is not read twice.
		const text = screen.getByText("4.0 GB of 20.0 GB used");
		expect(text.closest(".pk-meter-text")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("marks a point along the bar, hidden from assistive technology", () => {
		const { container } = render(
			<Meter label="Pull cache space" value={4} max={20} mark={18} valueText="x" />,
		);
		const mark = container.querySelector<HTMLElement>(".pk-meter-mark");
		expect(mark?.getAttribute("aria-hidden")).toBe("true");
		expect(mark?.style.insetInlineStart).toBe("90%");
	});

	it("keeps the mark on the bar, and draws none without one", () => {
		const { container, rerender } = render(
			<Meter label="Seed" value={1} max={8} mark={12} valueText="x" />,
		);
		expect(
			container.querySelector<HTMLElement>(".pk-meter-mark")?.style.insetInlineStart,
		).toBe("100%");
		rerender(<Meter label="Seed" value={1} max={8} valueText="x" />);
		expect(container.querySelector(".pk-meter-mark")).toBeNull();
	});

	it("passes high on, so the fill turns to the warning colour past it", () => {
		render(<Meter label="Seed" value={7} max={8} high={6.4} valueText="x" />);
		expect((screen.getByRole("meter") as HTMLMeterElement).high).toBe(6.4);
	});

	it("past high says nearly full in words and with the alert icon, not by colour alone", () => {
		const { container, rerender } = render(
			<Meter label="Seed size" value={7} max={8} high={6.4} valueText="7 of 8" />,
		);
		const meter = screen.getByRole("meter", { name: "Seed size" });
		expect(meter.getAttribute("aria-valuetext")).toBe("7 of 8, nearly full");
		expect(container.querySelector(".pk-meter-text")?.textContent).toBe(
			"7 of 8, nearly full",
		);
		expect(
			container.querySelector('.pk-meter-text [data-icon="alert"]'),
		).not.toBeNull();
		rerender(
			<Meter label="Seed size" value={6.4} max={8} high={6.4} valueText="6.4 of 8" />,
		);
		// Exactly at high the native meter still draws the normal fill, so no warning yet.
		expect(meter.getAttribute("aria-valuetext")).toBe("6.4 of 8");
		expect(container.querySelector('[data-icon="alert"]')).toBeNull();
		rerender(
			<Meter label="Seed size" value={6} max={8} high={6.4} valueText="6 of 8" />,
		);
		expect(meter.getAttribute("aria-valuetext")).toBe("6 of 8");
		expect(container.querySelector('[data-icon="alert"]')).toBeNull();
		rerender(<Meter label="Seed size" value={7} max={8} valueText="7 of 8" />);
		expect(meter.getAttribute("aria-valuetext")).toBe("7 of 8");
	});

	it("past the limit says over the limit instead of nearly full", () => {
		const { container } = render(
			<Meter label="Seed size" value={9} max={8} high={6.4} valueText="9 of 8" />,
		);
		expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(
			"9 of 8, over the limit",
		);
		expect(container.querySelector(".pk-meter-text")?.textContent).toBe(
			"9 of 8, over the limit",
		);
		expect(
			container.querySelector('.pk-meter-text [data-icon="alert"]'),
		).not.toBeNull();
	});

	it("can take its name from a visible label and a description by id", () => {
		render(
			<>
				<span id="seed-label">Seed size</span>
				<p id="seed-step">Delete old images.</p>
				<Meter
					aria-labelledby="seed-label"
					aria-describedby="seed-step"
					value={1}
					max={8}
					valueText="1 of 8"
				/>
			</>,
		);
		const meter = screen.getByRole("meter", { name: "Seed size" });
		expect(meter.hasAttribute("aria-label")).toBe(false);
		expect(meter.getAttribute("aria-describedby")).toBe("seed-step");
	});

	it("an empty limit still renders a valid meter", () => {
		render(<Meter label="Seed" value={0} max={0} mark={0} valueText="Not known" />);
		const meter = screen.getByRole("meter") as HTMLMeterElement;
		expect(meter.max).toBe(1);
		expect(meter.value).toBe(0);
	});

	it("shortText replaces the visible words only; the meter still reads them all", () => {
		const { container } = render(
			<Meter
				label="Memory"
				value={9}
				max={10}
				high={8}
				valueText="9 of 10"
				shortText="90%"
			/>,
		);
		expect(container.querySelector(".pk-meter-figure")?.textContent).toBe("90%");
		expect(
			screen.getByRole("meter", { name: "Memory" }).getAttribute("aria-valuetext"),
		).toBe("9 of 10, nearly full");
		// Past `high` the alert icon still marks it, so colour is not the only sign.
		expect(
			container.querySelector('.pk-meter-text [data-icon="alert"]'),
		).not.toBeNull();
	});

	it("shortText below `high` shows no alert icon", () => {
		const { container } = render(
			<Meter
				label="Memory"
				value={4}
				max={10}
				high={8}
				valueText="4 of 10"
				shortText="40%"
			/>,
		);
		expect(container.querySelector(".pk-meter-figure")?.textContent).toBe("40%");
		expect(container.querySelector('.pk-meter-text [data-icon="alert"]')).toBeNull();
	});

	it("meterText gives the words the meter shows, for a control that wraps one", () => {
		expect(meterText({ value: 8, max: 10, high: 8, valueText: "8 of 10" })).toBe(
			"8 of 10",
		);
		expect(meterText({ value: 9, max: 10, high: 8, valueText: "9 of 10" })).toBe(
			"9 of 10, nearly full",
		);
		expect(meterText({ value: 11, max: 10, high: 8, valueText: "11 of 10" })).toBe(
			"11 of 10, over the limit",
		);
		const { container } = render(
			<Meter label="Disk" value={9} max={10} high={8} valueText="9 of 10" />,
		);
		expect(container.querySelector(".pk-meter-figure")?.textContent).toBe(
			meterText({ value: 9, max: 10, high: 8, valueText: "9 of 10" }),
		);
	});
});
