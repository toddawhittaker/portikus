import { NOTIFY_FILE_OFF, notificationSettingsView } from "@portikus/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const GIB = 1024 ** 3;

const SETTINGS = {
	shutdownGraceSeconds: 600,
	logLevel: null,
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 5,
	cpuIdleLiftPercent: 10,
	cpuThrottleHoldAfter: 3,
	cpuThrottleHoldHours: 24,
	keepRunningMaxHours: 12,
	voiceInputEnabled: true,
	codeHelpLanguages: ["python", "typescript"],
	accountEmailEnabled: false,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
	updatedAt: "2026-10-14T15:02:00.000Z",
};

/** The Health report the estimate reads the server's memory from. */
function health(totalBytes: number | null) {
	return {
		sampledAt: "2026-10-14T15:00:00.000Z",
		workerStale: false,
		packageUpdate: null,
		controller: { reachable: true, errorCode: null },
		host:
			totalBytes === null
				? null
				: {
						loadAverage: [0.5, 0.4, 0.3],
						cpuCount: 8,
						memory: { usedBytes: 4 * GIB, totalBytes },
						pool: { usedBytes: 50 * GIB, totalBytes: 100 * GIB, metadataPercent: 20 },
						profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
						image: { fingerprint: null, serial: null },
					},
		workspacesByState: {},
		agents: { answering: 0, running: 0 },
		last24h: {
			startFailures: 0,
			stopFailures: 0,
			forcedStops: 0,
			provisionFailures: 0,
			controllerOutages: 0,
			signInFailures: 0,
			previewRefusals: 0,
		},
		guard: [],
	};
}

/**
 * Answers the Settings tab's reads; each PUT of the settings lands in
 * `writes`, and `put` decides its answer.
 */
