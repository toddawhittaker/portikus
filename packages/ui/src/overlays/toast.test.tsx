import { act, fireEvent, render, screen } from "@testing-library/react";
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

	it("sits above dialogs and names F8 as the way to reach it (#364)", () => {
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
