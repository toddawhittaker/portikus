import { act, render, screen, waitFor } from "@testing-library/react";
import { hideOthers } from "aria-hidden";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import { ConfirmDialog, ConfirmDialogRoot } from "./confirm-dialog";
import { Dialog, DialogRoot } from "./dialog";

vi.mock("aria-hidden", async (importOriginal) => {
	const real = await importOriginal<typeof import("aria-hidden")>();
	return { ...real, hideOthers: vi.fn(real.hideOthers) };
});

function hidden(element: Element): boolean {
	return element.closest('[aria-hidden="true"]') !== null;
}

function Page({
	late,
	open,
	layer,
	news,
}: {
	late: boolean;
	open: boolean;
	layer?: boolean;
	news?: boolean;
}) {
	return (
		<>
			<main>
				<span aria-live="polite" data-testid="live">
					{news ? <strong data-testid="news">Saved</strong> : null}
				</span>
				{late ? (
					<button type="button" data-testid="late">
						Mounted late
					</button>
				) : null}
			</main>
			<DialogRoot open={open}>
				<Dialog title="Settings">
					<button type="button">Inside</button>
				</Dialog>
			</DialogRoot>
			{layer
				? createPortal(
						<div data-testid="layer">A popover over the dialog</div>,
						document.body,
					)
				: null}
		</>
	);
}

it("hides content that mounts beside a live region after a modal opens, and keeps later layers", async () => {
	const view = render(<Page late={false} open />);
	await screen.findByRole("dialog");
	expect(hidden(screen.getByTestId("live"))).toBe(false);

	view.rerender(<Page late open layer />);
	await waitFor(() => expect(hidden(screen.getByTestId("late"))).toBe(true));
	expect(hidden(screen.getByTestId("live"))).toBe(false);
	expect(hidden(screen.getByTestId("layer"))).toBe(false);
	expect(hidden(screen.getByRole("dialog"))).toBe(false);

	// Closed, the page is whole again.
	view.rerender(<Page late open={false} />);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(hidden(screen.getByTestId("late"))).toBe(false);
});

it("does the same under a confirm dialog", async () => {
	function Confirm({ late }: { late: boolean }) {
		return (
			<>
				<main>
					<span aria-live="polite" />
					{late ? (
						<button type="button" data-testid="late">
							Mounted late
						</button>
					) : null}
				</main>
				<ConfirmDialogRoot open>
					<ConfirmDialog
						title="Delete it?"
						confirmLabel="Delete"
						onConfirm={() => {}}
					/>
				</ConfirmDialogRoot>
			</>
		);
	}
	const view = render(<Confirm late={false} />);
	await screen.findByRole("alertdialog");
	await act(async () => view.rerender(<Confirm late />));
	await waitFor(() => expect(hidden(screen.getByTestId("late"))).toBe(true));
});

it("leaves the page alone when an element is added inside a kept live region", async () => {
	const view = render(<Page late={false} open />);
	await screen.findByRole("dialog");
	await new Promise((resolve) => requestAnimationFrame(resolve));
	const calls = vi.mocked(hideOthers).mock.calls.length;

	view.rerender(<Page late={false} open news />);
	await new Promise((resolve) => requestAnimationFrame(resolve));
	await new Promise((resolve) => requestAnimationFrame(resolve));
	expect(hidden(screen.getByTestId("news"))).toBe(false);
	expect(vi.mocked(hideOthers).mock.calls.length).toBe(calls);
});