function stubSettings({
	settings = SETTINGS,
	memory = 16 * GIB,
	healthGate,
	put,
}: {
	settings?: Record<string, unknown> | null;
	memory?: number | null;
	/** Holds the Health answer back until it resolves. */
	healthGate?: Promise<void>;
	put?: (body: Record<string, unknown>) => Response;
} = {}) {
	const writes: Record<string, unknown>[] = [];
	let current = settings;
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/admin/root-shell") return json(200, { enabled: false });
		if (url === "/admin/health") {
			return healthGate
				? healthGate.then(() => json(200, health(memory)))
				: json(200, health(memory));
		}
		if (url === "/admin/settings" && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			writes.push(body);
			if (put) return put(body);
			current = { ...current, ...body, updatedAt: "2026-10-21T09:00:00.000Z" };
			return json(200, current);
		}
		if (url === "/admin/settings") {
			return current
				? json(200, current)
				: json(500, { code: "INTERNAL", message: "The server did not answer." });
		}
		if (url === "/admin/notifications")
			return json(200, {
				settings: notificationSettingsView(NOTIFY_FILE_OFF),
				job: null,
				storedFileUnreadable: false,
			});
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

/** The text of every element an element's aria-describedby names, in order. */
function describedBy(element: HTMLElement): string {
	return (element.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent?.trim())
		.join(" ");
}

const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

async function openSettings() {
	renderApp("/admin/settings");
	await waitFor(() => expect(input("settings-idleStopMinutes").value).toBe("60"));
}

describe("the page", () => {
	test("is five sections in order, each with a link in the index", async () => {
		stubSettings();
		await openSettings();

		const column = screen.getByTestId("settings-sections");
		const headings = within(column)
			.getAllByRole("heading", { level: 3 })
			.map((heading) => heading.textContent);
		expect(headings).toEqual([
			"When workspaces stop",
			"Resource guard",
			"Student tools",
			"Acceptable use",
			"Email and alerts",
		]);
		const index = screen.getByRole("navigation", { name: "Settings sections" });
		for (const link of within(index).getAllByRole("link")) {
			const target = document.getElementById(
				(link.getAttribute("href") ?? "").slice(1),
			);
			expect(target?.tagName).toBe("H3");
			expect(target?.textContent).toBe(link.textContent);
		}
		// One Save per section, named for it.
		expect(
			within(column)
				.getAllByRole("button", { name: /^Save/ })
				.map((button) => button.textContent),
		).toEqual([
			"Save stop times",
			"Save resource guard",
			"Save student tools",
			"Save and ask everyone to accept",
			"Save email and alerts",
		]);
		// No toggletips on this page; each row says what it does in a sentence.
		expect(screen.queryByRole("button", { name: /^About / })).toBeNull();
		expect(screen.queryByTestId("log-level-select")).toBeNull();
	});

	test("says once when the settings last changed, from the saved row", async () => {
		stubSettings();
		await openSettings();
		const line = screen.getByTestId("settings-last-changed");
		expect(line.textContent).toMatch(/^Last changed /);
		expect(line.querySelector("time")?.getAttribute("dateTime")).toBe(
			SETTINGS.updatedAt,
		);
	});

	test("shows nothing for a site whose settings never changed", async () => {
		stubSettings({ settings: { ...SETTINGS, updatedAt: null } });
		await openSettings();
		expect(screen.getByTestId("settings-last-changed").textContent).toBe("");
	});

	test("a failed read says so in each section and offers to load again", async () => {
		stubSettings({ settings: null });
		renderApp("/admin/settings");
		const stop = await screen.findByTestId("settings-stop");
		await within(stop).findByText(/These settings could not be loaded\./);
		expect(within(stop).getByRole("alert").textContent).toContain(
			"The server did not answer. Nothing has been changed.",
		);
		// Only one section announces the failure the others share.
		const guard = screen.getByTestId("settings-guard");
		expect(within(guard).getByText(/could not be loaded/)).toBeDefined();
		expect(within(guard).queryByRole("alert")).toBeNull();
		expect(within(stop).getByRole("button", { name: "Load again" })).toBeDefined();
	});
});

describe("When workspaces stop", () => {
	test("each row has its unit and its default in the field's description", async () => {
		stubSettings();
		await openSettings();
		const idle = screen.getByRole("textbox", { name: "Idle stop" });
		const described = (idle.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent);
		expect(described[0]).toBe("minutes");
		expect(described.join(" ")).toContain("Still working?");
		expect(described.join(" ")).toContain("Default 60 minutes; 10 to 1,440.");
		expect(screen.getByRole("textbox", { name: "Disconnect grace" })).toBe(
			input("settings-shutdownGraceSeconds"),
		);
		expect(input("settings-shutdownGraceSeconds").value).toBe("10");
		expect(screen.getByRole("textbox", { name: "Longest keep running" })).toBeDefined();
	});

	test("nothing saves on a change; the row and footer say what is not saved", async () => {
		const writes = stubSettings();
		await openSettings();
		const stop = screen.getByTestId("settings-stop");
		expect(screen.getByTestId("settings-stop-state").textContent).toBe(
			"No unsaved changes.",
		);
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "45" } });
		expect(within(stop).getByText("Not saved. Was 60 minutes.")).toBeDefined();
		expect(screen.getByTestId("settings-stop-state").textContent).toBe(
			"1 unsaved change",
		);
		expect(within(stop).getByRole("button", { name: "Discard changes" })).toBeDefined();
		expect(writes).toEqual([]);
	});

	test("Save sends only the changed fields, the grace in seconds, then says Saved", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-shutdownGraceSeconds"), {
			target: { value: "90" },
		});
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "45" } });
		expect(screen.getByTestId("settings-stop-state").textContent).toBe(
			"2 unsaved changes",
		);
		fireEvent.click(screen.getByRole("button", { name: "Save stop times" }));
		await waitFor(() =>
			expect(screen.getByTestId("settings-stop-state").textContent).toBe("Saved."),
		);
		expect(writes).toEqual([{ shutdownGraceSeconds: 5400, idleStopMinutes: 45 }]);
		expect(input("settings-idleStopMinutes").value).toBe("45");
		expect(screen.queryByText(/Not saved\. Was/)).toBeNull();
	});

	test("a bad value is named under its field and in the footer, and takes focus", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-shutdownGraceSeconds"), {
			target: { value: "15" },
		});
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "5" } });
		fireEvent.click(screen.getByRole("button", { name: "Save stop times" }));
		const idle = input("settings-idleStopMinutes");
		await waitFor(() => expect(document.activeElement).toBe(idle));
		expect(idle.getAttribute("aria-invalid")).toBe("true");
		expect(document.getElementById("settings-idleStopMinutes-err")?.textContent).toBe(
			"Enter 0 to turn idle stop off, or a whole number from 10 to 1,440.",
		);
		expect(screen.getByTestId("settings-stop-state").textContent).toBe(
			"Not saved. 2 unsaved changes; fix Idle stop and save again.",
		);
		// The other edit is kept.
		expect(input("settings-shutdownGraceSeconds").value).toBe("15");
		expect(writes).toEqual([]);

		fireEvent.change(idle, { target: { value: "0" } });
		expect(idle.getAttribute("aria-invalid")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Save stop times" }));
		await waitFor(() =>
			expect(writes).toEqual([{ shutdownGraceSeconds: 900, idleStopMinutes: 0 }]),
		);
	});

	test("a grace beyond the database's integer is refused before any request", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-shutdownGraceSeconds"), {
			target: { value: "35791395" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save stop times" }));
		expect(
			await screen.findByText("Enter a number of minutes, 0 or more."),
		).toBeDefined();
		expect(writes).toEqual([]);
	});

	test("a save the server refuses keeps the edits and says why in the footer", async () => {
		stubSettings({
			put: () =>
				json(400, { code: "VALIDATION_FAILED", message: "The settings were refused." }),
		});
		await openSettings();
		fireEvent.change(input("settings-keepRunningMaxHours"), {
			target: { value: "24" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save stop times" }));
		await waitFor(() =>
			expect(screen.getByTestId("settings-stop-state").textContent).toBe(
				"Not saved. The settings were refused.",
			),
		);
		expect(input("settings-keepRunningMaxHours").value).toBe("24");
	});

	test("Discard changes puts the saved values back and leaves focus on Save", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "45" } });
		fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(input("settings-idleStopMinutes").value).toBe("60");
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Save stop times" }),
		);
		expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
		expect(writes).toEqual([]);
	});
});

