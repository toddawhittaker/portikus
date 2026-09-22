/** Issue #357: the check output follows the student's screen-reader setting. */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { editorSettingsKey } from "../editor/settingsQueries.js";
import { CheckOutput } from "./CheckOutput.js";

const opened = vi.hoisted(() => ({
	terminals: [] as import("@xterm/xterm").Terminal[],
}));

vi.mock("@xterm/xterm", async () => {
	const actual = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
	class RecordingTerminal extends actual.Terminal {
		constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
			super(options);
			opened.terminals.push(this);
		}
	}
	return { ...actual, Terminal: RecordingTerminal };
});

afterEach(() => {
	cleanup();
	opened.terminals.length = 0;
	vi.unstubAllGlobals();
});

function renderOutput(screenReaderMode: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"WebSocket",
		class {
			close() {}
		},
	);
	const client = createQueryClient(() => {});
	const settings = { ...EDITOR_SETTINGS_DEFAULTS, screenReaderMode, timezones: [] };
	client.setQueryData(editorSettingsKey, settings);
	render(
		<QueryClientProvider client={client}>
			<CheckOutput workspaceId="w" projectId="p" checkId="c" onFinished={vi.fn()} />
		</QueryClientProvider>,
	);
	return { client, settings };
}

test("the check output starts without screen-reader mode when the setting is off", async () => {
	renderOutput(false);
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.screenReaderMode).toBe(false);
});

test("the check output enforces the same 4.5:1 contrast as the terminals", async () => {
	renderOutput(false);
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.minimumContrastRatio).toBe(4.5);
});

test("the check output uses screen-reader mode and follows a change live", async () => {
	const { client, settings } = renderOutput(true);
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.screenReaderMode).toBe(true);

	act(() => {
		client.setQueryData(editorSettingsKey, { ...settings, screenReaderMode: false });
	});
	await waitFor(() =>
		expect(opened.terminals[0]?.options.screenReaderMode).toBe(false),
	);
	expect(opened.terminals).toHaveLength(1);
});
