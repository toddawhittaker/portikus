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

test("one meter per class, each named by its class with its figure in words", () => {
	render(<StorageMeters storage={{ home: at(10), docker: at(96), recovery: null }} />);

	const home = screen.getByTestId("storage-meter-home");
	expect(home.className).not.toMatch(/pk-meter--/);
	expect(screen.getByTestId("storage-home").textContent).toBe("10.0 GB of 100 GB");
	const homeMeter = screen.getByRole("meter", { name: "Projects and home" });
	expect(homeMeter.getAttribute("aria-valuetext")).toBe("10.0 GB of 100 GB");

	const docker = screen.getByTestId("storage-meter-docker");
	expect(docker.className).toContain("pk-meter--full");
	expect(screen.getByTestId("storage-docker").textContent).toBe(
		"96.0 GB of 100 GB, nearly full",
	);
	expect(
		screen.getByRole("meter", { name: "Docker" }).getAttribute("aria-valuetext"),
	).toBe("96.0 GB of 100 GB, nearly full");

	expect(screen.getByTestId("storage-recovery").textContent).toBe("Not available");
	expect(screen.queryByRole("meter", { name: "Recovery" })).toBeNull();
});

test("a class at 80% gets the warning level", () => {
	render(<StorageMeters storage={{ home: at(80), docker: null, recovery: null }} />);
	expect(screen.getByTestId("storage-meter-home").className).toContain(
		"pk-meter--warning",
	);
	// From exactly 80%, as the level, not only past it.
	expect(screen.getByTestId("storage-home").textContent).toBe(
		"80.0 GB of 100 GB, nearly full",
	);
});