describe("Resource guard", () => {
	test("the measuring period comes first, then the four named groups", async () => {
		stubSettings();
		await openSettings();
		const guard = screen.getByTestId("settings-guard");
		expect(
			within(guard)
				.getAllByRole("heading", { level: 4 })
				.map((heading) => heading.textContent),
		).toEqual([
			"Slow down heavy CPU use",
			"Give full speed back",
			"Keep repeat cases slowed",
			"Flag high memory",
		]);
		expect(
			within(guard)
				.getAllByRole("textbox")
				.map((box) => box.id),
		).toEqual([
			"settings-guardWindowMinutes",
			"settings-cpuGuardThresholdPercent",
			"settings-cpuThrottleSharePercent",
			"settings-cpuIdleLiftMinutes",
			"settings-cpuIdleLiftPercent",
			"settings-cpuThrottleHoldAfter",
			"settings-cpuThrottleHoldHours",
			"settings-memoryGuardThresholdPercent",
		]);
		for (const label of [
			"Measuring period",
			"Heavy CPU use",
			"Speed while slowed",
			"Quiet time",
			"Quiet means under",
			"Slowdowns before a hold",
			"Hold period",
			"High memory",
		]) {
			expect(within(guard).getByRole("textbox", { name: label })).toBeDefined();
		}
	});

	test("Save resource guard sends only what changed, and 0 where it turns a rule off", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-cpuGuardThresholdPercent"), {
			target: { value: "70" },
		});
		fireEvent.change(input("settings-cpuThrottleHoldAfter"), {
			target: { value: "0" },
		});
		expect(screen.getByText("Not saved. Was 80%.")).toBeDefined();
		expect(screen.getByText("Not saved. Was 3 slowdowns.")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Save resource guard" }));
		await waitFor(() =>
			expect(writes).toEqual([
				{ cpuGuardThresholdPercent: 70, cpuThrottleHoldAfter: 0 },
			]),
		);
	});

	test("each bad value is marked, and the footer names the first", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.change(input("settings-cpuIdleLiftMinutes"), { target: { value: "61" } });
		fireEvent.change(input("settings-cpuThrottleHoldHours"), {
			target: { value: "169" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save resource guard" }));
		await waitFor(() =>
			expect(screen.getByTestId("settings-guard-state").textContent).toBe(
				"Not saved. 2 unsaved changes; fix Quiet time and save again.",
			),
		);
		expect(screen.getByText("Enter a whole number from 1 to 60.")).toBeDefined();
		expect(screen.getByText("Enter a whole number from 1 to 168.")).toBeDefined();
		expect(writes).toEqual([]);
	});
});

