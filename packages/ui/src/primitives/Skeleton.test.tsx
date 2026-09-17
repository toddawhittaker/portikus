import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./Skeleton.js";

describe("Skeleton", () => {
	it("renders one bar and hides it from assistive technology", () => {
		const { container } = render(<Skeleton width="40%" />);
		const bar = container.firstElementChild as HTMLElement;
		expect(bar.getAttribute("aria-hidden")).toBe("true");
		expect(bar.style.width).toBe("40%");
	});

	it("renders a paragraph of bars, the last one short", () => {
		const { container } = render(<Skeleton lines={3} />);
		const bars = [...container.querySelectorAll(".pk-skel")] as HTMLElement[];
		expect(bars).toHaveLength(3);
		expect(bars.at(-1)?.style.width).toBe("60%");
	});
});
