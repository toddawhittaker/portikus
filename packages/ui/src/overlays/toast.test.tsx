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

	it("keeps a persistent toast until its caller dismisses it", () => {
		function Progress() {
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
		vi.useFakeTimers();
		try {
			render(
				<ToastProvider>
					<Progress />
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
		function Progress() {
			const { show } = useToast();
			return (
				<button
					type="button"
					onClick={() => {
						dismiss = show({ title: "Extracting", persistent: true });
					}}
				>
					Show
				</button>
			);
		}
		render(
			<ToastProvider>
				<Progress />
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
		function Progress() {
			const { show } = useToast();
			return (
				<button
					type="button"
					onClick={() => {
						dismiss = show({ title: "Extracting", persistent: true });
					}}
				>
					Show
				</button>
			);
		}
		render(
			<ToastProvider>
				<Progress />
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

	it("nodeText reads strings, numbers, arrays and element children", () => {
		expect(nodeText(undefined)).toBe("");
		expect(nodeText(["a", 1, <b key="b">c</b>, null])).toBe("a1c");
	});
});
