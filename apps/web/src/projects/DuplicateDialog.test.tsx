import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { DuplicateDialog } from "./DuplicateDialog.js";

afterEach(() => vi.unstubAllGlobals());

test("a second submit while the first is still running sends no second request", async () => {
	const source = project({ slug: "todo", name: "todo" });
	const copy = project({ slug: "todo-copy", name: "todo copy" });
	let posts = 0;
	let answer: (response: Response) => void = () => {};
	stubFetch((_url, init) => {
		if (init?.method !== "POST") return json(200, { projects: [] });
		posts += 1;
		return new Promise<Response>((resolve) => {
			answer = resolve;
		});
	});
	const onDuplicated = vi.fn();
	renderWithQuery(
		<DuplicateDialog
			workspaceId={WORKSPACE.id}
			project={source}
			onClose={vi.fn()}
			onDuplicated={onDuplicated}
		/>,
	);

	const form = screen.getByTestId("field-name").closest("form") as HTMLFormElement;
	// Two Enter presses can land before React renders the pending state.
	act(() => {
		fireEvent.submit(form);
		fireEvent.submit(form);
	});
	await waitFor(() => expect(posts).toBe(1));
	fireEvent.submit(form);
	expect(posts).toBe(1);

	answer(json(201, copy));
	await waitFor(() => expect(onDuplicated).toHaveBeenCalledTimes(1));
	expect(posts).toBe(1);
});
