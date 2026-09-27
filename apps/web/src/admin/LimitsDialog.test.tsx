import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { LimitsDialog, limitDrafts, limitsRequest } from "./LimitsDialog.js";

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
			pending={false}
			serverError="This host has only 4 CPUs."
			onSave={() => undefined}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toBe("This host has only 4 CPUs.");
	expect((screen.getByLabelText("CPUs") as HTMLInputElement).value).toBe("2");
});
