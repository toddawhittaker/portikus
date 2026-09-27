import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	RANGE_STORAGE_KEY,
	RangeControl,
	readStoredRange,
	useHealthRange,
} from "./RangeControl.js";

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

function Harness() {
	const [range, setRange] = useHealthRange();
	return <RangeControl range={range} onChange={setRange} />;
}

test("the range defaults to 1 day and is remembered", () => {
	expect(readStoredRange()).toBe("1d");
	render(<Harness />);
	expect(
		screen.getByRole("button", { name: "1 day" }).getAttribute("aria-pressed"),
	).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "7 days" }));
	expect(
		screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed"),
	).toBe("true");
	expect(localStorage.getItem(RANGE_STORAGE_KEY)).toBe("7d");
	expect(readStoredRange()).toBe("7d");
});

test("an unknown stored value falls back to 1 day", () => {
	localStorage.setItem(RANGE_STORAGE_KEY, "2h");
	expect(readStoredRange()).toBe("1d");
});

test("a browser that refuses storage still switches", () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("denied");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("denied");
	});
	render(<Harness />);
	fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
	expect(
		screen.getByRole("button", { name: "1 hour" }).getAttribute("aria-pressed"),
	).toBe("true");
});
