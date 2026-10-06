import type { RootShellStatus } from "@portikus/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RootShellAreaProps } from "./RootShellArea.js";
import { RootShellTab } from "./RootShellTab.js";

// The area is covered by RootShellArea.test.tsx; this stand-in loses shells on request.
vi.mock("./RootShellArea.js", () => ({
	RootShellArea: ({ visible, onLoss }: RootShellAreaProps) => (
		<section hidden={!visible} data-testid="area">
			<button type="button" onClick={() => onLoss("server_stopped")}>
				Lose a shell
			</button>
		</section>
	),
}));

afterEach(cleanup);

const ON = {
	data: { enabled: true },
	isPending: false,
	isError: false,
} as UseQueryResult<RootShellStatus>;

test("shells lost while another admin tab shows are still announced, once", async () => {
	const view = render(<RootShellTab shown={true} status={ON} />);
	const lose = await screen.findByRole("button", { name: "Lose a shell" });
	view.rerender(<RootShellTab shown={false} status={ON} />);
	expect(screen.getByTestId("area").hidden).toBe(true);

	fireEvent.click(lose);
	fireEvent.click(lose);
	const status = screen.getByTestId("root-shell-announce");
	expect(status.getAttribute("role")).toBe("status");
	// Not inside the hidden area, where a screen reader would never hear it.
	expect(status.closest("[hidden]")).toBeNull();
	await waitFor(() =>
		expect(status.textContent).toBe("Portikus restarted, so 2 root shells ended."),
	);
});