describe("Save with nothing to save", () => {
	test("stays focusable, says there is nothing to save, and writes nothing", async () => {
		const writes = stubSettings();
		await openSettings();
		const save = screen.getByRole("button", { name: "Save student tools" });
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(describedBy(save)).toBe("No unsaved changes.");
		save.focus();
		expect(document.activeElement).toBe(save);
		fireEvent.click(save);
		expect(writes).toEqual([]);

		fireEvent.click(screen.getByRole("checkbox", { name: "Allow voice input" }));
		expect(save.getAttribute("aria-disabled")).toBeNull();
		expect(save.hasAttribute("aria-describedby")).toBe(false);
	});
});

describe("Student tools", () => {
	test("lists the shipped languages with their memory, and the rest as coming later", async () => {
		stubSettings();
		await openSettings();
		const list = screen.getByTestId("code-help-languages");
		const python = within(list).getByRole("checkbox", { name: "Python" });
		expect((python as HTMLInputElement).checked).toBe(true);
		expect(python.getAttribute("aria-disabled")).toBeNull();
		expect(
			document.getElementById(python.getAttribute("aria-describedby") ?? "")
				?.textContent,
		).toBe("pyright and ruff, in each workspace. About 185 MiB per student.");
		for (const name of ["HTML, CSS and JSON", "Java", "C and C++", "SQL"]) {
			const box = within(list).getByRole("checkbox", { name }) as HTMLInputElement;
			expect(box.getAttribute("aria-disabled")).toBe("true");
			expect(box.disabled).toBe(false);
			expect(
				document.getElementById(box.getAttribute("aria-describedby") ?? "")
					?.textContent,
			).toMatch(/Coming later: its language server is not installed yet/);
			// The click is cancelled, so Space never ticks the box even for a moment.
			expect(fireEvent.click(box)).toBe(false);
		}
		expect(screen.getByTestId("settings-tools-state").textContent).toBe(
			"No unsaved changes.",
		);
	});

	test("the estimate reads the server's memory and follows the ticks", async () => {
		stubSettings();
		await openSettings();
		const estimate = screen.getByTestId("code-help-estimate");
		await waitFor(() =>
			expect(within(estimate).getAllByText("about 32")).toHaveLength(1),
		);
		expect(within(estimate).getByText("about 23")).toBeDefined();
		const headline = screen.getByTestId("code-help-headline");
		expect(headline.tagName).toBe("OUTPUT");
		expect(headline.textContent).toBe(
			"Code help adds at most 242 MiB per student, if every student opens every ticked language.",
		);
		// Only the headline is a live region; the table is not.
		expect(estimate.querySelector("table")?.closest("output")).toBeNull();
		expect(estimate.textContent).toContain("This server has 16 GiB");

		fireEvent.click(screen.getByRole("checkbox", { name: "Python" }));
		expect(headline.textContent).toBe(
			"Code help adds at most 57 MiB per student, if every student opens every ticked language.",
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "TypeScript and JavaScript" }),
		);
		expect(headline.textContent).toBe(
			"Code help is off. The editor shows syntax colouring only.",
		);
		expect(within(estimate).getByText("about 80")).toBeDefined();
	});

	test("while the server's memory is still loading, it does not say the memory is unknown", async () => {
		let release = () => {};
		stubSettings({ healthGate: new Promise<void>((resolve) => (release = resolve)) });
		await openSettings();
		const estimate = screen.getByTestId("code-help-estimate");
		expect(within(estimate).getByText("402 MiB")).toBeDefined();
		expect(estimate.textContent).not.toMatch(/not known/);
		expect(estimate.textContent).not.toMatch(/about \d+$/m);
		release();
		await waitFor(() => expect(within(estimate).getByText("about 23")).toBeDefined());
		expect(estimate.textContent).not.toMatch(/not known/);
	});

	test("with the server's memory unknown, it gives memory per student only", async () => {
		stubSettings({ memory: null });
		await openSettings();
		const estimate = screen.getByTestId("code-help-estimate");
		await waitFor(() =>
			expect(within(estimate).getAllByText("Server memory not known yet")).toHaveLength(
				2,
			),
		);
		expect(within(estimate).getByText("402 MiB")).toBeDefined();
		expect(estimate.textContent).toContain("Server memory is not known yet");
	});

	test("unticking one language sends the set that is left, and nothing else", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.click(screen.getByRole("checkbox", { name: "Python" }));
		expect(screen.getByText("Not saved. Was on.")).toBeDefined();
		expect(writes).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Save student tools" }));
		await waitFor(() =>
			expect(writes).toEqual([{ codeHelpLanguages: ["typescript"] }]),
		);
	});

	test("a voice-only save leaves code help alone", async () => {
		const writes = stubSettings();
		await openSettings();
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow voice input" }));
		fireEvent.click(screen.getByRole("button", { name: "Save student tools" }));
		await waitFor(() => expect(writes).toEqual([{ voiceInputEnabled: false }]));
	});
});

