import { ToastProvider } from "@portikus/ui";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { type UseXtermOptions, useXterm } from "./useXterm";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** jsdom has neither of these, and xterm.js needs both. */
function stubBrowserApis() {
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
}

type Options = Omit<UseXtermOptions, "host">;

function Host(options: Options) {
	const host = useRef<HTMLDivElement | null>(null);
	useXterm({ host, ...options });
	return <div data-testid="host" ref={host} />;
}

function renderHost(overrides: Partial<Options> = {}) {
	stubBrowserApis();
	const dispose = vi.fn();
	const options: Options = {
		name: "root",
		theme: "dark",
		screenReaderMode: false,
		visible: true,
		focusOnMount: false,
		describedBy: "hint",
		onFocus: vi.fn(),
		onLeave: vi.fn(),
		openUrl: vi.fn(),
		attach: vi.fn(() => ({ resized: vi.fn(), dispose })),
		...overrides,
	};
	const view = render(
		<ToastProvider>
			<Host {...options} />
		</ToastProvider>,
	);
	return { view, options, dispose };
}

function firePaste(view: ReturnType<typeof render>, items: unknown[], text: string) {
	const target = view.container.querySelector("textarea");
	if (!target) throw new Error("no xterm textarea");
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: { items, getData: () => text },
	});
	act(() => {
		target.dispatchEvent(event);
	});
}

test("the terminal is attached once when it opens and let go when it unmounts", () => {
	const { view, options, dispose } = renderHost();
	expect(options.attach).toHaveBeenCalledTimes(1);
	const textarea = view.container.querySelector("textarea");
	expect(textarea?.getAttribute("aria-describedby")).toBe("hint");
	view.rerender(
		<ToastProvider>
			<Host {...options} theme="light" />
		</ToastProvider>,
	);
	// A new theme is set on the live terminal, not by building another.
	expect(options.attach).toHaveBeenCalledTimes(1);
	view.unmount();
	expect(dispose).toHaveBeenCalledTimes(1);
});

test("a click in the terminal reports focus", () => {
	const { view, options } = renderHost();
	const surface = view.getByTestId("host");
	act(() => {
		surface.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
	expect(options.onFocus).toHaveBeenCalled();
});

test("a pasted picture goes to pasteImage and never reaches the terminal as text", () => {
	const pasteImage = vi.fn();
	const { view } = renderHost({ pasteImage });
	const image = new Blob(["png"], { type: "image/png" });
	firePaste(view, [{ type: "image/png", getAsFile: () => image }], "");
	expect(pasteImage).toHaveBeenCalledWith(image, "image/png");
});

test("without pasteImage a pasted picture is ignored", () => {
	const { view } = renderHost();
	expect(() =>
		firePaste(view, [{ type: "image/png", getAsFile: () => new Blob(["png"]) }], ""),
	).not.toThrow();
});
