/** Recovery codes, shown once after enrolment (SPEC.md section 24.13). */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { groupsOfFour } from "./EnrolTotp.js";
import { RecoveryCodes } from "./RecoveryCodes.js";

const CODES = ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function clipboard(writeText: (text: string) => Promise<void>) {
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
}

test("Copy codes puts every code on the clipboard and says so in a status line", async () => {
	const writeText = vi.fn(async () => {});
	clipboard(writeText);
	render(<RecoveryCodes codes={CODES} onDone={() => {}} />);
	const status = screen.getByRole("status");
	// Mounted empty, so the confirmation is announced when it appears.
	expect(status.textContent).toBe("");
	fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
	await waitFor(() => expect(status.textContent).toBe("Codes copied."));
	expect(writeText).toHaveBeenCalledWith("AAAA-BBBB-CCCC-DDDD\nEEEE-FFFF-GGGG-HHHH\n");
});

test("a second Copy press empties the status first, so the same message is announced again", async () => {
	let finish = () => {};
	clipboard(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	render(<RecoveryCodes codes={CODES} onDone={() => {}} />);
	const status = screen.getByRole("status");
	const copy = screen.getByRole("button", { name: "Copy codes" });
	fireEvent.click(copy);
	finish();
	await waitFor(() => expect(status.textContent).toBe("Codes copied."));

	fireEvent.click(copy);
	expect(status.textContent).toBe("");
	finish();
	await waitFor(() => expect(status.textContent).toBe("Codes copied."));
});

test("a refused clipboard says what to do instead", async () => {
	clipboard(async () => {
		throw new Error("denied");
	});
	render(<RecoveryCodes codes={CODES} onDone={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe(
			"Could not copy. Select the codes instead.",
		),
	);
});

test("Download codes saves them as a text file, one per line", async () => {
	let saved: Blob | null = null;
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
		saved = blob as Blob;
		return "blob:codes";
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const names: string[] = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		names.push(this.download);
	});
	render(<RecoveryCodes codes={CODES} onDone={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "Download codes" }));
	expect(names).toEqual(["portikus-recovery-codes.txt"]);
	const blob = saved as Blob | null;
	expect(blob?.type).toBe("text/plain");
	expect(await blob?.text()).toBe("AAAA-BBBB-CCCC-DDDD\nEEEE-FFFF-GGGG-HHHH\n");
});

test("the setup key reads in groups of four", () => {
	expect(groupsOfFour("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
	expect(groupsOfFour("ABCDEF")).toBe("ABCD EF");
	expect(groupsOfFour("")).toBe("");
});
