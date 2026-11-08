import { act, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import {
	nodeText,
	TOAST_DURATION_MS,
	Toast,
	type ToastProps,
	ToastProvider,
	useToast,
} from "./toast";

function Fixture() {
	const { show } = useToast();
	return (
		<button
			type="button"
			onClick={() =>
				show({
					tone: "success",
					title: "Project created",
					children: "todo-api is ready.",
				})
			}
		>
			Create
		</button>
	);
}

function PersistentProgress() {
	const { show } = useToast();
	const dismiss = React.useRef<(() => void) | null>(null);
	return (
		<>
			<button
				type="button"
				onClick={() => {
					dismiss.current = show({ title: "Extracting", persistent: true });
				}}
			>
				Show
			</button>
			<button type="button" onClick={() => dismiss.current?.()}>
				Done
			</button>
		</>
	);
}

function Progress({ onShown }: { onShown: (dismiss: () => void) => void }) {
	const { show } = useToast();
	return (
		<button
			type="button"
			onClick={() => onShown(show({ title: "Extracting", persistent: true }))}
		>
			Show
		</button>
	);
}

describe("Toast", () => {
	it("keeps ref out of the props callers pass to show", () => {
		const props: ToastProps = {
			title: "Saved",
			// @ts-expect-error the provider owns each toast's ref
			ref: null,
		};
		expect(props.title).toBe("Saved");
	});

	it("shows a toast from useToast and dismisses it", () => {
		render(
			<ToastProvider>
				<Fixture />
			</ToastProvider>,
		);

		fireEvent.click(screen.getByText("Create"));
		expect(screen.getByText("Project created")).toBeTruthy();
		expect(screen.getByText("todo-api is ready.")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Project created")).toBeNull();
	});

	it("dismisses a success toast after five seconds", () => {
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<Fixture />
				</ToastProvider>,
			);
			fireEvent.click(screen.getByText("Create"));
			expect(screen.getByText("Project created")).toBeTruthy();

			act(() => {
				vi.advanceTimersByTime(6000);
			});
			expect(screen.queryByText("Project created")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a danger toast as an alert and calls onDismiss", () => {
		const onDismiss = vi.fn();
		render(
			<ToastProvider>
				<Toast
					tone="danger"
					title="Your workspace could not start"
					onDismiss={onDismiss}
				>
					Its storage allocation is full.
				</Toast>
			</ToastProvider>,
		);

		expect(screen.getByRole("alert").textContent).toContain("could not start");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("keeps the viewport a list of list items, with the live role inside each", () => {
		render(
			<ToastProvider>
				<Fixture />
			</ToastProvider>,
		);
		fireEvent.click(screen.getByText("Create"));

		const list = screen.getByRole("region").querySelector("ol");
		const items = Array.from(list?.children ?? []);
		expect(items.length).toBe(1);
		expect(
			items.every((item) => item.tagName === "LI" && !item.hasAttribute("role")),
		).toBe(true);
		expect(items[0]?.querySelector('[role="status"]')?.textContent).toContain(
			"Project created",
		);
	});

	it("sits above dialogs and names F8 as the way to reach it", () => {
		render(<ToastProvider />);

		const viewport = screen.getByRole("region");
		expect(viewport.getAttribute("aria-label")).toContain("F8");
		expect(viewport.querySelector("ol")?.className ?? "").toContain(
			"z-[var(--z-toast)]",
		);
	});
});

function Shower({ toast }: { toast: ToastProps }) {
	const { show } = useToast();
	return (
		<button type="button" onClick={() => show(toast)}>
			Show
		</button>
	);
}

// SPEC.md section 8.5: every toast times out, warnings and errors later.
describe("toast timing and recording", () => {
	it.each([
		["neutral", 5000],
		["success", 5000],
		["warning", 10_000],
		["danger", 10_000],
	] as const)("a %s toast goes after %i ms", (tone, ms) => {
		expect(TOAST_DURATION_MS[tone]).toBe(ms);
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<Shower toast={{ tone, title: "Timed" }} />
				</ToastProvider>,
			);
			fireEvent.click(screen.getByText("Show"));
			act(() => {
				vi.advanceTimersByTime(ms - 500);
			});
			expect(screen.queryByText("Timed")).not.toBeNull();
			act(() => {
				vi.advanceTimersByTime(1000);
			});
			expect(screen.queryByText("Timed")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a toast that asks for an answer until it is answered", () => {
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<Shower
						toast={{
							tone: "warning",
							title: "Changed on disk",
							actions: <button type="button">Reload</button>,
						}}
					/>
				</ToastProvider>,
			);
			fireEvent.click(screen.getByText("Show"));
			act(() => {
				vi.advanceTimersByTime(60 * 60 * 1000);
			});
			expect(screen.queryByText("Changed on disk")).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("times out a toast with actions when persistent is explicitly false", () => {
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<Shower
						toast={{
							title: "Agent finished",
							persistent: false,
							actions: <button type="button">Open</button>,
						}}
					/>
				</ToastProvider>,
			);
			fireEvent.click(screen.getByText("Show"));
			act(() => {
				vi.advanceTimersByTime(TOAST_DURATION_MS.neutral + 1000);
			});
			expect(screen.queryByText("Agent finished")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a persistent toast until its caller dismisses it", () => {
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<PersistentProgress />
				</ToastProvider>,
			);
			fireEvent.click(screen.getByText("Show"));
			act(() => {
				vi.advanceTimersByTime(10 * 60 * 1000);
			});
			expect(screen.queryByText("Extracting")).not.toBeNull();
			fireEvent.click(screen.getByText("Done"));
			expect(screen.queryByText("Extracting")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("moves focus to the viewport when its caller dismisses a focused toast", () => {
		let dismiss: () => void = () => {};
		render(
			<ToastProvider>
				<Progress onShown={(d) => (dismiss = d)} />
			</ToastProvider>,
		);
		fireEvent.click(screen.getByText("Show"));
		screen.getByRole("button", { name: "Dismiss" }).focus();
		act(() => dismiss());
		expect(screen.queryByText("Extracting")).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("region").querySelector("ol"));
	});

	it("leaves focus alone when a dismissed toast did not hold it", () => {
		let dismiss: () => void = () => {};
		render(
			<ToastProvider>
				<Progress onShown={(d) => (dismiss = d)} />
			</ToastProvider>,
		);
		const button = screen.getByText("Show");
		fireEvent.click(button);
		button.focus();
		act(() => dismiss());
		expect(document.activeElement).toBe(button);
	});

	it("records every toast once, as text, including one that asks for an answer", () => {
		const onShow = vi.fn();
		render(
			<ToastProvider onShow={onShow}>
				<Shower
					toast={{
						tone: "danger",
						title: "Upload failed",
						children: (
							<>
								<code>notes.txt</code> already exists.
							</>
						),
						actions: <button type="button">Replace</button>,
					}}
				/>
			</ToastProvider>,
		);
		fireEvent.click(screen.getByText("Show"));
		expect(onShow).toHaveBeenCalledTimes(1);
		expect(onShow).toHaveBeenCalledWith({
			tone: "danger",
			title: "Upload failed",
			body: "notes.txt already exists.",
		});
	});

	it("does not record a toast marked unrecorded", () => {
		const onShow = vi.fn();
		render(
			<ToastProvider onShow={onShow}>
				<Shower toast={{ title: "Recorded elsewhere", unrecorded: true }} />
			</ToastProvider>,
		);
		fireEvent.click(screen.getByText("Show"));
		expect(screen.getByText("Recorded elsewhere")).toBeTruthy();
		expect(onShow).not.toHaveBeenCalled();
	});

	it("nodeText reads strings, numbers, arrays and element children", () => {
		expect(nodeText(undefined)).toBe("");
		expect(nodeText(["a", 1, <b key="b">c</b>, null])).toBe("a1c");
	});
});

// Design system, Focus and keyboard: a toast never covers a focused element (WCAG 2.2 SC 2.4.11).
describe("toasts and focus", () => {
	/** Lay out the page by hand, as jsdom has none. The stack sits at the bottom right. */
	function layOut(rects: Record<string, Partial<DOMRect>>) {
		return vi
			.spyOn(Element.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: Element) {
				const key = this.classList.contains("pk-toast-viewport")
					? "stack"
					: (this.getAttribute("data-box") ?? "");
				const { top = 0, left = 0, width = 0, height = 0 } = rects[key] ?? {};
				return {
					top,
					left,
					width,
					height,
					bottom: top + height,
					right: left + width,
					x: left,
					y: top,
					toJSON: () => ({}),
				} as DOMRect;
			});
	}

	function drawPage() {
		render(
			<ToastProvider>
				<Shower toast={{ title: "Claude Code needs your input", persistent: true }} />
				<button type="button" data-box="under">
					Send
				</button>
				<button type="button" data-box="clear">
					Elsewhere
				</button>
			</ToastProvider>,
		);
		return document.querySelector<HTMLElement>(".pk-toast-viewport");
	}

	it("steps above a focused control it would cover, and back when focus moves on", () => {
		const rects = layOut({
			stack: { top: 680, left: 628, width: 380, height: 72 },
			under: { top: 700, left: 960, width: 36, height: 36 },
			clear: { top: 100, left: 960, width: 36, height: 36 },
		});
		try {
			const stack = drawPage();
			fireEvent.click(screen.getByText("Show"));
			act(() => screen.getByRole("button", { name: "Send" }).focus());
			// Its bottom edge sits a small gap above the control: 768 - 700 + 8.
			expect(stack?.style.bottom).toBe("76px");
			act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
			expect(stack?.style.bottom).toBe("");
		} finally {
			rects.mockRestore();
		}
	});

	it("stays put while focus is on a toast or on a control it does not cover", () => {
		const rects = layOut({
			stack: { top: 680, left: 628, width: 380, height: 72 },
			under: { top: 700, left: 100, width: 36, height: 36 },
		});
		try {
			const stack = drawPage();
			fireEvent.click(screen.getByText("Show"));
			act(() => screen.getByRole("button", { name: "Send" }).focus());
			expect(stack?.style.bottom).toBe("");
			act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
			expect(stack?.style.bottom).toBe("");
		} finally {
			rects.mockRestore();
		}
	});
});
