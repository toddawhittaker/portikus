import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toast, ToastProvider, useToast } from "./toast";
import "./test-setup";

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
});