describe("Acceptable use", () => {
	test("starts on the built-in text, refuses a blank one, and saves the new text", async () => {
		const writes = stubSettings();
		await openSettings();
		const text = screen.getByLabelText("Statement") as HTMLTextAreaElement;
		expect(text.value).toContain("Your Portikus workspace is for coursework");
		expect(screen.getByText(/Version 1, the built-in text\./)).toBeDefined();
		const save = screen.getByRole("button", {
			name: "Save and ask everyone to accept",
		});
		// With nothing changed, the note comes after the line saying so.
		expect(describedBy(save)).toBe(
			"No unsaved changes. Saving a changed statement asks everyone to accept it again at their next page load.",
		);

		fireEvent.change(text, { target: { value: "   " } });
		fireEvent.click(save);
		expect(
			await screen.findByText("Enter the statement, or restore the built-in text."),
		).toBeDefined();
		expect(writes).toEqual([]);

		fireEvent.change(text, { target: { value: "x".repeat(10_001) } });
		expect(screen.getByText(/10,001 of 10,000 characters\./)).toBeDefined();
		fireEvent.click(save);
		expect(
			await screen.findByText("The statement can be at most 10,000 characters."),
		).toBeDefined();
		expect(writes).toEqual([]);

		fireEvent.change(text, { target: { value: "Be kind." } });
		fireEvent.click(save);
		await waitFor(() => expect(writes).toEqual([{ acceptableUseText: "Be kind." }]));
	});

	test("Restore built-in text asks first, then saves at once", async () => {
		const writes = stubSettings({
			settings: { ...SETTINGS, acceptableUseText: "Be kind." },
		});
		await openSettings();
		fireEvent.click(screen.getByRole("button", { name: "Restore built-in text…" }));
		const dialog = await screen.findByRole("alertdialog", {
			name: "Restore the built-in text?",
		});
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Keep this statement" }),
		);
		expect(writes).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Restore built-in text…" }));
		const again = await screen.findByRole("alertdialog");
		fireEvent.click(
			within(again).getByRole("button", { name: "Restore built-in text" }),
		);
		await waitFor(() => expect(writes).toEqual([{ acceptableUseText: null }]));
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Statement") as HTMLTextAreaElement).value,
			).toContain("Your Portikus workspace is for coursework"),
		);
	});
});

describe("leaving with unsaved changes", () => {
	test("another tab asks first, naming each section and count, never a value", async () => {
		stubSettings();
		const { router } = renderApp("/admin/settings");
		await waitFor(() => expect(input("settings-idleStopMinutes").value).toBe("60"));
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "45" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow voice input" }));

		await act(async () => {
			void router.navigate({ to: "/admin/$tab", params: { tab: "health" } });
		});
		const dialog = await screen.findByRole("alertdialog", {
			name: "Leave without saving?",
		});
		expect(dialog.textContent).toContain(
			"When workspaces stop has 1 unsaved change. Student tools has 1 unsaved change. They are lost if you leave.",
		);
		expect(dialog.textContent).not.toContain("45");

		fireEvent.click(within(dialog).getByRole("button", { name: "Stay on Settings" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(router.state.location.pathname).toBe("/admin/settings");
		expect(input("settings-idleStopMinutes").value).toBe("45");

		await act(async () => {
			void router.navigate({ to: "/admin/$tab", params: { tab: "health" } });
		});
		fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Leave without saving",
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/admin/health"));
	});

	test("with nothing unsaved, or only a jump within the page, nothing asks", async () => {
		stubSettings();
		const { router } = renderApp("/admin/settings");
		await waitFor(() => expect(input("settings-idleStopMinutes").value).toBe("60"));
		fireEvent.change(input("settings-idleStopMinutes"), { target: { value: "45" } });
		await act(async () => {
			void router.navigate({
				to: "/admin/$tab",
				params: { tab: "settings" },
				hash: "settings-aup",
			});
		});
		expect(screen.queryByRole("alertdialog")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
		await act(async () => {
			void router.navigate({ to: "/admin/$tab", params: { tab: "health" } });
		});
		await waitFor(() => expect(router.state.location.pathname).toBe("/admin/health"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
