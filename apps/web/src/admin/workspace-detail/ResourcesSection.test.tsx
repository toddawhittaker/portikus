/**
 * The admin detail panel's storage meters colour usage at the student's
 * storageLevel thresholds, so an administrator and the student see the same
 * warning for the same figures (SPEC.md §19.2, §20.1).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { STORAGE_CLASSES, storageLevel } from "../../recovery/storage.js";
import { AdminStorageMeters } from "./ResourcesSection.js";

afterEach(cleanup);

const LIMIT = 1000;

test.each([
	[799, 800, 950],
	[800, 949, 1000],
	[0, 950, 1200],
])(
	"home %i, Docker %i and Recovery %i of 1000 take storageLevel's levels",
	(home, docker, recovery) => {
		const storage = {
			home: { usedBytes: home, limitBytes: LIMIT },
			docker: { usedBytes: docker, limitBytes: LIMIT },
			recovery: { usedBytes: recovery, limitBytes: LIMIT },
		};
		render(<AdminStorageMeters storage={storage} ownerName="Alice" />);

		for (const storageClass of STORAGE_CLASSES) {
			const level = storageLevel({
				usedBytes: storage[storageClass].usedBytes,
				totalBytes: LIMIT,
			});
			expect(screen.getByTestId(`storage-meter-${storageClass}`).dataset.level).toBe(
				level,
			);
		}
	},
);

test("the thresholds are the student's: warning from 80%, critical from 95%", () => {
	render(
		<AdminStorageMeters
			storage={{
				home: { usedBytes: 799, limitBytes: LIMIT },
				docker: { usedBytes: 800, limitBytes: LIMIT },
				recovery: { usedBytes: 950, limitBytes: LIMIT },
			}}
			ownerName="Alice"
		/>,
	);
	expect(screen.getByTestId("storage-meter-home").dataset.level).toBe("ok");
	expect(screen.getByTestId("storage-meter-docker").dataset.level).toBe("warning");
	expect(screen.getByTestId("storage-meter-recovery").dataset.level).toBe("critical");
	// The Meter's words follow the same line: "nearly full" from 80%.
	expect(
		screen.getByRole("meter", { name: "Docker" }).getAttribute("aria-valuetext"),
	).toMatch(/nearly full$/);
	expect(
		screen
			.getByRole("meter", { name: "Projects and home" })
			.getAttribute("aria-valuetext"),
	).not.toMatch(/nearly full/);
});
