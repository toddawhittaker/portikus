import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

/** A stand-in for one Monaco model and editor, enough to see what the view asks of them. */
const made: { options: Record<string, unknown>; value: string; restored: number }[] =
	[];

vi.mock("../../editor/monaco.js", () => ({
	accessibilitySupport: () => "auto",
	baseEditorOptions: {},
	currentThemeName: () => "light",
	editorAriaLabel: (kind: string, path: string) => `${kind}, ${path}`,
	languageForFile: () => "plaintext",
	watchTheme: () => {},
	getMonaco: async () => ({
		editor: {
			createModel: (value: string) => {
				const model = {
					value,
					getValue: () => model.value,
					setValue: (next: string) => {
						model.value = next;
					},
					dispose: () => {},
				};
				return model;
			},
			create: (_host: unknown, options: Record<string, unknown>) => {
				const model = options.model as { value: string };
				const record = {
					options,
					get value() {
						return model.value;
					},
					restored: 0,
				};
				made.push(record);
				return {
					getModel: () => options.model,
					saveViewState: () => ({}),
					restoreViewState: () => {
						record.restored += 1;
					},
					updateOptions: () => {},
					dispose: () => {},
				};
			},
		},
	}),
}));
vi.mock("../../editor/settingsQueries.js", () => ({
	useScreenReaderMode: () => false,
}));

const { ReadOnlyText } = await import("./ReadOnlyText.js");

afterEach(() => {
	cleanup();
	made.length = 0;
});

test("the editor cannot be typed in, and is named as read-only", async () => {
	render(<ReadOnlyText path="src/app.js" text={"let a = 1;\n"} />);
	await waitFor(() => expect(made).toHaveLength(1));
	expect(made[0]?.options.readOnly).toBe(true);
	expect(made[0]?.options.domReadOnly).toBe(true);
	expect(made[0]?.options.ariaLabel).toBe("Read-only file, src/app.js");
	expect(made[0]?.value).toBe("let a = 1;\n");
});

test("new text from a poll replaces the old and keeps the reader's place", async () => {
	const { rerender } = render(<ReadOnlyText path="a.txt" text="one" />);
	await waitFor(() => expect(made).toHaveLength(1));
	rerender(<ReadOnlyText path="a.txt" text="two" />);
	await waitFor(() => expect(made[0]?.value).toBe("two"));
	expect(made[0]?.restored).toBe(1);
	// The same text again changes nothing.
	rerender(<ReadOnlyText path="a.txt" text="two" />);
	expect(made[0]?.restored).toBe(1);
});
