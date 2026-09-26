import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { meterLevelClass, StorageMeters } from "./StorageMeters.js";

const GB = 1024 ** 3;
const at = (percent: number) => ({ usedBytes: percent * GB, totalBytes: 100 * GB });

test("the level class follows storageLevel's thresholds", () => {
	expect(meterLevelClass(null)).toBe("");
	expect(meterLevelClass("ok")).toBe("");
	expect(meterLevelClass("warning")).toBe("pk-meter--warning");
	expect(meterLevelClass("critical")).toBe("pk-meter--full");
});

test("one meter per class, each with its figure in words and a fill to match", () => {
	render(<StorageMeters storage={{ home: at(10), docker: at(96), recovery: null }} />);

	const home = screen.getByTestId("storage-meter-home");
	expect(home.className).not.toMatch(/pk-meter--/);
	expect(screen.getByTestId("storage-home").textContent).toBe("10.0 GB of 100 GB");
	expect((home.querySelector(".pk-meter-fill") as HTMLElement).style.width).toBe("10%");

	const docker = screen.getByTestId("storage-meter-docker");
	expect(docker.className).toContain("pk-meter--full");
	expect(screen.getByTestId("storage-docker").textContent).toContain(", nearly full");
	// The bar is decoration; the text carries the figure.
	expect(docker.querySelector(".pk-meter-track")?.getAttribute("aria-hidden")).toBe(
		"true",
	);

	expect(screen.getByTestId("storage-recovery").textContent).toBe("Not available");
	expect(
		screen.getByTestId("storage-meter-recovery").querySelector(".pk-meter-track"),
	).toBeNull();
});

test("a class at 80% gets the warning level", () => {
	render(<StorageMeters storage={{ home: at(80), docker: null, recovery: null }} />);
	expect(screen.getByTestId("storage-meter-home").className).toContain(
		"pk-meter--warning",
	);
});
