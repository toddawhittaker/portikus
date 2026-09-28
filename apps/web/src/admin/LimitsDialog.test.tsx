import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
	incusMemoryMiB,
	LimitsDialog,
	limitDrafts,
	limitsRequest,
	memoryText,
	siteLimits,
} from "./LimitsDialog.js";

test("a blank field sends null, so the workspace uses the profile's value", () => {
	const drafts = limitDrafts({ cpu: 2 });
	expect(drafts).toEqual({ cpu: "2", memoryMiB: "", processes: "" });
	expect(limitsRequest(drafts)).toEqual({
		body: { cpu: 2, memoryMiB: null, processes: null },
	});
	expect(limitDrafts(null)).toEqual({ cpu: "", memoryMiB: "", processes: "" });
});

test("each limit keeps to the bounds the controller takes", () => {
	const ok = { cpu: "64", memoryMiB: "262144", processes: "32768" };
	expect(limitsRequest(ok)).toEqual({
		body: { cpu: 64, memoryMiB: 262144, processes: 32768 },
	});
	expect(limitsRequest({ cpu: "1", memoryMiB: "512", processes: "500" })).toEqual({
		body: { cpu: 1, memoryMiB: 512, processes: 500 },
	});
	expect(limitsRequest({ cpu: "0", memoryMiB: "511", processes: "32769" })).toEqual({
		errors: {
			cpu: "Enter a whole number from 1 to 64, or leave it blank.",
			memoryMiB: "Enter a whole number from 512 to 262144, or leave it blank.",
			processes: "Enter a whole number from 500 to 32768, or leave it blank.",
		},
	});
	expect(limitsRequest({ ...ok, cpu: "1.5" })).toEqual({
		errors: { cpu: "Enter a whole number from 1 to 64, or leave it blank." },
	});
	expect(limitsRequest({ ...ok, cpu: " 4 " })).toEqual({
		body: { cpu: 4, memoryMiB: 262144, processes: 32768 },
	});
});

test("the dialog warns about lowering memory and the terminals' own process limit", () => {
	render(
		<LimitsDialog
			open
			onOpenChange={() => undefined}
			current={null}
			ownerName="Alice Example"
			site={null}
			pending={false}
			serverError={null}
			onSave={() => undefined}
		/>,
	);
	const memory = screen.getByLabelText("Memory (MiB)");
	expect(
		document.getElementById(memory.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Below what the workspace uses now, the kernel stops its largest process.");
	const processes = screen.getByLabelText("Processes");
	expect(
		document.getElementById(processes.getAttribute("aria-describedby") ?? "")
			?.textContent,
	).toBe("Above 1,700, terminals keep their own limit of 1,700.");
	expect(screen.getByLabelText("CPUs")).toBeDefined();
});

test("a server refusal shows in the dialog", () => {
	render(
		<LimitsDialog
			open
			onOpenChange={() => undefined}
			current={{ cpu: 2 }}
			ownerName="Alice Example"
			site={null}
			pending={false}
			serverError="This host has only 4 CPUs."
			onSave={() => undefined}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toBe("This host has only 4 CPUs.");
	expect((screen.getByLabelText("CPUs") as HTMLInputElement).value).toBe("2");
});

test("the site values come from Incus's own spelling of the profile's limits", () => {
	expect(incusMemoryMiB("4GiB")).toBe(4096);
	expect(incusMemoryMiB("4096MiB")).toBe(4096);
	// Incus reads GB as powers of ten.
	expect(incusMemoryMiB("4GB")).toBe(3815);
	expect(incusMemoryMiB("512MB")).toBe(488);
	expect(incusMemoryMiB("50%")).toBeNull();
	expect(incusMemoryMiB(null)).toBeNull();
	expect(incusMemoryMiB("lots")).toBeNull();
	expect(memoryText(4096)).toBe("4,096 MiB (4 GiB)");
	expect(memoryText(3815)).toBe("3,815 MiB (3.7 GiB)");
	expect(memoryText(512)).toBe("512 MiB");
	const host = {
		loadAverage: [0, 0, 0] as [number, number, number],
		cpuCount: 8,
		memory: { usedBytes: 0, totalBytes: 1 },
		pool: { usedBytes: 0, totalBytes: 1, metadataPercent: null },
		profileLimits: { cpu: "0-3", memory: "4GiB", processes: "2000" },
		image: { fingerprint: null, serial: null },
	};
	expect(siteLimits(host)).toEqual({ cpu: 4, memoryMiB: 4096, processes: 2000 });
	expect(
		siteLimits({ ...host, profileLimits: { cpu: null, memory: null, processes: "x" } }),
	).toEqual({ cpu: null, memoryMiB: null, processes: null });
	expect(siteLimits(null)).toBeNull();
});

test("a blank field says what it falls back to, and the dialog names the workspace", () => {
	render(
		<LimitsDialog
			open
			onOpenChange={() => undefined}
			current={null}
			ownerName="Alice Example"
			site={{ cpu: 2, memoryMiB: 4096, processes: 2000 }}
			pending={false}
			serverError={null}
			onSave={() => undefined}
		/>,
	);
	expect(
		screen.getByRole("dialog", { name: "Limits for Alice Example's workspace" }),
	).toBeDefined();
	const processes = screen.getByLabelText("Processes");
	expect(
		document.getElementById(processes.getAttribute("aria-describedby") ?? "")
			?.textContent,
	).toBe("Site value: 2,000. Above 1,700, terminals keep their own limit of 1,700.");
});
